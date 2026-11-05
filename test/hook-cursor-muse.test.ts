import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { anchorLookup } from "../src/anchors.js";
import type { Harness } from "../src/harnesses.js";
import { harnessHookEvent } from "../src/hook.js";
import { mapHookPayload } from "../src/hook-rows.js";
import { writeInboxEvent } from "../src/inbox.js";
import type { InboxEvent } from "../src/inbox-event.js";
import { dbPath } from "../src/paths.js";
import type { ProcessRow } from "../src/process-chain.js";
import { openStore, type Store } from "../src/store.js";
import {
  attention,
  contextOf,
  drain,
  type FixtureLine,
  type FixtureName,
  fixture,
  hook,
  NOW,
  outcome,
  ROOT,
  report,
  SERVER,
  tableOf,
  view,
} from "./helpers/u0.js";

/**
 * `murmur hook cursor-agent` and `murmur hook muse`, driven by the payloads and
 * process chains recorded from the real harnesses in a real tmux pane
 * (test/fixtures/u0-cursor-agent.jsonl, u0-muse.jsonl from a Claude-format
 * plugin, u0-muse-settings.jsonl from Muse-format settings hooks).
 *
 * Muse's hooks ran with a cleared environment: those lines carry no `$TMUX` or
 * `$TMUX_PANE`, so every placement below comes from the chain alone.
 */

const stores: Store[] = [];

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-hook-u3-"));
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function store(): Store {
  const opened = openStore();
  stores.push(opened);
  return opened;
}

function outcomes(harness: Harness, name: FixtureName): Record<number, string> {
  return Object.fromEntries(fixture(name).map((line) => [line.u0_line, outcome(harness, line)]));
}

/** Replay a recorded session: hook, inbox, drain, and the pane's state after each call. */
function replay(harness: Harness, name: FixtureName, s: Store, withText = false) {
  const states: Record<number, string> = {};
  for (const line of fixture(name)) {
    const event = hook(harness, line);
    if (event) expect(writeInboxEvent(event)).toBe(true);
    const summary = drain(s);
    states[line.u0_line] =
      `${event ? event.event : "-"}${summary.ignored > 0 ? " (refused)" : ""} -> ${view(s, withText)}`;
  }
  return states;
}

// --- cursor-agent ---------------------------------------------------------

test("every recorded cursor-agent call maps as the cursor-agent row says", () => {
  expect(outcomes("cursor-agent", "cursor-agent")).toEqual({
    0: "session_start",
    1: "prompt_submitted",
    // The turn's text, in its own event: a stop that carries it.
    2: "turn_stopped",
    3: "turn_stopped",
    4: "prompt_submitted",
    5: "turn_stopped",
    6: "turn_stopped",
    7: "prompt_submitted",
    // Escape: `stop` with `status: aborted`, then `error` for the same generation.
    8: "interrupted",
    9: "turn_failed",
    10: "prompt_submitted",
    11: "turn_stopped",
    12: "turn_stopped",
    13: "prompt_submitted",
    // `cursor-agent -p` from the agent's shell: a second cursor-agent behind a shell.
    14: "nested",
    15: "nested",
    16: "turn_stopped",
    17: "turn_stopped",
    18: "prompt_submitted",
    // The stop first, its text after it.
    19: "turn_stopped",
    20: "turn_stopped",
    // The turn a stop hook's follow-up started: no prompt of its own.
    21: "turn_stopped",
    22: "turn_stopped",
    23: "session_end",
    24: "session_start",
    25: "prompt_submitted",
    26: "turn_stopped",
    27: "turn_stopped",
    28: "session_end",
  });
});

test("a recorded cursor-agent session drives the pane; late text joins its own turn", () => {
  const s = store();
  expect(replay("cursor-agent", "cursor-agent", s, true)).toEqual({
    0: "session_start -> idle runs=0 session=2947a49f text=null",
    1: "prompt_submitted -> working runs=1 session=2947a49f text=null",
    2: 'turn_stopped -> done runs=1 session=2947a49f text="OK"',
    // The same generation's stop, after its text: the turn already ended.
    3: 'turn_stopped (refused) -> done runs=1 session=2947a49f text="OK"',
    4: 'prompt_submitted -> working runs=2 session=2947a49f text="OK"',
    5: 'turn_stopped -> done runs=2 session=2947a49f text="60"',
    6: 'turn_stopped (refused) -> done runs=2 session=2947a49f text="60"',
    7: 'prompt_submitted -> working runs=3 session=2947a49f text="60"',
    // From the harness, the abort is a fact: idle, confirmed ...
    8: 'interrupted -> idle runs=3 session=2947a49f text="60"',
    // ... and the error stop that echoes it is dropped, not an error.
    9: 'turn_failed (refused) -> idle runs=3 session=2947a49f text="60"',
    10: 'prompt_submitted -> working runs=4 session=2947a49f text="60"',
    11: 'turn_stopped -> done runs=4 session=2947a49f text="Creating `~/u0-perm-test.txt` with the contents `hi`.Created `~/u0-perm-test.txt` with `hi`."',
    12: 'turn_stopped (refused) -> done runs=4 session=2947a49f text="Creating `~/u0-perm-test.txt` with the contents `hi`.Created `~/u0-perm-test.txt` with `hi`."',
    13: 'prompt_submitted -> working runs=5 session=2947a49f text="Creating `~/u0-perm-test.txt` with the contents `hi`.Created `~/u0-perm-test.txt` with `hi`."',
    14: '- -> working runs=5 session=2947a49f text="Creating `~/u0-perm-test.txt` with the contents `hi`.Created `~/u0-perm-test.txt` with `hi`."',
    15: '- -> working runs=5 session=2947a49f text="Creating `~/u0-perm-test.txt` with the contents `hi`.Created `~/u0-perm-test.txt` with `hi`."',
    16: 'turn_stopped -> done runs=5 session=2947a49f text="```\\nNESTED\\n```"',
    17: 'turn_stopped (refused) -> done runs=5 session=2947a49f text="```\\nNESTED\\n```"',
    18: 'prompt_submitted -> working runs=6 session=2947a49f text="```\\nNESTED\\n```"',
    // The stop ends the turn with no text yet -- never the previous turn's ...
    19: "turn_stopped -> done runs=6 session=2947a49f text=null",
    // ... and the text that follows it fills it in.
    20: 'turn_stopped -> done runs=6 session=2947a49f text="OK"',
    21: 'turn_stopped -> done runs=6 session=2947a49f text="BLOCKED-OK"',
    22: 'turn_stopped (refused) -> done runs=6 session=2947a49f text="BLOCKED-OK"',
    23: "session_end -> released done",
    24: "session_start -> done runs=0 session=ae445c1c text=null",
    25: "prompt_submitted -> working runs=1 session=ae445c1c text=null",
    26: "turn_stopped -> done runs=1 session=ae445c1c text=null",
    27: 'turn_stopped -> done runs=1 session=ae445c1c text="OK"',
    28: "session_end -> released done",
  });
});

/** A recorded cursor-agent line with its payload changed. */
function cursor(line: number, over: Record<string, unknown> = {}): FixtureLine {
  const base = fixture("cursor-agent").find((entry) => entry.u0_line === line) as FixtureLine;
  return { ...base, payload: { ...base.payload, ...over } };
}

function apply(s: Store, ...lines: FixtureLine[]) {
  for (const line of lines) {
    const event = hook("cursor-agent", line);
    expect(event).not.toBeNull();
    writeInboxEvent(event as InboxEvent);
  }
  return drain(s);
}

test("a cursor-agent text that lands during the next turn changes only the text", () => {
  const s = store();
  apply(s, cursor(0), cursor(18), cursor(19));
  expect(view(s, true)).toBe("done runs=1 session=2947a49f text=null");
  // The next prompt is in, then the previous turn's text arrives.
  apply(s, cursor(18, { generation_id: "0f0f0f0f-next-turn" }), cursor(20));
  expect(view(s, true)).toBe('working runs=2 session=2947a49f text="OK"');
});

test("an error stop drained before its abort is cleared by the abort", () => {
  const s = store();
  apply(s, cursor(0), cursor(7));
  apply(s, cursor(9));
  expect(attention(s)).toEqual(["error:error"]);
  apply(s, cursor(8));
  expect(attention(s)).toEqual([]);
  expect(view(s)).toBe("idle runs=1 session=2947a49f");
});

test("an error stop with no abort before it is a failed turn", () => {
  const s = store();
  apply(s, cursor(0), cursor(7), cursor(9));
  expect(view(s)).toBe("error runs=1 session=2947a49f");
  expect(attention(s)).toEqual(["error:error"]);
});

test("cursor-agent's email and secrets never reach an event or the store", () => {
  const s = store();
  const secrets = ["user@example.com", "s3cr3t-askpass"];
  for (const line of fixture("cursor-agent")) {
    const env = {
      ...line.env,
      CURSOR_USER_EMAIL: "user@example.com",
      CURSOR_ASKPASS_SECRET: "s3cr3t-askpass",
    };
    // The payload really does carry the email: the row must leave it behind.
    expect(JSON.stringify(line.payload)).toContain("user@example.com");
    const event = harnessHookEvent("cursor-agent", line.payload, contextOf(line, { env }));
    if (!event) continue;
    const written = JSON.stringify(event);
    for (const secret of secrets) expect(written).not.toContain(secret);
    writeInboxEvent(event);
    drain(s);
  }
  s.close();
  stores.splice(stores.indexOf(s), 1);
  for (const suffix of ["", "-wal"]) {
    const path = `${dbPath()}${suffix}`;
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path).toString("latin1");
    for (const secret of secrets) expect(bytes).not.toContain(secret);
  }
});

test("cursor-agent has no permission hook, and its unknown stops map to nothing", () => {
  expect(mapHookPayload("cursor-agent", { hook_event_name: "beforeShellExecution" })).toBeNull();
  expect(mapHookPayload("cursor-agent", { hook_event_name: "stop", status: "paused" })).toBeNull();
  expect(mapHookPayload("cursor-agent", { hook_event_name: "afterAgentResponse" })).toBeNull();
});

// --- muse -----------------------------------------------------------------

test("every recorded Muse call maps as the muse row says", () => {
  expect(outcomes("muse", "muse")).toEqual({
    0: "session_start",
    1: "prompt_submitted",
    2: "turn_stopped",
    // The built-in reminder subagents' turns are not the pane's.
    3: "row",
    4: "prompt_submitted",
    5: "turn_stopped",
    6: "row",
    7: "prompt_submitted",
    8: "row",
    9: "prompt_submitted",
    10: "row",
    11: "permission_requested",
    12: "permission_requested",
    13: "row",
    14: "row",
    15: "turn_stopped",
    16: "row",
    17: "prompt_submitted",
    18: "row",
    // `muse exec` from the agent's shell tool, exec'd with no shell between:
    // one muse run, placed, then refused at the drain by the live owner.
    19: "session_start",
    20: "prompt_submitted",
    21: "turn_stopped",
    22: "row",
    23: "row",
    24: "row",
    25: "session_end",
    26: "row",
    27: "permission_requested",
    28: "row",
    29: "turn_stopped",
    30: "prompt_submitted",
    31: "row",
    32: "turn_stopped",
    // The turn a Stop block continued: still a stop.
    33: "turn_stopped",
    34: "row",
    35: "row",
    36: "row",
    37: "turn_stopped",
    38: "row",
    39: "row",
    40: "prompt_submitted",
    41: "turn_stopped",
    42: "row",
    43: "turn_stopped",
    44: "row",
    45: "row",
    46: "session_end",
    47: "session_start",
    48: "prompt_submitted",
    49: "turn_stopped",
    50: "row",
    51: "interrupted",
    52: "session_end",
  });
  expect(outcomes("muse", "muse-settings")).toEqual({
    0: "session_end",
    1: "session_start",
    2: "prompt_submitted",
    3: "interrupted",
    4: "session_end",
  });
});

test("a recorded Muse session drives the pane from the chain alone", () => {
  const s = store();
  expect(replay("muse", "muse", s)).toEqual({
    0: "session_start -> idle runs=0 session=01a1ab61",
    1: "prompt_submitted -> working runs=1 session=01a1ab61",
    2: "turn_stopped -> done runs=1 session=01a1ab61",
    3: "- -> done runs=1 session=01a1ab61",
    4: "prompt_submitted -> working runs=2 session=01a1ab61",
    5: "turn_stopped -> done runs=2 session=01a1ab61",
    6: "- -> done runs=2 session=01a1ab61",
    7: "prompt_submitted -> working runs=3 session=01a1ab61",
    8: "- -> working runs=3 session=01a1ab61",
    9: "prompt_submitted -> working runs=4 session=01a1ab61",
    10: "- -> working runs=4 session=01a1ab61",
    11: "permission_requested -> blocked runs=4 session=01a1ab61",
    12: "permission_requested -> blocked runs=4 session=01a1ab61",
    13: "- -> blocked runs=4 session=01a1ab61",
    14: "- -> blocked runs=4 session=01a1ab61",
    15: "turn_stopped -> done runs=4 session=01a1ab61",
    16: "- -> done runs=4 session=01a1ab61",
    17: "prompt_submitted -> working runs=5 session=01a1ab61",
    18: "- -> working runs=5 session=01a1ab61",
    // `muse exec`: the live outer muse owns the pane, so its nested run is refused.
    19: "session_start (refused) -> working runs=5 session=01a1ab61",
    20: "prompt_submitted (refused) -> working runs=5 session=01a1ab61",
    21: "turn_stopped (refused) -> working runs=5 session=01a1ab61",
    22: "- -> working runs=5 session=01a1ab61",
    23: "- -> working runs=5 session=01a1ab61",
    24: "- -> working runs=5 session=01a1ab61",
    25: "session_end (refused) -> working runs=5 session=01a1ab61",
    26: "- -> working runs=5 session=01a1ab61",
    27: "permission_requested -> blocked runs=5 session=01a1ab61",
    28: "- -> blocked runs=5 session=01a1ab61",
    29: "turn_stopped -> done runs=5 session=01a1ab61",
    30: "prompt_submitted -> working runs=6 session=01a1ab61",
    31: "- -> working runs=6 session=01a1ab61",
    32: "turn_stopped -> done runs=6 session=01a1ab61",
    33: "turn_stopped -> done runs=6 session=01a1ab61",
    34: "- -> done runs=6 session=01a1ab61",
    35: "- -> done runs=6 session=01a1ab61",
    36: "- -> done runs=6 session=01a1ab61",
    37: "turn_stopped -> done runs=6 session=01a1ab61",
    38: "- -> done runs=6 session=01a1ab61",
    39: "- -> done runs=6 session=01a1ab61",
    40: "prompt_submitted -> working runs=7 session=01a1ab61",
    41: "turn_stopped -> done runs=7 session=01a1ab61",
    42: "- -> done runs=7 session=01a1ab61",
    43: "turn_stopped -> done runs=7 session=01a1ab61",
    44: "- -> done runs=7 session=01a1ab61",
    45: "- -> done runs=7 session=01a1ab61",
    46: "session_end -> released done",
    47: "session_start -> done runs=0 session=01a1ab6f",
    48: "prompt_submitted -> working runs=1 session=01a1ab6f",
    49: "turn_stopped -> done runs=1 session=01a1ab6f",
    50: "- -> done runs=1 session=01a1ab6f",
    // An Interrupt of the turn that already stopped: dropped, and the `done`
    // it has not acknowledged stays.
    51: "interrupted (refused) -> done runs=1 session=01a1ab6f",
    52: "session_end -> released done",
  });
});

/** A recorded Muse line with its payload changed. */
function museLine(line: number, over: Record<string, unknown> = {}): FixtureLine {
  const base = fixture("muse").find((entry) => entry.u0_line === line) as FixtureLine;
  return { ...base, payload: { ...base.payload, ...over } };
}

test("Muse's async Interrupt of a stopped turn, landing in the next turn, keeps it running", () => {
  const s = store();
  for (const line of [museLine(47), museLine(48), museLine(49), museLine(50)]) {
    const event = hook("muse", line);
    if (event) writeInboxEvent(event);
  }
  drain(s);
  expect(view(s, true)).toBe('done runs=1 session=01a1ab6f text="OK"');
  // mu sends the next prompt at the Stop; the first turn's Interrupt lands after it.
  writeInboxEvent(hook("muse", museLine(48, { turn_id: "01a1ab70-next-turn" })) as InboxEvent);
  writeInboxEvent(hook("muse", museLine(51)) as InboxEvent);
  expect(drain(s)).toMatchObject({ applied: 1, ignored: 1 });
  expect(view(s, true)).toBe('working runs=2 session=01a1ab6f text="OK"');
  // An Interrupt of the turn that is running still stops it.
  writeInboxEvent(hook("muse", museLine(51, { turn_id: "01a1ab70-next-turn" })) as InboxEvent);
  drain(s);
  expect(view(s, true)).toBe('idle runs=2 session=01a1ab6f text="OK"');
});

test("Muse-format settings hooks deliver Interrupt: the turn ends idle", () => {
  const s = store();
  expect(replay("muse", "muse-settings", s)).toEqual({
    // Another session's end, with no row to end.
    0: "session_end (refused) -> released",
    1: "session_start -> idle runs=0 session=01a1ab6a",
    2: "prompt_submitted -> working runs=1 session=01a1ab6a",
    3: "interrupted -> idle runs=1 session=01a1ab6a",
    4: "session_end -> released",
  });
});

test("a Muse hook with no environment is placed by its chain and named by mu's anchor", () => {
  const line = fixture("muse")[1] as FixtureLine;
  expect(line.env).toEqual({});
  // muse.real < muse: one muse, owned by the binary the hook runs under.
  expect(hook("muse", line)).toMatchObject({
    event: "prompt_submitted",
    harness: "muse",
    server_pid: SERVER,
    root_pid: ROOT,
    owner_pid: line.chain[1]?.pid,
    tmux: null,
    tmux_pane: null,
    agent: { agent_name: null, driver: "human" },
  });

  const table = tableOf(line.chain);
  const launcher = line.chain[2]?.pid as number;
  table.set(launcher, { ...(table.get(launcher) as ProcessRow), started: 1_790_000_000 });
  const anchors = mkdtempSync(join(tmpdir(), "murmur-anchors-"));
  writeFileSync(
    join(anchors, `${launcher}.json`),
    JSON.stringify({
      agent_name: "worker-3",
      workstream: "ws",
      role: null,
      cli: "muse",
      orchestrator: false,
      remote_key: null,
      start_time: 1_790_000_000,
    }),
  );
  expect(
    harnessHookEvent("muse", line.payload, {
      table,
      self: line.chain[0]?.pid as number,
      env: {},
      anchor: anchorLookup(anchors),
      now: NOW,
    })?.agent,
  ).toEqual({
    agent_name: "worker-3",
    workstream: "ws",
    role: null,
    cli: "muse",
    driver: "orchestrated",
  });
});

test("Muse's null transcript path is not codex's title session", () => {
  const line = fixture("muse")[2] as FixtureLine;
  expect(line.payload.transcript_path).toBeNull();
  expect(mapHookPayload("muse", line.payload)).toMatchObject({ event: "turn_stopped", text: "OK" });
  expect(mapHookPayload("codex", line.payload)).toBeNull();
});

test("a Muse StopFailure ends the turn in error, in claude's shape", () => {
  const s = store();
  const [start, prompt] = fixture("muse") as [FixtureLine, FixtureLine];
  writeInboxEvent(hook("muse", start) as InboxEvent);
  writeInboxEvent(hook("muse", prompt) as InboxEvent);
  const failure = {
    ...prompt,
    payload: { ...prompt.payload, hook_event_name: "StopFailure", error: "overloaded" },
  };
  writeInboxEvent(hook("muse", failure) as InboxEvent);
  drain(s);
  expect(view(s)).toBe("error runs=1 session=01a1ab61");
  expect(attention(s)).toEqual(["error:overloaded"]);
  expect(report(s).agent?.harness).toBe("muse");
});
