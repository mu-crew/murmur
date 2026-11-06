import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { asPaneId } from "../src/ids.js";
import { drainInbox, inboxDir, inboxKey, tmuxInboxHost, writeInboxEvent } from "../src/inbox.js";
import type { InboxEvent } from "../src/inbox-event.js";
import { loadSocketCache } from "../src/socket-cache.js";
import { openStore } from "../src/store.js";
import { builtArtifact } from "./helpers/built.js";

/**
 * The inbox against a REAL tmux server and real process chains.
 *
 * A private server on its own `-S` socket in a temp dir, so nothing touches the
 * developer's sessions, and the drain's socket scan (the path a hook with no
 * `$TMUX` takes) looks only there. Fake harnesses are the node binary under
 * a harness's name, which is all argv matching sees.
 */

const work = mkdtempSync(join(tmpdir(), "murmur-inbox-tmux-"));
const SOCKET = join(work, "s");
const TMUX = ["-S", SOCKET, "-f", "/dev/null"];
const SDK = builtArtifact("index.js");
const CLI = builtArtifact("cli.js");

function rig(...args: string[]): string {
  return execFileSync("tmux", [...TMUX, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function paneOption(pane: string, option: string): string {
  return rig("show-options", "-p", "-t", pane, "-qv", option);
}

async function until(check: () => boolean, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

let serverPid = 0;

beforeAll(() => {
  process.env.MURMUR_STATE_DIR = join(work, "state");
  rig("new-session", "-d", "-s", "inbox", "sleep 600");
  serverPid = Number(rig("display-message", "-p", "#{pid}"));

  // `claude` and `pi` are the node binary under those names. A launcher script
  // runs the harness "binary" (node again, same name), which runs the hook,
  // which places and writes an event exactly as `murmur hook` will.
  for (const name of ["claude", "pi"]) symlinkSync(process.execPath, join(work, name));
  writeFileSync(
    join(work, "launcher.mjs"),
    `import { spawnSync } from "node:child_process";
     const [binary, ...rest] = process.argv.slice(2);
     spawnSync(binary, rest, { stdio: "inherit" });`,
  );
  writeFileSync(
    join(work, "harness.mjs"),
    `import { spawnSync } from "node:child_process";
     spawnSync(process.argv[2], process.argv.slice(3), { stdio: "inherit" });
     setTimeout(() => {}, 600000);`,
  );
  writeFileSync(
    join(work, "hook.mjs"),
    `import { writeFileSync } from "node:fs";
     const { placeEvent, readProcessTable, writeInboxEvent } = await import(${JSON.stringify(SDK)});
     const placement = placeEvent(readProcessTable(), process.pid, {});
     writeFileSync(process.argv[2], JSON.stringify(placement));
     if (placement.kind === "local") {
       writeInboxEvent({
         v: 1, event: "prompt_submitted", harness: placement.harness, at: Date.now(),
         server_pid: placement.server_pid, root_pid: placement.root_pid,
         owner_pid: placement.owner_pid, tmux: null, tmux_pane: null, session_id: "s1",
         source: null, reason: null, message: null, text: null, generation_id: null,
         by: "harness",
         agent: { agent_name: null, workstream: null, role: null, cli: null, driver: "human" },
       });
     }`,
  );
});

afterAll(() => {
  try {
    rig("kill-server");
  } catch {
    // Already gone.
  }
  rmSync(work, { recursive: true, force: true });
});

function event(over: Partial<InboxEvent>): InboxEvent {
  return {
    v: 1,
    event: "prompt_submitted",
    harness: "claude",
    at: Date.now(),
    server_pid: serverPid,
    root_pid: 1,
    owner_pid: 1,
    tmux: null,
    tmux_pane: null,
    session_id: "s1",
    source: null,
    reason: null,
    message: null,
    text: null,
    generation_id: null,
    by: "harness",
    agent: { agent_name: null, workstream: null, role: null, cli: null, driver: "human" },
    ...over,
  };
}

test("a launcher-plus-binary chain counts as one harness, and the drain sets @murmur_pane_state", async () => {
  const out = join(work, "placement-claude.json");
  // pane root (sh) -> claude launcher.mjs -> claude harness.mjs -> node hook.mjs
  const env = `MURMUR_STATE_DIR=${process.env.MURMUR_STATE_DIR}`;
  const pane = rig(
    "new-window",
    "-d",
    "-P",
    "-F",
    "#{pane_id}",
    `${env} ${join(work, "claude")} ${join(work, "launcher.mjs")} ${join(work, "claude")} ${join(work, "harness.mjs")} ${process.execPath} ${join(work, "hook.mjs")} ${out}; sleep 600`,
  );
  expect(await until(() => existsSync(out))).toBe(true);
  const placement = JSON.parse(readFileSync(out, "utf8"));
  expect(placement).toMatchObject({ kind: "local", harness: "claude", server_pid: serverPid });
  // Read from the server's own argv (`tmux -S <socket> ... new-session`).
  expect(placement.server_socket).toEqual({ kind: "path", value: SOCKET });
  expect(Number(rig("display-message", "-t", pane, "-p", "#{pane_pid}"))).toBe(placement.root_pid);

  const store = openStore();
  try {
    // No `$TMUX` in the event: the host finds the server by asking each socket.
    const summary = drainInbox(store, { host: tmuxInboxHost({ socketDirectory: work }) });
    expect(summary).toMatchObject({ applied: 1, malformed: 0 });
    expect(paneOption(pane, "@murmur_pane_state")).toBe("working");
    expect(paneOption(pane, "@murmur_pane_label")).toBe("claude");
  } finally {
    store.close();
  }
});

test("an event from a harness nested under pi is never written", async () => {
  const out = join(work, "placement-nested.json");
  // pane root -> pi launcher.mjs -> sh -c "claude harness.mjs node hook.mjs"
  const inner = `${join(work, "claude")} ${join(work, "harness.mjs")} ${process.execPath} ${join(work, "hook.mjs")} ${out}`;
  writeFileSync(join(work, "inner.sh"), `${inner}\n`);
  const pane = rig(
    "new-window",
    "-d",
    "-P",
    "-F",
    "#{pane_id}",
    `MURMUR_STATE_DIR=${process.env.MURMUR_STATE_DIR} ${join(work, "pi")} ${join(work, "launcher.mjs")} /bin/sh ${join(work, "inner.sh")}; sleep 600`,
  );
  expect(await until(() => existsSync(out))).toBe(true);
  expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({ kind: "drop", reason: "nested" });
  const store = openStore();
  try {
    drainInbox(store, { host: tmuxInboxHost({ socketDirectory: work }) });
    expect(store.localPanes().some((entry) => entry.pane === pane)).toBe(false);
    expect(paneOption(pane, "@murmur_pane_state")).toBe("");
  } finally {
    store.close();
  }
});

test("murmur pane --json drains first and reports the harness fields", () => {
  const pane = rig("new-window", "-d", "-P", "-F", "#{pane_id}", "sleep 600");
  const root = Number(rig("display-message", "-t", pane, "-p", "#{pane_pid}"));
  const tmuxEnv = `${SOCKET},${serverPid},0`;
  for (const over of [
    { event: "prompt_submitted" },
    { event: "turn_stopped", text: "all done" },
  ] as const) {
    expect(
      writeInboxEvent(event({ ...over, root_pid: root, owner_pid: root, tmux: tmuxEnv })),
    ).toBe(true);
  }
  const report = JSON.parse(
    execFileSync(process.execPath, [CLI, "pane", pane, "--json", "-S", SOCKET], {
      encoding: "utf8",
      env: process.env,
    }),
  );
  expect(report).toMatchObject({
    pane,
    state: "done",
    agent: {
      source: "inbox",
      harness: "claude",
      session_id: "s1",
      run_count: 1,
      last_text: "all done",
    },
  });
  expect(paneOption(pane, "@murmur_pane_state")).toBe("done");
  expect(asPaneId(pane)).toBe(pane);
});

test("a dead server's inbox is deleted by the real host", () => {
  const store = openStore();
  try {
    const dead = Number(
      execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
        encoding: "utf8",
      }),
    );
    expect(writeInboxEvent(event({ server_pid: dead, root_pid: 5, owner_pid: 5 }))).toBe(true);
    expect(drainInbox(store, { host: tmuxInboxHost({ socketDirectory: work }) })).toMatchObject({
      removed: 1,
    });
  } finally {
    store.close();
  }
});

test("murmur hook claude and murmur hook mu, from real process chains, drive one pane", async () => {
  // Recorded claude payloads, fed on stdin to the built CLI by a fake claude
  // (launcher plus binary, as recorded), then mu's `continued` from inside the
  // same chain, as `mu hook stop` sends it from claude's Stop hook.
  const recorded = readFileSync(join(import.meta.dirname, "fixtures", "u0-claude.jsonl"), "utf8")
    .trim()
    .split("\n")
    .slice(0, 3)
    .map((line) => JSON.parse(line).payload);
  const steps = [
    ...recorded.map((payload) => ({ payload, args: [CLI, "hook", "claude"] })),
    { payload: { event: "continued" }, args: [CLI, "hook", "mu"] },
  ];
  const script = join(work, "steps.json");
  const done = join(work, "steps.done");
  writeFileSync(script, JSON.stringify(steps));
  writeFileSync(
    join(work, "feed.mjs"),
    `import { spawnSync } from "node:child_process";
     import { readFileSync, writeFileSync } from "node:fs";
     const [script, done] = process.argv.slice(2);
     const codes = JSON.parse(readFileSync(script, "utf8")).map(({ payload, args }) =>
       spawnSync(${JSON.stringify(process.execPath)}, args, { input: JSON.stringify(payload) }).status);
     writeFileSync(done, JSON.stringify(codes));
     setTimeout(() => {}, 600000);`,
  );
  const pane = rig(
    "new-window",
    "-d",
    "-P",
    "-F",
    "#{pane_id}",
    // A crew worker by mu's variables (no anchor): crew raises no `done`, so
    // the pane shows what `continued` did.
    `MURMUR_STATE_DIR=${process.env.MURMUR_STATE_DIR} MU_MANAGED_AGENT=1 MU_AGENT_NAME=worker-1 ${join(work, "claude")} ${join(work, "launcher.mjs")} ${join(work, "claude")} ${join(work, "feed.mjs")} ${script} ${done}; sleep 600`,
  );
  expect(await until(() => existsSync(done))).toBe(true);
  expect(JSON.parse(readFileSync(done, "utf8"))).toEqual([0, 0, 0, 0]);

  const report = (): Record<string, unknown> =>
    JSON.parse(
      execFileSync(process.execPath, [CLI, "pane", pane, "--json", "-S", SOCKET], {
        encoding: "utf8",
        env: process.env,
      }),
    );
  // The Stop's text arrived; mu's `continued` then put the turn back to work,
  // which only lands if it found the same pane and the same owner.
  expect(report()).toMatchObject({
    pane,
    state: "working",
    agent: {
      source: "inbox",
      harness: "claude",
      agent_name: "worker-1",
      driver: "orchestrated",
      session_id: recorded[0].session_id,
      run_count: 1,
      last_text: "OK",
    },
  });
  expect(paneOption(pane, "@murmur_pane_state")).toBe("working");

  // mu's interrupt for the pane, named from outside it: the owner gate passes,
  // and the pane reads `idle?` until the harness speaks.
  execFileSync(process.execPath, [CLI, "hook", "mu", "--pane", pane, "-S", SOCKET], {
    input: JSON.stringify({ event: "interrupted" }),
    env: process.env,
  });
  expect(report()).toMatchObject({ state: "idle?", agent: { run_count: 1 } });
});

/**
 * Sockets that accept a connection and never answer, as a stopped or wedged
 * tmux server's do: each one costs a tmux client its full timeout. In a
 * directory of their own laid out as tmux's (`<TMUX_TMPDIR>/tmux-<uid>`), under
 * /tmp to keep socket paths short.
 */
const HOLES_ROOT = realpathSync(mkdtempSync("/tmp/murmur-holes-"));
const HOLES = join(HOLES_ROOT, `tmux-${process.getuid?.()}`);
const HOLE_COUNT = 8;
let holes: ChildProcess | null = null;

beforeAll(async () => {
  mkdirSync(HOLES, { recursive: true });
  const script = join(work, "holes.mjs");
  writeFileSync(
    script,
    `import net from "node:net";
     const held = [];
     for (const path of process.argv.slice(2)) net.createServer((c) => held.push(c)).listen(path);
     setInterval(() => {}, 1e6);`,
  );
  const paths = Array.from({ length: HOLE_COUNT }, (_, index) => join(HOLES, `hole-${index}`));
  holes = spawn(process.execPath, [script, ...paths], { stdio: "ignore" });
  expect(await until(() => paths.every((path) => existsSync(path)))).toBe(true);
});

afterAll(() => {
  holes?.kill("SIGKILL");
  rmSync(HOLES_ROOT, { recursive: true, force: true });
});

function newPane(): { pane: string; root: number } {
  const pane = rig("new-window", "-d", "-P", "-F", "#{pane_id}", "sleep 600");
  return { pane, root: Number(rig("display-message", "-t", pane, "-p", "#{pane_pid}")) };
}

test("murmur pane drains only the pane it was asked about, fast, past silent sockets", () => {
  const { pane, root } = newPane();
  // As a hook with a cleared environment wrote it before the socket hint: no
  // `$TMUX`, nothing that names the server but its pid.
  expect(writeInboxEvent(event({ root_pid: root, owner_pid: root }))).toBe(true);
  // An inbox no drain can locate: its server pid is alive, and no socket in
  // tmux's directory answers for it. A full drain would ask all eight holes.
  const holesPid = holes?.pid as number;
  expect(writeInboxEvent(event({ server_pid: holesPid, root_pid: 7, owner_pid: 7 }))).toBe(true);
  const stranded = join(inboxDir(), inboxKey(holesPid, 7));

  const started = Date.now();
  const report = JSON.parse(
    execFileSync(process.execPath, [CLI, "pane", pane, "--json", "-S", SOCKET], {
      encoding: "utf8",
      env: { ...process.env, TMUX_TMPDIR: HOLES_ROOT },
      timeout: 60_000,
    }),
  );
  const elapsed = Date.now() - started;
  expect(report).toMatchObject({ pane, state: "working", agent: { harness: "claude" } });
  // One silent socket alone costs a tmux client 3 s, and mu gives up after 5.
  expect(elapsed).toBeLessThan(4000);
  // The other inbox is a later full drain's business.
  expect(existsSync(stranded)).toBe(true);
  rmSync(stranded, { recursive: true, force: true });
});

test("the drain finds a server by the hook's socket hint, then by the cache, never scanning", () => {
  const cache = join(work, "tmux-sockets.json");
  // Every scan would meet the holes first; `own` empty, so only a hint or the
  // cache can find the rig's server without one.
  const host = () =>
    tmuxInboxHost({ socketDirectory: HOLES, own: [], cache: loadSocketCache(cache) });
  const store = openStore();
  try {
    const first = newPane();
    writeInboxEvent(
      event({
        root_pid: first.root,
        owner_pid: first.root,
        server_socket: { kind: "path", value: SOCKET },
      }),
    );
    let started = Date.now();
    expect(drainInbox(store, { host: host() })).toMatchObject({ applied: 1, malformed: 0 });
    expect(Date.now() - started).toBeLessThan(2500);
    expect(paneOption(first.pane, "@murmur_pane_state")).toBe("working");
    expect(JSON.parse(readFileSync(cache, "utf8")).servers[String(serverPid)]).toMatchObject({
      socket: SOCKET,
    });

    // An event with no hint at all, in a new process's host: the cache answers.
    const second = newPane();
    writeInboxEvent(event({ root_pid: second.root, owner_pid: second.root }));
    started = Date.now();
    expect(drainInbox(store, { host: host() })).toMatchObject({ applied: 1, malformed: 0 });
    expect(Date.now() - started).toBeLessThan(2500);
    expect(paneOption(second.pane, "@murmur_pane_state")).toBe("working");
  } finally {
    store.close();
  }
});

test("with no hint and no cache, the reader's own server is asked before any scan", () => {
  const store = openStore();
  try {
    const { pane, root } = newPane();
    writeInboxEvent(event({ root_pid: root, owner_pid: root }));
    const started = Date.now();
    const host = tmuxInboxHost({
      socketDirectory: HOLES,
      own: [{ kind: "path", value: SOCKET }],
      cache: null,
    });
    expect(drainInbox(store, { host })).toMatchObject({ applied: 1 });
    expect(Date.now() - started).toBeLessThan(2500);
    expect(paneOption(pane, "@murmur_pane_state")).toBe("working");
  } finally {
    store.close();
  }
});
