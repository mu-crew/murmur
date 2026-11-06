import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { writeHookEvent } from "../src/cli/hook.js";
import { type HookWrite, muRemoteEvent, parseMuHookInput, placeHarnessHook } from "../src/hook.js";
import { inboxDir, remoteDir, remoteKeyName, writeRemoteEvent } from "../src/inbox-file.js";
import { dbPath } from "../src/paths.js";
import type { AgentAnchor } from "../src/process-chain.js";
import { drainRemote, type RemoteReport } from "../src/remote.js";
import { openStore, type Store } from "../src/store.js";
import { builtArtifact } from "./helpers/built.js";
import { contextOf, drain, type FixtureLine, fixture, report } from "./helpers/u0.js";

/**
 * The remote area (D11): a worker mu started on this node for a pane on
 * another. Its hooks write to `remote/<key>/`, never the inbox; only
 * `murmur pane --remote <key>` reads it, and nothing reaches this node's store.
 */

const KEY = "origin.example/%41";
const stores: Store[] = [];

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-remote-"));
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

/**
 * A recorded claude line as a remote worker's: the same harness chain, ending
 * at sshd instead of a tmux server, as U0 saw under plain ssh.
 */
function remoteLine(line: FixtureLine): FixtureLine {
  const harness = line.chain.slice(1).filter((entry) => !entry.args.startsWith("tmux"));
  const chain = [
    line.chain[0] as FixtureLine["chain"][number],
    ...harness.filter((entry) => entry.args !== "-zsh"),
    { pid: 4000, args: "bash -c claude" },
    { pid: 3999, args: "sshd: user@notty" },
    { pid: 1, args: "/sbin/launchd" },
  ];
  return { ...line, env: {}, chain };
}

/** An anchor with the remote key on the claude launcher. */
function anchored(line: FixtureLine, key: string | null = KEY) {
  const launcher = line.chain.find((entry) => entry.args === "/opt/claude/bin/claude")?.pid;
  const anchor: AgentAnchor = {
    agent_name: "worker-9",
    workstream: "ws",
    role: null,
    cli: "claude",
    orchestrator: false,
    remote_key: key,
  };
  return (process: { pid: number }) => (process.pid === launcher ? anchor : null);
}

function place(line: FixtureLine, over: Parameters<typeof contextOf>[1] = {}): HookWrite | null {
  return placeHarnessHook("claude", line.payload, contextOf(line, over));
}

function read(key = KEY): RemoteReport {
  const result = drainRemote(key);
  if (typeof result === "string") throw new Error(result);
  return result;
}

function inboxEntries(): string[] {
  try {
    return readdirSync(inboxDir()).filter((entry) => entry !== "tmp");
  } catch {
    return [];
  }
}

test("a remote-keyed event goes to the remote area and never reaches this node's store", () => {
  const store = openStore();
  stores.push(store);
  for (const recorded of fixture("claude").filter((line) => line.u0_line <= 2)) {
    // The tmux chain as recorded: a remote worker in a tmux pane on this node
    // is still the origin's, so its anchor's key wins over the pane it sits in.
    const placed = place(recorded, { anchor: anchored(recorded) });
    expect(placed?.area).toBe("remote");
    expect(writeHookEvent(placed as HookWrite)).toBe(true);
  }
  expect(inboxEntries()).toEqual([]);
  expect(drain(store)).toMatchObject({ applied: 0 });
  expect(store.localPanes()).toEqual([]);
  expect(report(store).state).toBeNull();

  const remote = read();
  expect(remote).toMatchObject({
    remote: KEY,
    state: "idle",
    agent: { agent_name: "worker-9", harness: "claude", run_count: 1, last_text: "OK" },
  });
  expect(remote.events.map((event) => event.event)).toEqual([
    "session_start",
    "prompt_submitted",
    "turn_stopped",
  ]);
  // Still nothing local after the read.
  expect(store.localPanes()).toEqual([]);
});

test("a remote worker under plain ssh is routed by its anchor, or by MU_REMOTE_KEY without one", () => {
  const line = remoteLine(fixture("claude")[1] as FixtureLine);
  // No tmux and no key: dropped, as claude's detached children are.
  expect(place(line)).toBeNull();
  expect(place(line, { anchor: anchored(line) })).toMatchObject({
    area: "remote",
    event: { remote_key: KEY, harness: "claude", event: "prompt_submitted", owner_pid: 91280 },
  });
  expect(place(line, { env: { MU_REMOTE_KEY: "other/%2" } })).toMatchObject({
    area: "remote",
    event: { remote_key: "other/%2", agent: { agent_name: null } },
  });
  // An anchor that says local outranks the variable.
  expect(place(line, { anchor: anchored(line, null), env: { MU_REMOTE_KEY: "other/%2" } })).toBe(
    null,
  );
});

test("a remote read applies each event once, keeps the state, and follows the vocabulary", () => {
  const lines = fixture("claude")
    .filter((line) => line.u0_line <= 4)
    .map(remoteLine);
  for (const line of lines.slice(0, 2)) {
    writeHookEvent(place(line, { anchor: anchored(line) }) as HookWrite);
  }
  const first = read();
  expect(first).toMatchObject({ state: "working", agent: { run_count: 1, claimed: true } });
  expect(first.events.map((event) => event.event)).toEqual(["session_start", "prompt_submitted"]);
  // Read again: nothing new, the same state.
  const again = read();
  expect(again.events).toEqual([]);
  expect(again).toMatchObject({ state: "working", agent: { run_count: 1 } });

  for (const line of lines.slice(2)) {
    writeHookEvent(place(line, { anchor: anchored(line) }) as HookWrite);
  }
  const later = read();
  // A crew worker's settled turn raises no `done`: the origin decides when relayed.
  expect(later).toMatchObject({
    state: "idle",
    agent: { run_count: 2, last_text: "60", driver: "orchestrated" },
    attention: [],
  });
  expect(later.events.map((event) => [event.event, event.text])).toEqual([
    ["turn_stopped", "OK"],
    ["prompt_submitted", null],
    ["turn_stopped", "60"],
  ]);
  const name = remoteKeyName(KEY) as string;
  expect(existsSync(join(remoteDir(), `${name}.json`))).toBe(true);
  expect(existsSync(join(remoteDir(), name))).toBe(false);
});

test("mu's remote interrupt reads idle? until the harness speaks, and claims nothing", () => {
  const interrupt = muRemoteEvent(
    parseMuHookInput({ event: "interrupted" }) as never,
    KEY,
    Date.now(),
  );
  writeRemoteEvent(interrupt);
  expect(read()).toMatchObject({ state: null, agent: null, events: [] });

  const lines = fixture("claude")
    .filter((line) => line.u0_line <= 2)
    .map(remoteLine);
  for (const line of lines.slice(0, 2)) {
    writeHookEvent(place(line, { anchor: anchored(line) }) as HookWrite);
  }
  writeRemoteEvent(interrupt);
  expect(read()).toMatchObject({ state: "idle?", agent: { confirmed: false } });
  writeHookEvent(
    place(lines[2] as FixtureLine, { anchor: anchored(lines[2] as FixtureLine) }) as HookWrite,
  );
  expect(read()).toMatchObject({ state: "idle", agent: { confirmed: true, last_text: "OK" } });
});

test("a remote harness interrupt relayed --by harness is confirmed, and text names its run", () => {
  const lines = fixture("claude")
    .filter((line) => line.u0_line <= 4)
    .map(remoteLine);
  for (const line of lines) writeHookEvent(place(line, { anchor: anchored(line) }) as HookWrite);
  // Two turns, each with its own text: the second one wrote it.
  expect(read()).toMatchObject({ agent: { run_count: 2, last_text: "60", last_text_run: 2 } });
  writeHookEvent(
    place(lines[3] as FixtureLine, { anchor: anchored(lines[3] as FixtureLine) }) as HookWrite,
  );
  writeRemoteEvent(
    muRemoteEvent(parseMuHookInput({ event: "interrupted" }, "harness") as never, KEY, Date.now()),
  );
  // The third turn ended without text: the text is still the second's.
  expect(read()).toMatchObject({
    state: "idle",
    agent: { run_count: 3, confirmed: true, last_text: "60", last_text_run: 2 },
  });
});

test("a released remote key keeps its last turn for mu to collect", () => {
  const lines = fixture("claude")
    .filter((line) => [0, 1, 2].includes(line.u0_line))
    .map(remoteLine);
  for (const line of lines) writeHookEvent(place(line, { anchor: anchored(line) }) as HookWrite);
  const end = remoteLine(fixture("claude").find((line) => line.u0_line === 27) as FixtureLine);
  const session = lines[0]?.payload.session_id;
  writeHookEvent(
    place(
      { ...end, payload: { ...end.payload, session_id: session } },
      { anchor: anchored(end) },
    ) as HookWrite,
  );
  expect(read()).toMatchObject({ agent: { claimed: false, last_text: "OK" } });
});

test("a remote key names a file safely, or is refused", () => {
  const name = remoteKeyName("host.example/%12") as string;
  expect(name).not.toMatch(/[/.]/);
  expect(decodeURIComponent(name)).toBe("host.example/%12");
  for (const key of ["", "..", ".", ".tmp"]) {
    const encoded = remoteKeyName(key);
    if (encoded !== null) expect(encoded).not.toMatch(/^\.+$|^\.tmp$|[/]/);
  }
  expect(remoteKeyName("")).toBeNull();
  expect(remoteKeyName("a\nb")).toBeNull();
  expect(remoteKeyName("x".repeat(500))).toBeNull();
  expect(drainRemote("")).toBe('not a usable remote key: ""');
});

test("a read takes over a dead or ancient reader's lock, and removes only its own", () => {
  const lines = fixture("claude")
    .filter((line) => line.u0_line <= 1)
    .map(remoteLine);
  for (const line of lines) writeHookEvent(place(line, { anchor: anchored(line) }) as HookWrite);
  mkdirSync(remoteDir(), { recursive: true });
  const lock = join(remoteDir(), `${remoteKeyName(KEY)}.lock`);
  const DEAD = 999_999;
  // A reader killed with its ssh left its lock: taken at once, not waited out.
  writeFileSync(lock, String(DEAD));
  const started = Date.now();
  const result = drainRemote(KEY, { isAlive: (pid) => pid !== DEAD });
  expect(Date.now() - started).toBeLessThan(1000);
  expect(result).toMatchObject({ state: "working", agent: { run_count: 1 } });
  expect(existsSync(lock)).toBe(false);
  expect(readdirSync(join(remoteDir(), ".tmp"))).toEqual([]);
  // A live holder's lock from longer ago than any read takes (a reused pid): taken.
  writeFileSync(lock, "1");
  const old = (Date.now() - 120_000) / 1000;
  utimesSync(lock, old, old);
  expect(drainRemote(KEY, { isAlive: () => true })).toMatchObject({ state: "working" });
  expect(existsSync(lock)).toBe(false);
});

function cli(args: string[], input = "") {
  return spawnSync(process.execPath, [builtArtifact("cli.js"), ...args], {
    input,
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, MURMUR_STATE_DIR: process.env.MURMUR_STATE_DIR },
  });
}

test("murmur pane --remote reads the area and opens no store", () => {
  const lines = fixture("claude")
    .filter((line) => line.u0_line <= 2)
    .map(remoteLine);
  for (const line of lines) writeHookEvent(place(line, { anchor: anchored(line) }) as HookWrite);
  const run = cli(["pane", "--remote", KEY, "--json"]);
  expect(run.status).toBe(0);
  const printed = JSON.parse(run.stdout) as RemoteReport;
  expect(printed).toMatchObject({ remote: KEY, state: "idle", agent: { last_text: "OK" } });
  expect(printed.events).toHaveLength(3);
  expect(existsSync(dbPath())).toBe(false);

  // mu's own event, written on the worker's node through the same path.
  const mu = cli(["hook", "mu", "--remote", KEY], JSON.stringify({ event: "interrupted" }));
  expect({ status: mu.status, stderr: mu.stderr }).toEqual({ status: 0, stderr: "" });
  expect(JSON.parse(cli(["pane", "--remote", KEY, "--json"]).stdout)).toMatchObject({
    state: "idle?",
  });
  expect(existsSync(dbPath())).toBe(false);

  const both = cli(["pane", "%1", "--remote", KEY]);
  expect(both.status).toBe(2);
  expect(both.stderr).toBe("murmur: pane: give a pane or --remote, not both\n");
  const bad = cli(["hook", "mu", "--remote", ""], JSON.stringify({ event: "interrupted" }));
  expect(bad.status).toBe(2);
  const exclusive = cli(
    ["hook", "mu", "--remote", KEY, "--pane", "%1"],
    JSON.stringify({ event: "interrupted" }),
  );
  expect(exclusive.status).toBe(2);
  expect(readFileSync(join(remoteDir(), `${remoteKeyName(KEY)}.json`), "utf8")).toContain(
    '"claimed":true',
  );

  // A live reader's fresh lock is waited for, never taken: two readers would
  // apply, and mu relay, the same events twice.
  const lock = join(remoteDir(), `${remoteKeyName(KEY)}.lock`);
  writeFileSync(lock, String(process.pid));
  const blocked = spawnSync(
    process.execPath,
    [builtArtifact("cli.js"), "pane", "--remote", KEY, "--json"],
    {
      encoding: "utf8",
      timeout: 1500,
      env: { ...process.env, MURMUR_STATE_DIR: process.env.MURMUR_STATE_DIR },
    },
  );
  expect(blocked.signal).toBe("SIGTERM");
  expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
});
