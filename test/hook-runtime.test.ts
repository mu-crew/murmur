import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { Harness } from "../src/harnesses.js";
import { placeHarnessHook } from "../src/hook.js";
import { mapHookPayload } from "../src/hook-rows.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { drainInbox, type InboxHost, writeInboxEvent } from "../src/inbox.js";
import { type InboxEvent, parseInboxEvent, parseRuntime } from "../src/inbox-event.js";
import { openStore, type Store } from "../src/store.js";
import type { Location } from "../src/types.js";
import { fakeMux } from "./helpers/fake-mux.js";

/**
 * Hook runtime: the model, provider and effort a payload says, mapped by each
 * row, carried on the inbox event and applied by the drain to the row.
 */

const SERVER = 4100;
const ROOT = 4200;
const OWNER = 4300;
const PI = 4400;

const stores: Store[] = [];

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-runtime-"));
});

afterEach(() => {
  for (const s of stores.splice(0)) {
    try {
      s.close();
    } catch {
      // Already closed.
    }
  }
});

function store(): Store {
  const opened = openStore();
  stores.push(opened);
  return opened;
}

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

function host(alive: number[] = [SERVER, OWNER]): InboxHost {
  return {
    isAlive: (pid) => alive.includes(pid),
    serverFor: () => ({ kind: "default" }),
    panes: () => new Map([[ROOT, { location, focused: false }]]),
    piRunsUnder: () => false,
  };
}

function drain(s: Store, alive?: number[]) {
  const mux = fakeMux({ panesInWindow: () => [asPaneId("%1")], publish: () => {} });
  return drainInbox(s, { host: host(alive), mux });
}

function send(s: Store, ...events: InboxEvent[]): void {
  for (const e of events) expect(writeInboxEvent(e)).toBe(true);
  drain(s);
}

function runtime(s: Store) {
  const agent = s.localPanes()[0]?.agent;
  return (
    agent && {
      model: agent.model,
      provider: agent.provider,
      effort: agent.effort,
      provider_effort: agent.provider_effort,
    }
  );
}

type Line = { event: string; payload: Record<string, unknown> };

/** A fixture's mapped events up to the first session_end, or `stop` of them, drained once. */
function replay(s: Store, harness: Harness, name: string, stop = Number.POSITIVE_INFINITY) {
  const lines = readFileSync(join(import.meta.dirname, "fixtures", `u0-${name}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Line);
  const events: InboxEvent[] = [];
  for (const line of lines) {
    const mapped = mapHookPayload(harness, line.payload);
    if (!mapped) continue;
    if (mapped.event === "session_end" || events.length >= stop) break;
    events.push(event({ ...mapped, harness, at: events.length + 1 }));
  }
  send(s, ...events);
}

test("claude: model from SessionStart, effort from the first Stop", () => {
  const s = store();
  replay(s, "claude", "claude", 2);
  expect(runtime(s)).toMatchObject({ model: "claude-opus-5-5", effort: null });
  replay(s, "claude", "claude");
  expect(runtime(s)).toMatchObject({ model: "claude-opus-5-5", effort: "medium" });
});

test("codex: the model; muse: model and provider, never a subagent's; cursor: none", () => {
  const c = store();
  replay(c, "codex", "codex");
  expect(runtime(c)).toMatchObject({ model: "gpt-5", provider: null, effort: null });
});

test("muse's subagent model never reaches the row", () => {
  const s = store();
  replay(s, "muse", "muse");
  expect(runtime(s)).toMatchObject({ model: "model-a", provider: "example" });
  expect(mapHookPayload("muse", { hook_event_name: "SubagentStop", model: "model-b" })).toBeNull();
});

test("cursor-agent's default model is no model", () => {
  const s = store();
  replay(s, "cursor-agent", "cursor-agent");
  expect(s.localPanes()[0]?.agent).toBeDefined();
  expect(runtime(s)).toMatchObject({ model: null, provider: null, effort: null });
});

test("absent words are absent: auto, default, unknown", () => {
  for (const word of ["auto", "default", "unknown"]) {
    expect(
      mapHookPayload("cursor-agent", { hook_event_name: "sessionStart", model: word })?.runtime,
    ).toBeUndefined();
  }
  expect(
    mapHookPayload("muse", { hook_event_name: "Interrupt", model: "unknown" })?.runtime,
  ).toBeUndefined();
});

test("a malformed runtime field is dropped, the event is kept", () => {
  const mapped = mapHookPayload("claude", {
    hook_event_name: "Stop",
    session_id: "s1",
    effort: { level: 7 },
    model: {},
  });
  expect(mapped).toMatchObject({ event: "turn_stopped" });
  expect(mapped?.runtime).toBeUndefined();

  expect(parseRuntime({ model: {}, effort: 7, provider: "p" })).toEqual({ provider: "p" });
  const s = store();
  const raw = { ...event(), runtime: { model: ["x"], effort: 7, provider: "p" } };
  expect(parseInboxEvent(JSON.stringify(raw))?.runtime).toEqual({ provider: "p" });
  send(s, event({ runtime: { model: "m" } }));
  expect(runtime(s)?.model).toBe("m");
});

test("an effort murmur does not know is provider_effort", () => {
  expect(parseRuntime({ effort: "ultra" })).toEqual({ provider_effort: "ultra" });
  expect(parseRuntime({ effort: "high" })).toEqual({ effort: "high" });
});

test("a later event without a model leaves the stored one", () => {
  const s = store();
  send(
    s,
    event({ event: "session_start", source: "startup", at: 1, runtime: { model: "m1" } }),
    event({ at: 2, runtime: { effort: "low" } }),
    event({ at: 3 }),
  );
  expect(runtime(s)).toMatchObject({ model: "m1", effort: "low" });
});

test("a compact session_start still applies its runtime", () => {
  const s = store();
  send(
    s,
    event({ event: "prompt_submitted", at: 1 }),
    event({ event: "session_start", source: "compact", at: 2, runtime: { model: "m2" } }),
  );
  expect(runtime(s)?.model).toBe("m2");
});

test("ignored events apply no runtime", () => {
  const s = store();
  send(s, event({ at: 1, runtime: { model: "m1" } }));
  // Another session's event, and a different live owner's: both refused.
  send(s, event({ at: 2, session_id: "other", runtime: { model: "x" } }));
  send(s, event({ at: 3, owner_pid: 9999, runtime: { model: "y" } }));
  expect(runtime(s)?.model).toBe("m1");
});

test("a release applies no runtime and leaves no row", () => {
  const s = store();
  send(s, event({ at: 1, runtime: { model: "m1" } }));
  send(s, event({ event: "session_end", reason: "other", at: 2, runtime: { model: "z" } }));
  expect(s.localPanes()[0]?.agent).toBeUndefined();
});

test("a pi row, live or store-free, is untouched by inbox runtime", () => {
  const live = store();
  live.claimAgent({
    location,
    owner_pid: PI,
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
  const agentId = live.localPanes()[0]?.agent?.agent_id as string;
  live.setRuntime({ agent_id: agentId, owner_pid: PI, model: "pi-model" });
  expect(writeInboxEvent(event({ runtime: { model: "hook" } }))).toBe(true);
  drain(live, [SERVER, OWNER, PI]);
  expect(runtime(live)?.model).toBe("pi-model");
});

test("a store-free pi inbox row takes no hook runtime", () => {
  const s = store();
  send(s, event({ harness: "pi", at: 1, runtime: { model: "hook" } }));
  expect(s.localPanes()[0]?.agent).toBeDefined();
  expect(runtime(s)?.model).toBeNull();
});

test("an owner mismatch writes no runtime", () => {
  const s = store();
  send(s, event({ at: 1, runtime: { model: "m1" } }));
  const agentId = s.localPanes()[0]?.agent?.agent_id as string;
  expect(s.setRuntime({ agent_id: agentId, owner_pid: 1, model: "bad" })).toBe(false);
  expect(runtime(s)?.model).toBe("m1");
});

test("an event file without runtime still drains", () => {
  const s = store();
  const { runtime: _none, ...bare } = event({ event: "prompt_submitted" });
  expect(parseInboxEvent(JSON.stringify(bare))).toMatchObject({ v: 1, event: "prompt_submitted" });
  send(s, bare as InboxEvent);
  expect(s.localPanes()[0]?.agent).toBeDefined();
  expect(runtime(s)?.model).toBeNull();
});

test("a remote worker's event carries no hook runtime", () => {
  const write = placeHarnessHook(
    "claude",
    { hook_event_name: "SessionStart", session_id: "s", model: "m" },
    {
      table: new Map([
        [11, { pid: 11, ppid: 10, started: null, args: "node murmur hook claude" }],
        [10, { pid: 10, ppid: 1, started: null, args: "claude" }],
      ]),
      self: 11,
      env: { MU_REMOTE_KEY: "k" },
      now: 1,
    },
  );
  expect(write?.area).toBe("remote");
  expect(write?.event).not.toHaveProperty("runtime");
});
