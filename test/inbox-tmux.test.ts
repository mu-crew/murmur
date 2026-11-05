import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { asPaneId } from "../src/ids.js";
import { drainInbox, tmuxInboxHost, writeInboxEvent } from "../src/inbox.js";
import type { InboxEvent } from "../src/inbox-event.js";
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
