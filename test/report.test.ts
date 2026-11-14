import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { reportEvent, reportRuntime } from "../src/cli/report.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { drainInbox, type InboxHost, writeInboxEvent } from "../src/inbox.js";
import { type InboxEvent, parseInboxEvent } from "../src/inbox-event.js";
import { dbPath } from "../src/paths.js";
import type { ProcessRow } from "../src/process-chain.js";
import { applyRemoteEvent, emptyRemoteState } from "../src/remote.js";
import { openStore, type Store } from "../src/store.js";
import { initialTurn, stepTurn } from "../src/turn.js";
import type { Location } from "../src/types.js";
import { builtArtifact } from "./helpers/built.js";
import { fakeMux } from "./helpers/fake-mux.js";

/** `murmur report`: a lifecycle-neutral runtime patch, placed like a hook. */

const SERVER = 5100;
const ROOT = 5200;
const OWNER = 5300;

const stores: Store[] = [];
beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-report-"));
});
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  delete process.env.MURMUR_STATE_DIR;
});

const location: Location = {
  server: { kind: "default" },
  session: asSessionId("$0"),
  window: asWindowId("@0"),
  pane: asPaneId("%1"),
  session_name: "work",
  window_name: null,
};

function event(over: Partial<InboxEvent> = {}): InboxEvent {
  return {
    v: 1,
    event: "prompt_submitted",
    harness: "claude",
    at: 1_000,
    server_pid: SERVER,
    root_pid: ROOT,
    owner_pid: OWNER,
    tmux: null,
    tmux_pane: null,
    session_id: null,
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

function drain(s: Store, alive: number[] = [SERVER, OWNER]) {
  const host: InboxHost = {
    isAlive: (pid) => alive.includes(pid),
    serverFor: () => ({ kind: "default" }),
    panes: () => new Map([[ROOT, { location, focused: false }]]),
    piRunsUnder: () => false,
  };
  return drainInbox(s, {
    host,
    mux: fakeMux({ panesInWindow: () => [asPaneId("%1")], publish: () => {} }),
  });
}

function send(s: Store, alive?: number[], ...events: InboxEvent[]): void {
  for (const e of events) expect(writeInboxEvent(e)).toBe(true);
  drain(s, alive);
}

function open(): Store {
  const s = openStore();
  stores.push(s);
  return s;
}

const report = (runtime: InboxEvent["runtime"], over: Partial<InboxEvent> = {}) =>
  event({ event: "runtime_reported", at: 2_000, runtime, ...over });

function row(s: Store) {
  const agent = s.localPanes()[0]?.agent;
  return agent && { ...agent };
}

test("a placed report updates only the keys it names", () => {
  const s = open();
  send(
    s,
    undefined,
    event({ event: "session_start", session_id: "s1", runtime: { model: "m1", effort: "high" } }),
  );
  send(s, undefined, report({ provider: "acme", context_pct: 40 }));
  expect(row(s)).toMatchObject({
    model: "m1",
    effort: "high",
    provider: "acme",
    context_pct: 40,
    context_tokens: null,
  });
  send(s, undefined, report({ context_tokens: 1000, context_window: 2000 }));
  expect(row(s)).toMatchObject({ provider: "acme", context_tokens: 1000, context_window: 2000 });
});

test("a report changes no turn state, attention or confirmation", () => {
  const s = open();
  send(s, undefined, event({ event: "session_start", session_id: "s1" }));
  send(s, undefined, event({ event: "prompt_submitted", session_id: "s1", at: 1_100 }));
  send(
    s,
    undefined,
    event({ event: "turn_stopped", session_id: "s1", text: "hi", generation_id: "g", at: 1_200 }),
  );
  send(
    s,
    undefined,
    event({ event: "permission_requested", session_id: "s1", message: "Bash", at: 1_300 }),
  );
  send(s, undefined, event({ event: "interrupted", by: "mu", session_id: "s1", at: 1_400 }));
  const snapshot = () =>
    JSON.stringify(s.localPanes(), (key, value) =>
      key === "model" || key === "updated_at" ? null : value,
    );
  const before = snapshot();
  const turn = () => s.harnessState(location);
  const turnBefore = turn();
  expect(turnBefore).toMatchObject({ confirmed: false, run_count: 1, last_text: "hi" });
  send(s, undefined, report({ model: "m2" }));
  expect(row(s)?.model).toBe("m2");
  expect(snapshot()).toEqual(before);
  expect(turn()).toEqual(turnBefore);
  // blocked survives a report too.
  send(
    s,
    undefined,
    event({ event: "permission_requested", session_id: "s1", message: "Bash", at: 1_500 }),
  );
  send(s, undefined, report({ model: "m3" }));
  expect(s.localPanes()[0]?.attention.map((a) => a.kind)).toContain("blocked");
});

test("a report never claims a pane, and a dead or other owner is dropped", () => {
  const s = open();
  send(s, undefined, report({ model: "m" }));
  expect(s.localPanes()).toHaveLength(0);
  send(s, undefined, event({ event: "session_start", session_id: "s1" }));
  send(s, undefined, report({ model: "other" }, { owner_pid: OWNER + 1 }));
  expect(row(s)?.model).toBeNull();
  send(s, [SERVER], report({ model: "dead" }));
  expect(row(s)?.model).toBeNull();
  send(s, undefined, report({ model: "other-harness" }, { harness: "codex" }));
  expect(row(s)?.model).toBeNull();
});

test("a report against a pi row, live or store-free, is ignored", () => {
  const live = open();
  live.claimAgent({
    location,
    owner_pid: 5400,
    meta: {
      agent_name: null,
      pi_session: null,
      workstream: null,
      role: null,
      cli: "pi",
      driver: "human",
    },
    nestedUnder: () => null,
  });
  send(live, [SERVER, OWNER, 5400], report({ model: "hook" }));
  expect(row(live)?.model).toBeNull();
  const free = open();
  send(free, undefined, event({ harness: "pi", event: "session_start", session_id: "s" }));
  send(free, undefined, report({ model: "hook" }, { harness: "pi" }));
  expect(row(free)?.model).toBeNull();
});

test("pi placements are refused, and a remote key is a no-op", () => {
  const table = new Map<number, ProcessRow>([
    [11, { pid: 11, ppid: OWNER, started: null, args: "node murmur report" }],
    [OWNER, { pid: OWNER, ppid: ROOT, started: null, args: "claude" }],
    [ROOT, { pid: ROOT, ppid: SERVER, started: null, args: "-zsh" }],
    [SERVER, { pid: SERVER, ppid: 1, started: null, args: "tmux new-session -d" }],
  ]);
  const placed = reportEvent({ model: "m" }, null, {
    table,
    self: 11,
    env: { TMUX: `/tmp/tmux-1/default,${SERVER},0`, TMUX_PANE: "%1" },
    now: 7,
  });
  expect(placed).toMatchObject({
    event: "runtime_reported",
    harness: "claude",
    owner_pid: OWNER,
    runtime: { model: "m" },
  });
  expect(parseInboxEvent(JSON.stringify(placed))).toMatchObject({ event: "runtime_reported" });
  const key = "k";
  const state = emptyRemoteState(key);
  expect(
    applyRemoteEvent(
      state,
      { ...event(), event: "runtime_reported", remote_key: key } as never,
      () => true,
    ),
  ).toBeNull();
});

test("flags set only their own keys; an invalid one is skipped", () => {
  expect(reportRuntime({ model: "m", effort: "weird", contextPct: "12.5" }).runtime).toEqual({
    model: "m",
    provider_effort: "weird",
    context_pct: 12.5,
  });
  const bad = reportRuntime({
    model: "m",
    contextPct: "150",
    contextTokens: "x",
    contextWindow: "0",
  });
  expect(bad.runtime).toEqual({ model: "m" });
  expect(bad.warnings).toHaveLength(3);
  expect(reportRuntime({}).runtime).toEqual({});
});

test("murmur report exits 0 for an invalid flag and for none", () => {
  const run = (...args: string[]) =>
    spawnSync("node", [builtArtifact("cli.js"), "report", ...args], {
      encoding: "utf8",
      env: { ...process.env, MURMUR_STATE_DIR: process.env.MURMUR_STATE_DIR },
    });
  const bad = run("--context-pct", "abc");
  expect(bad.status).toBe(0);
  expect(bad.stderr).toContain("--context-pct");
  const none = run();
  expect(none.status).toBe(0);
  expect(none.stderr).toContain("nothing to report");
});

test("murmur report tolerates malformed options and keeps the valid fields", () => {
  const run = (...args: string[]) =>
    spawnSync("node", [builtArtifact("cli.js"), "report", ...args], {
      encoding: "utf8",
      env: { ...process.env, MURMUR_STATE_DIR: process.env.MURMUR_STATE_DIR },
    });
  const missing = run("--context-pct");
  expect(missing.status).toBe(0);
  expect(missing.stderr).toContain("--context-pct: argument missing");
  expect(run("--effort").status).toBe(0);
  const unknown = run("--bogus", "--model", "valid");
  expect(unknown.status).toBe(0);
  expect(unknown.stderr).toContain("unknown option --bogus");
  // The valid field survives: it got as far as placing the event (no tmux
  // here), not "nothing to report".
  expect(unknown.stderr).not.toContain("nothing to report");
  const mixed = run("--model", "--context-pct", "33");
  expect(mixed.status).toBe(0);
  expect(mixed.stderr).toContain("--model: argument missing");
  expect(mixed.stderr).not.toContain("nothing to report");
  // Other commands keep Commander's strictness.
  const other = spawnSync("node", [builtArtifact("cli.js"), "status", "--bogus"], {
    encoding: "utf8",
    env: { ...process.env, MURMUR_STATE_DIR: process.env.MURMUR_STATE_DIR },
  });
  expect(other.status).not.toBe(0);
});

test("context_tokens 0 replaces a nonzero count; a zero window is still refused", () => {
  const s = open();
  send(s, undefined, event({ event: "session_start", session_id: "s1" }));
  send(s, undefined, report({ context_tokens: 1200, context_window: 2000 }));
  expect(row(s)).toMatchObject({ context_tokens: 1200, context_window: 2000 });
  const flags = reportRuntime({ contextTokens: "0", contextWindow: "0" });
  expect(flags.runtime).toEqual({ context_tokens: 0 });
  expect(flags.warnings).toHaveLength(1);
  send(s, undefined, report(flags.runtime));
  expect(row(s)).toMatchObject({ context_tokens: 0, context_window: 2000 });
});

test("stepTurn applies a runtime_reported to no state at all", () => {
  const state = {
    ...initialTurn("s1"),
    activity: "running" as const,
    run_count: 3,
    last_text: "t",
    last_text_run: 2,
    confirmed: false,
    generation_id: "g",
    generation_end: "stopped" as const,
    generation_run: 2,
  };
  const step = stepTurn(state, {
    event: "runtime_reported",
    by: "harness",
    session_id: null,
    source: null,
    reason: null,
    message: null,
    text: null,
    generation_id: "g",
  });
  expect(step).toEqual({ kind: "apply", next: null, release: false, clear: [], raise: null });
});

function generation() {
  const database = new Database(dbPath(), { readonly: true });
  try {
    return database
      .prepare(
        "SELECT generation_id, generation_end, generation_run, activity, run_count FROM agents",
      )
      .get() as Record<string, unknown>;
  } finally {
    database.close();
  }
}

test("a report leaves the stored generation columns as they were", () => {
  const s = open();
  send(s, undefined, event({ event: "session_start", session_id: "s1" }));
  send(s, undefined, event({ event: "prompt_submitted", session_id: "s1", at: 1_100 }));
  send(
    s,
    undefined,
    event({ event: "turn_stopped", session_id: "s1", text: "hi", generation_id: "g", at: 1_200 }),
  );
  const before = generation();
  expect(before.generation_id).toBe("g");
  expect(before.generation_end).toBe("stopped");
  expect(before.generation_run).not.toBeNull();
  send(s, undefined, report({ model: "m2" }, { session_id: "s1", generation_id: "g" }));
  expect(row(s)?.model).toBe("m2");
  expect(generation()).toEqual(before);
});

test("a report against a populated remote state leaves it unchanged", () => {
  const key = "k";
  let state = emptyRemoteState(key);
  for (const e of [
    event({ event: "session_start", session_id: "s1" }),
    event({ event: "prompt_submitted", session_id: "s1", at: 1_100 }),
    event({ event: "turn_stopped", session_id: "s1", text: "hi", generation_id: "g", at: 1_200 }),
  ]) {
    const next = applyRemoteEvent(state, { ...e, remote_key: key } as never, () => true);
    if (next) state = next;
  }
  expect(state.claimed).toBe(true);
  expect(state.turn.generation_id).toBe("g");
  const before = structuredClone(state);
  const result = applyRemoteEvent(
    state,
    { ...report({ model: "x" }), remote_key: key } as never,
    () => true,
  );
  expect(result).toBeNull();
  expect(state).toEqual(before);
});
