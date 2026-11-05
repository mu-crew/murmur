import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { anchorLookup } from "../src/anchors.js";
import { paneReport } from "../src/cli/pane.js";
import type { Harness } from "../src/harnesses.js";
import { harnessHookEvent, muHookEvent, parseMuHookInput } from "../src/hook.js";
import { type HookPayload, mapHookPayload } from "../src/hook-rows.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { drainInbox, type InboxHost, inboxDir, writeInboxEvent } from "../src/inbox.js";
import { type InboxEvent, LAST_TEXT_MAX_BYTES } from "../src/inbox-event.js";
import {
  type ProcessRow,
  type ProcessTable,
  paneHarness,
  placeEvent,
} from "../src/process-chain.js";
import { openStore, type Store } from "../src/store.js";
import type { Location } from "../src/types.js";
import { builtArtifact } from "./helpers/built.js";
import { fakeMux } from "./helpers/fake-mux.js";

/**
 * `murmur hook claude`, `murmur hook codex` and `murmur hook mu`, driven by the
 * payloads and process chains recorded from the real harnesses in a real tmux
 * pane (test/fixtures/u0-*.jsonl).
 *
 * Each fixture line is one hook call as recorded: the payload on stdin, the
 * hook's `$TMUX`/`$TMUX_PANE`/`$CLAUDE_PID`, and its process chain from the hook
 * up to the tmux server (or to init, for claude's detached children). Paths,
 * argv and model names are scrubbed; pids, session ids, event order and every
 * field a row reads are as recorded. One probe line the spike ran by hand from
 * another pane is left out.
 *
 * The store is real: a recorded session is replayed through the hook, the
 * inbox and the drain, and the pane's state is read after every call.
 */

type FixtureLine = {
  u0_line: number;
  event: string;
  payload: HookPayload;
  env: Record<string, string>;
  chain: { pid: number; args: string }[];
};

function fixture(harness: "claude" | "codex"): FixtureLine[] {
  return readFileSync(join(import.meta.dirname, "fixtures", `u0-${harness}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as FixtureLine);
}

/** The recorded chain as a process table: each entry is the parent of the one before. */
function tableOf(chain: FixtureLine["chain"]): Map<number, ProcessRow> {
  const table = new Map<number, ProcessRow>();
  chain.forEach((entry, index) => {
    table.set(entry.pid, {
      pid: entry.pid,
      ppid: chain[index + 1]?.pid ?? 0,
      started: null,
      args: entry.args,
    });
  });
  return table;
}

const NOW = 1_800_000_000_000;

function hook(harness: Harness, line: FixtureLine): InboxEvent | null {
  return harnessHookEvent(harness, line.payload, {
    table: tableOf(line.chain),
    self: line.chain[0]?.pid as number,
    env: line.env,
    now: NOW,
  });
}

/**
 * What one recorded call comes to: the event written, or why nothing was --
 * `row` when the harness's row drops the payload, else the process chain's
 * reason.
 */
function outcome(harness: Harness, line: FixtureLine): string {
  if (mapHookPayload(harness, line.payload) === null) return "row";
  const event = hook(harness, line);
  if (event) return event.event;
  const placed = placeEvent(tableOf(line.chain), line.chain[0]?.pid as number, {
    tmuxEnv: line.env.TMUX,
  });
  return placed.kind === "drop" ? placed.reason : placed.kind;
}

test("every recorded claude call maps as the claude row says", () => {
  const lines = fixture("claude");
  expect(Object.fromEntries(lines.map((line) => [line.u0_line, outcome("claude", line)]))).toEqual({
    0: "session_start",
    1: "prompt_submitted",
    2: "turn_stopped",
    3: "prompt_submitted",
    4: "turn_stopped",
    5: "prompt_submitted",
    6: "turn_stopped",
    7: "prompt_submitted",
    8: "turn_stopped",
    9: "prompt_submitted",
    // `claude -p` run from the agent's shell: a second claude behind a shell.
    10: "nested",
    11: "nested",
    12: "nested",
    13: "prompt_submitted",
    14: "nested",
    // `claude plugin update`, detached under init, with $TMUX_PANE still set.
    15: "no-server",
    16: "prompt_submitted",
    17: "turn_stopped",
    18: "prompt_submitted",
    19: "turn_stopped",
    // The turn a Stop block continued: still a stop.
    20: "turn_stopped",
    21: "session_end",
    22: "session_start",
    23: "no-server",
    24: "prompt_submitted",
    // A subagent's turn is not the pane's.
    25: "row",
    26: "turn_stopped",
    27: "session_end",
    28: "no-server",
    29: "session_start",
    30: "prompt_submitted",
    31: "prompt_submitted",
    32: "session_end",
    33: "no-server",
    35: "session_start",
    36: "prompt_submitted",
    37: "turn_stopped",
    38: "session_end",
    39: "no-server",
  });
});

test("every recorded codex call maps as the codex row says", () => {
  const lines = fixture("codex");
  expect(Object.fromEntries(lines.map((line) => [line.u0_line, outcome("codex", line)]))).toEqual({
    0: "session_start",
    1: "prompt_submitted",
    // The hidden title-generation session: `transcript_path: null`, every event.
    2: "row",
    3: "row",
    4: "turn_stopped",
    5: "row",
    6: "prompt_submitted",
    7: "prompt_submitted",
    8: "prompt_submitted",
    9: "turn_stopped",
    10: "prompt_submitted",
    // `codex exec` from the agent's shell. The shell exec'd it, so no shell
    // separates it from the outer codex and the chain reads as one codex run:
    // placed, then refused at the drain by the live owner (see the replay).
    11: "session_start",
    12: "prompt_submitted",
    13: "turn_stopped",
    14: "session_end",
    15: "prompt_submitted",
    16: "turn_stopped",
    17: "prompt_submitted",
    18: "turn_stopped",
    19: "turn_stopped",
    20: "session_end",
    21: "row",
    22: "session_end",
    23: "session_start",
    24: "prompt_submitted",
    25: "row",
    26: "row",
    27: "row",
    28: "interrupted",
    29: "session_end",
    30: "row",
    31: "session_end",
    32: "session_start",
    33: "prompt_submitted",
    34: "row",
    35: "row",
    36: "turn_stopped",
    // The title session interrupted with its turn.
    37: "row",
    38: "session_end",
    39: "row",
  });
});

test("a recorded call is placed in its pane, owned by the harness binary", () => {
  const [first] = fixture("claude");
  const event = hook("claude", first as FixtureLine);
  expect(event).toMatchObject({
    event: "session_start",
    source: "startup",
    harness: "claude",
    server_pid: 7399,
    root_pid: 79888,
    // The native binary below the launcher: the pid claude exports as CLAUDE_PID.
    owner_pid: Number(first?.env.CLAUDE_PID),
    tmux: first?.env.TMUX,
    tmux_pane: "%72",
    session_id: "b3d7ba56-bda5-415d-bb10-34cb7eca5031",
    by: "harness",
    at: NOW,
    agent: { agent_name: null, workstream: null, role: null, cli: null, driver: "human" },
  });

  const codex = fixture("codex")[0] as FixtureLine;
  // codex.real < codex --foreground-session < codex: one codex, owned by codex.real.
  expect(hook("codex", codex)).toMatchObject({
    harness: "codex",
    root_pid: 79888,
    owner_pid: codex.chain[1]?.pid,
  });
});

test("a hook configured for one harness writes nothing from under another", () => {
  const claudeLine = fixture("claude")[1] as FixtureLine;
  expect(hook("codex", claudeLine)).toBeNull();
  const codexLine = fixture("codex")[1] as FixtureLine;
  expect(hook("claude", codexLine)).toBeNull();
});

test("a claude Stop carries the turn's own text, read from the payload at hook time", () => {
  const stop = fixture("claude").find((line) => line.u0_line === 4) as FixtureLine;
  // The transcript still ends with the previous turn when the hook runs: a
  // hook that read it would report "OK" for this turn.
  const transcript = join(mkdtempSync(join(tmpdir(), "murmur-hook-")), "t.jsonl");
  writeFileSync(
    transcript,
    `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "OK" }] } })}\n`,
  );
  const event = hook("claude", {
    ...stop,
    payload: { ...stop.payload, transcript_path: transcript },
  });
  expect(event).toMatchObject({ event: "turn_stopped", text: "60" });

  // Capped at 64 KB of UTF-8 in the file itself, never inside a character.
  const long = "é".repeat(LAST_TEXT_MAX_BYTES);
  const capped = hook("claude", {
    ...stop,
    payload: { ...stop.payload, last_assistant_message: long },
  });
  expect(Buffer.byteLength(capped?.text ?? "", "utf8")).toBe(LAST_TEXT_MAX_BYTES);
  expect(capped?.text?.endsWith("é")).toBe(true);
});

test("prompts, tool inputs and transcript paths never reach the event", () => {
  for (const harness of ["claude", "codex"] as const) {
    for (const line of fixture(harness)) {
      const event = hook(harness, line);
      if (!event) continue;
      const written = JSON.stringify(event);
      expect(written).not.toContain("transcript");
      expect(written).not.toContain("Reply with exactly");
      expect(written).not.toContain("/home/user");
    }
  }
});

// --- replay through the store ---------------------------------------------

const SERVER = 7399;
const ROOT = 79888;
const stores: Store[] = [];

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-hook-"));
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function store(): Store {
  const opened = openStore();
  stores.push(opened);
  return opened;
}

function location(): Location {
  return {
    server: { kind: "default" },
    session: asSessionId("$0"),
    window: asWindowId("@0"),
    pane: asPaneId("%72"),
    session_name: "work",
    window_name: null,
  };
}

/** The recorded server and pane; every recorded harness process alive. */
function host(focused = false): InboxHost {
  return {
    isAlive: () => true,
    serverFor: (pid) => (pid === SERVER ? { kind: "default" } : null),
    panes: () => new Map([[ROOT, { location: location(), focused }]]),
    piRunsUnder: () => false,
  };
}

function drain(s: Store, focused = false) {
  return drainInbox(s, {
    host: host(focused),
    mux: fakeMux({ panesInWindow: () => [asPaneId("%72")] }),
  });
}

function view(s: Store): string {
  const report = paneReport(s, asPaneId("%72"), { kind: "default" }, false);
  if (!report.agent) return report.state === null ? "released" : `released ${report.state}`;
  const session = report.agent.session_id?.slice(0, 8) ?? "?";
  return `${report.state} runs=${report.agent.run_count} session=${session}`;
}

/** Replay a recorded session: hook, inbox, drain, and the pane's state after each call. */
function replay(harness: Harness, s: Store): Record<number, string> {
  const states: Record<number, string> = {};
  for (const line of fixture(harness as "claude" | "codex")) {
    const event = hook(harness, line);
    if (event) expect(writeInboxEvent(event)).toBe(true);
    const summary = drain(s);
    states[line.u0_line] =
      `${event ? event.event : "-"}${summary.ignored > 0 ? " (refused)" : ""} -> ${view(s)}`;
  }
  return states;
}

test("a recorded claude session drives the pane through the vocabulary", () => {
  const s = store();
  const states = replay("claude", s);
  expect(states).toEqual({
    0: "session_start -> idle runs=0 session=b3d7ba56",
    1: "prompt_submitted -> working runs=1 session=b3d7ba56",
    2: "turn_stopped -> done runs=1 session=b3d7ba56",
    3: "prompt_submitted -> working runs=2 session=b3d7ba56",
    4: "turn_stopped -> done runs=2 session=b3d7ba56",
    5: "prompt_submitted -> working runs=3 session=b3d7ba56",
    6: "turn_stopped -> done runs=3 session=b3d7ba56",
    7: "prompt_submitted -> working runs=4 session=b3d7ba56",
    8: "turn_stopped -> done runs=4 session=b3d7ba56",
    9: "prompt_submitted -> working runs=5 session=b3d7ba56",
    10: "- -> working runs=5 session=b3d7ba56",
    11: "- -> working runs=5 session=b3d7ba56",
    12: "- -> working runs=5 session=b3d7ba56",
    13: "prompt_submitted -> working runs=6 session=b3d7ba56",
    14: "- -> working runs=6 session=b3d7ba56",
    15: "- -> working runs=6 session=b3d7ba56",
    16: "prompt_submitted -> working runs=7 session=b3d7ba56",
    17: "turn_stopped -> done runs=7 session=b3d7ba56",
    18: "prompt_submitted -> working runs=8 session=b3d7ba56",
    19: "turn_stopped -> done runs=8 session=b3d7ba56",
    20: "turn_stopped -> done runs=8 session=b3d7ba56",
    // `/clear`: the claim survives the end of one session ...
    21: "session_end -> done runs=8 session=b3d7ba56",
    // ... and the next starts from zero.
    22: "session_start -> done runs=0 session=c51422cd",
    23: "- -> done runs=0 session=c51422cd",
    24: "prompt_submitted -> working runs=1 session=c51422cd",
    25: "- -> working runs=1 session=c51422cd",
    26: "turn_stopped -> done runs=1 session=c51422cd",
    // `/exit`: released; the `done` outlives the process that raised it.
    27: "session_end -> released done",
    28: "- -> released done",
    29: "session_start -> done runs=0 session=beb8391f",
    30: "prompt_submitted -> working runs=1 session=beb8391f",
    31: "prompt_submitted -> working runs=2 session=beb8391f",
    32: "session_end -> released",
    33: "- -> released",
    35: "session_start -> idle runs=0 session=936aefec",
    36: "prompt_submitted -> working runs=1 session=936aefec",
    37: "turn_stopped -> done runs=1 session=936aefec",
    38: "session_end -> released done",
    39: "- -> released done",
  });
});

test("a recorded codex session drives the pane, its interrupt included", () => {
  const s = store();
  const states = replay("codex", s);
  expect(states).toEqual({
    0: "session_start -> idle runs=0 session=01a1ab55",
    1: "prompt_submitted -> working runs=1 session=01a1ab55",
    // The title session's events never reach the pane.
    2: "- -> working runs=1 session=01a1ab55",
    3: "- -> working runs=1 session=01a1ab55",
    4: "turn_stopped -> done runs=1 session=01a1ab55",
    5: "- -> done runs=1 session=01a1ab55",
    6: "prompt_submitted -> working runs=2 session=01a1ab55",
    7: "prompt_submitted -> working runs=3 session=01a1ab55",
    8: "prompt_submitted -> working runs=4 session=01a1ab55",
    9: "turn_stopped -> done runs=4 session=01a1ab55",
    10: "prompt_submitted -> working runs=5 session=01a1ab55",
    // `codex exec`: the live outer codex owns the pane, so its nested run is refused.
    11: "session_start (refused) -> working runs=5 session=01a1ab55",
    12: "prompt_submitted (refused) -> working runs=5 session=01a1ab55",
    13: "turn_stopped (refused) -> working runs=5 session=01a1ab55",
    14: "session_end (refused) -> working runs=5 session=01a1ab55",
    15: "prompt_submitted -> working runs=6 session=01a1ab55",
    16: "turn_stopped -> done runs=6 session=01a1ab55",
    17: "prompt_submitted -> working runs=7 session=01a1ab55",
    18: "turn_stopped -> done runs=7 session=01a1ab55",
    19: "turn_stopped -> done runs=7 session=01a1ab55",
    20: "session_end -> released done",
    21: "- -> released done",
    // Another session's end, with no row to end.
    22: "session_end (refused) -> released done",
    23: "session_start -> done runs=0 session=01a1ab58",
    24: "prompt_submitted -> working runs=1 session=01a1ab58",
    25: "- -> working runs=1 session=01a1ab58",
    26: "- -> working runs=1 session=01a1ab58",
    27: "- -> working runs=1 session=01a1ab58",
    // From the harness, an interrupt is a fact: idle, confirmed.
    28: "interrupted -> idle runs=1 session=01a1ab58",
    29: "session_end -> released",
    30: "- -> released",
    31: "session_end (refused) -> released",
    32: "session_start -> idle runs=0 session=01a1ab6e",
    33: "prompt_submitted -> working runs=1 session=01a1ab6e",
    34: "- -> working runs=1 session=01a1ab6e",
    35: "- -> working runs=1 session=01a1ab6e",
    36: "turn_stopped -> done runs=1 session=01a1ab6e",
    37: "- -> done runs=1 session=01a1ab6e",
    38: "session_end -> released done",
    39: "- -> released done",
  });
});

test("the last recorded turn's text is what the pane reports", () => {
  const s = store();
  const lines = fixture("claude").filter((line) => line.u0_line <= 8);
  for (const line of lines) {
    const event = hook("claude", line);
    if (event) writeInboxEvent(event);
  }
  drain(s);
  const report = paneReport(s, asPaneId("%72"), { kind: "default" }, false);
  expect(report.agent?.last_text).toBe(lines.at(-1)?.payload.last_assistant_message);
  expect(report.agent?.last_text).toMatch(/^I couldn't create/);
});

/**
 * The transitions U0 did not record for claude or codex. Each payload is a
 * recorded one with the fields of the event it stands in for, in the shape
 * Claude Code documents (and Muse, which shares its payloads, recorded for
 * `PermissionRequest`).
 */
function derived(harness: "claude" | "codex", over: HookPayload): FixtureLine {
  const base = fixture(harness).find(
    (line) => line.payload.hook_event_name === "UserPromptSubmit",
  ) as FixtureLine;
  const { prompt: _prompt, ...rest } = base.payload;
  return { ...base, payload: { ...rest, ...over } };
}

function attention(s: Store) {
  return paneReport(s, asPaneId("%72"), { kind: "default" }, false).attention.map(
    (row) => `${row.kind}:${row.message}`,
  );
}

test("permission requests block the pane until the harness says anything else", () => {
  for (const harness of ["claude", "codex"] as const) {
    process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-hook-"));
    const s = store();
    const prompt = fixture(harness).find(
      (line) => line.payload.hook_event_name === "UserPromptSubmit",
    ) as FixtureLine;
    writeInboxEvent(hook(harness, prompt) as InboxEvent);
    const request = derived(harness, {
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "touch ~/outside.txt" },
    });
    writeInboxEvent(hook(harness, request) as InboxEvent);
    drain(s);
    expect(view(s)).toMatch(/^blocked runs=1/);
    expect(attention(s)).toEqual(["blocked:Bash"]);

    const stop = derived(harness, { hook_event_name: "Stop", last_assistant_message: "done" });
    writeInboxEvent(hook(harness, stop) as InboxEvent);
    drain(s);
    expect(attention(s)).toEqual(["done:"]);
  }
});

test("claude's permission notification blocks; its idle reminder does not", () => {
  const s = store();
  const permission = derived("claude", {
    hook_event_name: "Notification",
    message: "Claude needs your permission to use Bash",
    notification_type: "permission_prompt",
  });
  const idle = derived("claude", {
    hook_event_name: "Notification",
    message: "Claude is waiting for your input",
    notification_type: "idle_prompt",
  });
  expect(hook("claude", idle)).toBeNull();
  writeInboxEvent(hook("claude", permission) as InboxEvent);
  drain(s);
  expect(attention(s)).toEqual(["blocked:Bash"]);
  // No notification_type (an older claude): the wording decides.
  const { notification_type: _type, ...untyped } = permission.payload;
  expect(hook("claude", { ...permission, payload: untyped })).toMatchObject({
    event: "permission_requested",
    message: "Bash",
  });
});

test("a claude StopFailure ends the turn in error", () => {
  const s = store();
  const prompt = fixture("claude")[1] as FixtureLine;
  writeInboxEvent(hook("claude", prompt) as InboxEvent);
  const failure = derived("claude", {
    hook_event_name: "StopFailure",
    error: "rate_limit",
    error_details: "429 Too Many Requests",
  });
  writeInboxEvent(hook("claude", failure) as InboxEvent);
  drain(s);
  expect(view(s)).toMatch(/^error runs=1/);
  expect(attention(s)).toEqual(["error:rate_limit: 429 Too Many Requests"]);
});

test("resume and compact pass their source through to the store's rules", () => {
  const s = store();
  const lines = fixture("claude").filter((line) => line.u0_line <= 2);
  for (const line of lines) writeInboxEvent(hook("claude", line) as InboxEvent);
  drain(s);
  const start = lines[0] as FixtureLine;
  for (const source of ["compact", "resume"]) {
    writeInboxEvent(
      hook("claude", { ...start, payload: { ...start.payload, source } }) as InboxEvent,
    );
    drain(s);
  }
  // compact changes nothing; resume is idle in the same session, runs kept.
  const report = paneReport(s, asPaneId("%72"), { kind: "default" }, false);
  expect(report.agent).toMatchObject({ run_count: 1, last_text: "OK", activity: "stopped" });
});

test("an anchor names the agent; without one, mu's variables do", () => {
  const line = fixture("claude")[1] as FixtureLine;
  const table = tableOf(line.chain);
  const launcher = line.chain[2]?.pid as number;
  table.set(launcher, { ...(table.get(launcher) as ProcessRow), started: 1_790_000_000 });
  const anchors = mkdtempSync(join(tmpdir(), "murmur-anchors-"));
  writeFileSync(
    join(anchors, `${launcher}.json`),
    JSON.stringify({
      agent_name: "worker-1",
      workstream: "ws",
      role: null,
      cli: "claude",
      orchestrator: false,
      remote_key: null,
      start_time: 1_790_000_000,
    }),
  );
  const context = { table, self: line.chain[0]?.pid as number, now: NOW };
  const env = { ...line.env, MU_AGENT_NAME: "from-env" };
  expect(
    harnessHookEvent("claude", line.payload, { ...context, env, anchor: anchorLookup(anchors) })
      ?.agent,
  ).toEqual({
    agent_name: "worker-1",
    workstream: "ws",
    role: null,
    cli: "claude",
    driver: "orchestrated",
  });
  expect(
    harnessHookEvent("claude", line.payload, {
      ...context,
      env: { ...env, MU_WORKSTREAM: "ws2", MU_AGENT_CLI: "claude" },
    })?.agent,
  ).toEqual({
    agent_name: "from-env",
    workstream: "ws2",
    role: null,
    cli: "claude",
    driver: "orchestrated",
  });
});

test("an anchor with a remote key writes nothing to this node's inbox", () => {
  const line = fixture("claude")[1] as FixtureLine;
  const event = harnessHookEvent("claude", line.payload, {
    table: tableOf(line.chain),
    self: line.chain[0]?.pid as number,
    env: line.env,
    now: NOW,
    anchor: (process) =>
      process.pid === line.chain[2]?.pid
        ? {
            agent_name: "w",
            workstream: null,
            role: null,
            cli: "claude",
            orchestrator: false,
            remote_key: "origin/%3",
          }
        : null,
  });
  expect(event).toBeNull();
});

// --- murmur hook mu -------------------------------------------------------

/** A recorded claude pane, with `mu hook stop` running as its Stop hook. */
function muChain(): { table: ProcessTable; self: number; owner: number } {
  const line = fixture("claude")[2] as FixtureLine;
  const [, ...harness] = line.chain;
  const chain = [
    { pid: 500, args: "node /usr/local/lib/node_modules/@mu-crew/murmur/dist/cli.js hook mu" },
    { pid: 501, args: "node /usr/local/lib/node_modules/@mu-crew/mu/dist/cli.js hook stop" },
    { pid: 502, args: "/bin/sh -c mu hook stop" },
    ...harness,
  ];
  return { table: tableOf(chain), self: 500, owner: harness[0]?.pid as number };
}

test("mu's payload is one vocabulary event, validated", () => {
  expect(parseMuHookInput({ event: "continued" })).toMatchObject({
    event: "continued",
    harness: null,
    session_id: null,
  });
  expect(parseMuHookInput({ event: "turn_stopped", text: "x", harness: "claude" })).toMatchObject({
    event: "turn_stopped",
    text: "x",
    harness: "claude",
  });
  expect(parseMuHookInput({ event: "Stop" })).toBe("unknown event: Stop");
  expect(parseMuHookInput({})).toBe("unknown event: null");
  expect(parseMuHookInput({ event: "continued", harness: "vim" })).toBe("unknown harness: vim");
  expect(parseMuHookInput({ event: "continued", session_id: 3 })).toBe(
    "session_id must be a string",
  );
  expect(
    parseMuHookInput({
      event: "turn_stopped",
      agent: { agent_name: "worker-2", workstream: "ws", driver: "orchestrated" },
    }),
  ).toMatchObject({
    agent: {
      agent_name: "worker-2",
      workstream: "ws",
      role: null,
      cli: null,
      driver: "orchestrated",
    },
  });
  for (const agent of ["worker-2", { agent_name: 3 }, { driver: "robot" }]) {
    expect(parseMuHookInput({ event: "continued", agent })).toBe(
      "agent: agent_name, workstream, role and cli must be strings, driver human or orchestrated",
    );
  }
});

test("mu's continued, from the harness's own Stop hook, lands on that pane as its owner", () => {
  const { table, self, owner } = muChain();
  const env = { TMUX: "/tmp/tmux-1000/default,7399,22", TMUX_PANE: "%72" };
  const event = muHookEvent(parseMuHookInput({ event: "continued" }) as never, {
    table,
    self,
    env,
    now: NOW,
  });
  expect(event).toMatchObject({
    event: "continued",
    harness: "claude",
    server_pid: SERVER,
    root_pid: ROOT,
    owner_pid: owner,
    by: "mu",
  });
  expect(
    muHookEvent(parseMuHookInput({ event: "continued", harness: "codex" }) as never, {
      table,
      self,
      env,
      now: NOW,
    }),
  ).toBe("this pane runs claude, not codex");
  // Outside any harness's pane: refused, with the reason.
  expect(
    muHookEvent(parseMuHookInput({ event: "continued" }) as never, {
      table: tableOf([
        { pid: 600, args: "node murmur hook mu" },
        { pid: 601, args: "-zsh" },
        { pid: SERVER, args: "tmux new-session -d" },
      ]),
      self: 600,
      env: {},
      now: NOW,
    }),
  ).toBe("not inside a harness's tmux pane (no-harness)");
});

test("paneHarness finds the pane's harness and the owner its hooks record", () => {
  const { table, owner } = muChain();
  expect(paneHarness(table, ROOT)).toEqual({
    pid: owner,
    harness: "claude",
    top: fixture("claude")[2]?.chain[2]?.pid,
  });
  // codex: codex < codex --foreground-session < codex.real, owned by codex.real.
  const codex = fixture("codex")[1] as FixtureLine;
  expect(paneHarness(tableOf(codex.chain), ROOT)).toMatchObject({
    pid: codex.chain[1]?.pid,
    harness: "codex",
  });
  expect(
    paneHarness(
      tableOf([
        { pid: 9, args: "ssh host" },
        { pid: 8, args: "-zsh" },
      ]),
      8,
    ),
  ).toBeNull();
});

test("mu's interrupt for a named pane reads idle? until the harness speaks", () => {
  const s = store();
  const { table } = muChain();
  for (const line of fixture("claude").filter((entry) => entry.u0_line <= 1)) {
    writeInboxEvent(hook("claude", line) as InboxEvent);
  }
  drain(s);
  expect(view(s)).toMatch(/^working runs=1/);

  const target = {
    server_pid: SERVER,
    root_pid: ROOT,
    tmux: "/tmp/tmux-1000/default,7399,0",
    tmux_pane: "%72",
  };
  const interrupt = muHookEvent(
    parseMuHookInput({ event: "interrupted" }) as never,
    { table, self: process.pid, env: {}, now: NOW },
    target,
  );
  expect(interrupt).toMatchObject({ event: "interrupted", by: "mu", harness: "claude" });
  writeInboxEvent(interrupt as InboxEvent);
  expect(drain(s)).toMatchObject({ applied: 1, ignored: 0 });
  expect(view(s)).toMatch(/^idle\? runs=1/);

  // The harness's next event replaces mu's word.
  writeInboxEvent(hook("claude", fixture("claude")[2] as FixtureLine) as InboxEvent);
  drain(s);
  expect(view(s)).toMatch(/^done runs=1/);
});

test("a pane with no local harness takes the harness mu names, or is refused", () => {
  const table = tableOf([
    { pid: 900, args: "ssh -t devhost tmux attach" },
    { pid: 901, args: "-zsh" },
  ]);
  const target = { server_pid: SERVER, root_pid: 901, tmux: "/tmp/s,7399,0", tmux_pane: "%9" };
  const context = { table, self: process.pid, env: {}, now: NOW };
  expect(
    muHookEvent(parseMuHookInput({ event: "prompt_submitted" }) as never, context, target),
  ).toBe('no harness runs in pane %9; name one with "harness"');
  // Owned by the ssh, not the login shell that outlives it.
  expect(
    muHookEvent(
      parseMuHookInput({ event: "turn_stopped", harness: "claude", text: "remote" }) as never,
      context,
      target,
    ),
  ).toMatchObject({ harness: "claude", owner_pid: 900, root_pid: 901, text: "remote", by: "mu" });
  // A pane of shells alone (a harness that has just died, say) has nothing to own it.
  expect(
    muHookEvent(
      parseMuHookInput({ event: "interrupted", harness: "claude" }) as never,
      {
        ...context,
        table: tableOf([
          { pid: 902, args: "/bin/bash" },
          { pid: 901, args: "-zsh" },
        ]),
      },
      target,
    ),
  ).toBe("pane %9 runs neither a harness nor a remote session, only a shell");

  const { table: local } = muChain();
  expect(
    muHookEvent(
      parseMuHookInput({ event: "continued", harness: "codex" }) as never,
      {
        ...context,
        table: local,
      },
      { ...target, root_pid: ROOT, tmux_pane: "%72" },
    ),
  ).toBe("pane %72 runs claude, not codex");
});

/** An ssh pane in the recorded pane's place: the login shell, and the ssh under it. */
const SSH = 900;
const sshPane = {
  table: tableOf([
    { pid: SSH, args: "ssh -t devhost" },
    { pid: ROOT, args: "-zsh" },
    { pid: SERVER, args: "tmux new-session -d" },
  ]),
  target: {
    server_pid: SERVER,
    root_pid: ROOT,
    tmux: "/tmp/tmux-1000/default,7399,0",
    tmux_pane: "%72",
  },
};

function relay(payload: HookPayload): InboxEvent {
  const event = muHookEvent(
    parseMuHookInput(payload) as never,
    { table: sshPane.table, self: process.pid, env: {}, now: NOW },
    sshPane.target,
  );
  if (typeof event === "string") throw new Error(event);
  return event;
}

test("an ssh pane's claim dies with its session; a harness started there next takes the pane", () => {
  const s = store();
  writeInboxEvent(relay({ event: "turn_stopped", harness: "codex", text: "remote" }));
  expect(drain(s)).toMatchObject({ applied: 1 });
  expect(view(s)).toMatch(/^done /);

  // The ssh exits; the shell under it lives on, and claude starts in it.
  const drainWith = () =>
    drainInbox(s, {
      host: { ...host(), isAlive: (pid) => pid !== SSH },
      mux: fakeMux({ panesInWindow: () => [asPaneId("%72")] }),
    });
  for (const line of fixture("claude").filter((entry) => entry.u0_line <= 1)) {
    writeInboxEvent(hook("claude", line) as InboxEvent);
  }
  expect(drainWith()).toMatchObject({ applied: 2, ignored: 0 });
  expect(view(s)).toMatch(/^working runs=1/);
  expect(paneReport(s, asPaneId("%72"), { kind: "default" }, false).agent?.harness).toBe("claude");
});

test("while its ssh lives, an ssh pane refuses a local harness's events", () => {
  const s = store();
  writeInboxEvent(relay({ event: "prompt_submitted", harness: "codex" }));
  expect(drain(s)).toMatchObject({ applied: 1 });
  writeInboxEvent(hook("claude", fixture("claude")[1] as FixtureLine) as InboxEvent);
  expect(drain(s)).toMatchObject({ applied: 0, ignored: 1 });
  expect(paneReport(s, asPaneId("%72"), { kind: "default" }, false).agent?.harness).toBe("codex");
});

test("a remote crew worker's relayed turn carries its identity, and raises no done", () => {
  const s = store();
  const agent = { agent_name: "worker-2", workstream: "ws", cli: "claude", driver: "orchestrated" };
  writeInboxEvent(relay({ event: "prompt_submitted", harness: "claude", agent }));
  writeInboxEvent(relay({ event: "turn_stopped", harness: "claude", text: "CLOSE", agent }));
  expect(drain(s)).toMatchObject({ applied: 2, ignored: 0 });
  const report = paneReport(s, asPaneId("%72"), { kind: "default" }, false);
  expect(report.agent).toMatchObject({
    agent_name: "worker-2",
    workstream: "ws",
    cli: "claude",
    driver: "orchestrated",
    last_text: "CLOSE",
  });
  expect(report.attention).toEqual([]);
  expect(view(s)).toMatch(/^idle runs=1/);

  // An anchor in the pane outranks what mu names.
  const { table } = muChain();
  const launcher = fixture("claude")[2]?.chain[2]?.pid as number;
  const event = muHookEvent(
    parseMuHookInput({ event: "continued", agent }) as never,
    {
      table,
      self: process.pid,
      env: {},
      now: NOW,
      anchor: (process) =>
        process.pid === launcher
          ? {
              agent_name: "anchored",
              workstream: null,
              role: null,
              cli: "claude",
              orchestrator: false,
              remote_key: null,
            }
          : null,
    },
    sshPane.target,
  );
  expect(event).toMatchObject({ agent: { agent_name: "anchored", driver: "orchestrated" } });
});

// --- the CLI --------------------------------------------------------------

function cli(args: string[], input: string) {
  return spawnSync(process.execPath, [builtArtifact("cli.js"), ...args], {
    input,
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, MURMUR_STATE_DIR: process.env.MURMUR_STATE_DIR },
  });
}

test("a harness hook exits 0 and prints nothing, whatever it is given", () => {
  const title = fixture("codex").find((line) => line.u0_line === 2) as FixtureLine;
  for (const [args, input] of [
    [["hook", "claude"], "not json"],
    [["hook", "claude"], ""],
    [["hook", "codex"], JSON.stringify(title.payload)],
    [["hook", "cursor-agent"], "{}"],
    [["hook", "claude", "extra", "args"], "[]"],
    [["hook", "claude", "--x"], "{}"],
    [["hook", "codex", "--verbose", "-q"], "{}"],
  ] as const) {
    const run = cli([...args], input);
    expect({ args, status: run.status, stdout: run.stdout, stderr: run.stderr }).toEqual({
      args,
      status: 0,
      stdout: "",
      stderr: "",
    });
  }
  // The title session's payload was dropped by its row: nothing in the inbox.
  let entries: string[] = [];
  try {
    entries = readdirSync(inboxDir()).filter((entry) => entry !== "tmp");
  } catch {
    entries = [];
  }
  expect(entries).toEqual([]);
});

test("murmur hook mu reports what it refused", () => {
  const bad = cli(["hook", "mu"], JSON.stringify({ event: "Stop" }));
  expect(bad.status).toBe(1);
  expect(bad.stderr).toBe("murmur: hook mu: unknown event: Stop\n");
  const pane = cli(["hook", "mu", "--pane", "12"], JSON.stringify({ event: "continued" }));
  expect(pane.status).toBe(2);
  expect(pane.stderr).toBe("murmur: not a tmux pane id: 12\n");
  const flag = cli(["hook", "mu", "--verbose"], JSON.stringify({ event: "continued" }));
  expect(flag.status).toBe(2);
  expect(flag.stderr).toBe("murmur: hook mu: unknown option: --verbose\n");
});
