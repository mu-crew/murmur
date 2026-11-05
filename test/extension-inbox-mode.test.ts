import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  type InboxModeApi,
  type InboxModeDeps,
  inboxMode,
  installInboxMode,
  messageText,
  sessionIdOf,
} from "../extension/inbox-mode.js";
import type { HookWrite } from "../src/hook.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { drainInbox, inboxDir, inboxKey, writeInboxEvent } from "../src/inbox.js";
import type { InboxEvent } from "../src/inbox-event.js";
import type { ProcessRow } from "../src/process-chain.js";
import { openStore, type Store } from "../src/store.js";
import { fakeMux } from "./helpers/fake-mux.js";

/**
 * pi's store-free mode (D15): with `MU_PI_CHANNEL=hooks` the extension writes
 * inbox events like a hook harness, and never loads the store.
 */

const SERVER = 7399;
const ROOT = 50;
const PI = 100;

const stores: Store[] = [];

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-inbox-mode-"));
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.unstubAllEnvs();
});

function table(): Map<number, ProcessRow> {
  return new Map([
    [PI, { pid: PI, ppid: ROOT, started: null, args: "/opt/pi/bin/pi-custom-build" }],
    [ROOT, { pid: ROOT, ppid: SERVER, started: null, args: "-zsh" }],
    [SERVER, { pid: SERVER, ppid: 1, started: null, args: "tmux new-session -d" }],
  ]);
}

/** The mode against a fake pi and a recorded write list. */
function rig(env: NodeJS.ProcessEnv = {}) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const writes: HookWrite[] = [];
  const deps: InboxModeDeps = {
    context: () => ({ table: table(), self: PI, env, now: 1_800_000_000_000 }),
    write: (write) => {
      writes.push(write);
      return true;
    },
  };
  const pi: InboxModeApi = { on: (event, handler) => void handlers.set(event, handler) };
  installInboxMode(pi, deps);
  const fire = (event: string, payload: unknown = {}, ctx: unknown = {}) =>
    handlers.get(event)?.(payload, ctx);
  const events = () =>
    writes.map((write) => {
      const { event, source, reason, message, text } = write.event;
      return {
        event,
        ...(source ? { source } : {}),
        ...(reason ? { reason } : {}),
        ...(message ? { message } : {}),
        ...(text ? { text } : {}),
      };
    });
  return { fire, writes, events };
}

const ctx = { sessionManager: { getSessionId: () => "pi-session-1" } };

test("only MU_PI_CHANNEL=hooks selects the mode", () => {
  expect(inboxMode({ MU_PI_CHANNEL: "hooks" })).toBe(true);
  expect(inboxMode({ MU_PI_CHANNEL: "ctl" })).toBe(false);
  expect(inboxMode({})).toBe(false);
});

test("pi's events map onto the vocabulary, placed in pi's own pane", () => {
  const { fire, writes, events } = rig({ MU_AGENT_NAME: "worker-4", MU_MANAGED_AGENT: "1" });
  fire("session_start", {}, ctx);
  fire("input", { text: "do it" });
  fire("agent_start");
  fire("message_end", {
    message: { role: "assistant", content: [{ type: "text", text: "Working" }] },
  });
  fire("message_end", {
    message: { role: "assistant", content: [{ type: "text", text: "CLOSE: done" }] },
  });
  fire("agent_settled");
  fire("ui_prompt_start", { kind: "confirm", title: "Run rm?" });
  fire("input");
  fire("message_end", {
    message: { role: "assistant", stopReason: "error", errorMessage: "overloaded", content: [] },
  });
  fire("agent_settled");
  fire("session_shutdown", { reason: "new" });
  fire("session_start", { reason: "new" }, ctx);
  fire("session_shutdown", { reason: "quit" });

  expect(events()).toEqual([
    // At load, before pi says anything: the pane is claimed at once, its turn kept.
    { event: "session_start", source: "resume" },
    { event: "session_start", source: "startup" },
    { event: "prompt_submitted" },
    { event: "continued" },
    { event: "turn_stopped", text: "CLOSE: done" },
    { event: "permission_requested", message: "Run rm?" },
    { event: "prompt_submitted" },
    { event: "turn_failed", message: "overloaded" },
    { event: "session_end", reason: "clear" },
    { event: "session_start", source: "clear" },
    { event: "session_end", reason: "quit" },
  ]);
  expect(writes[1]).toMatchObject({
    area: "inbox",
    event: {
      harness: "pi",
      server_pid: SERVER,
      root_pid: ROOT,
      owner_pid: PI,
      session_id: "pi-session-1",
      by: "harness",
      agent: { agent_name: "worker-4", driver: "orchestrated" },
    },
  });
});

test("pi nested in another harness, or outside tmux, writes nothing", () => {
  const writes: HookWrite[] = [];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const nested = table();
  nested.set(ROOT, { pid: ROOT, ppid: 60, started: null, args: "/bin/bash" });
  nested.set(60, { pid: 60, ppid: SERVER, started: null, args: "/opt/claude/bin/claude" });
  installInboxMode(
    { on: (event, handler) => void handlers.set(event, handler) },
    {
      context: () => ({ table: nested, self: PI, env: {}, now: 1 }),
      write: (write) => writes.push(write) > 0,
    },
  );
  handlers.get("session_start")?.({}, {});
  expect(writes).toEqual([]);
});

test("session ids and assistant text are read defensively", () => {
  expect(sessionIdOf(ctx)).toBe("pi-session-1");
  expect(sessionIdOf({ sessionManager: { getSessionFile: () => "/s/2026-11-05_abc.jsonl" } })).toBe(
    "2026-11-05_abc",
  );
  expect(
    sessionIdOf({
      sessionManager: {
        getSessionId: () => {
          throw new Error("stale ctx");
        },
      },
    }),
  ).toBeNull();
  expect(sessionIdOf(undefined)).toBeNull();
  expect(messageText({ role: "assistant", content: "plain" })).toBe("plain");
  expect(messageText({ role: "user", content: "mine" })).toBeNull();
  expect(
    messageText({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "x" },
        { type: "toolCall" },
        { type: "text", text: "a" },
      ],
    }),
  ).toBe("a");
});

test("the drain claims a pane for pi's own events even though a pi runs there", () => {
  const { fire, writes } = rig();
  fire("session_start", {}, ctx);
  fire("input");
  for (const write of writes) writeInboxEvent(write.event as InboxEvent);
  const store = openStore();
  stores.push(store);
  const location = {
    server: { kind: "default" as const },
    session: asSessionId("$0"),
    window: asWindowId("@0"),
    pane: asPaneId("%5"),
    session_name: null,
    window_name: null,
  };
  const host = {
    isAlive: () => true,
    serverFor: () => ({ kind: "default" as const }),
    panes: () => new Map([[ROOT, { location, focused: false }]]),
    // The pi IS in the pane's tree: an inbox event from any other harness stands aside.
    piRunsUnder: () => true,
  };
  expect(
    drainInbox(store, { host, mux: fakeMux({ panesInWindow: () => [asPaneId("%5")] }) }),
  ).toMatchObject({ applied: 3, ignored: 0 });
  expect(store.harnessState({ server: { kind: "default" }, pane: asPaneId("%5") })).toMatchObject({
    source: "inbox",
    harness: "pi",
    run_count: 1,
    session_id: "pi-session-1",
  });
});

test("/reload loads a fresh instance, and the pane keeps its turn and text", () => {
  const writes: HookWrite[] = [];
  const deps: InboxModeDeps = {
    context: () => ({ table: table(), self: PI, env: {}, now: 1_800_000_000_000 }),
    write: (write) => writes.push(write) > 0,
  };
  /** One factory run: pi loads the extension, for a process start or a runtime replacement. */
  const load = () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
    installInboxMode({ on: (event, handler) => void handlers.set(event, handler) }, deps);
    return (event: string, payload: unknown = {}) => handlers.get(event)?.(payload, ctx);
  };
  const first = load();
  first("session_start", { reason: "startup" });
  first("input");
  first("message_end", {
    message: { role: "assistant", content: [{ type: "text", text: "CLOSE: done" }] },
  });
  first("agent_settled");
  first("session_shutdown", { reason: "reload" });
  const second = load();
  second("session_start", { reason: "reload" });

  for (const write of writes) writeInboxEvent(write.event as InboxEvent);
  const store = openStore();
  stores.push(store);
  const location = {
    server: { kind: "default" as const },
    session: asSessionId("$0"),
    window: asWindowId("@0"),
    pane: asPaneId("%5"),
    session_name: null,
    window_name: null,
  };
  const host = {
    isAlive: () => true,
    serverFor: () => ({ kind: "default" as const }),
    panes: () => new Map([[ROOT, { location, focused: false }]]),
    piRunsUnder: () => true,
  };
  expect(
    drainInbox(store, { host, mux: fakeMux({ panesInWindow: () => [asPaneId("%5")] }) }),
  ).toMatchObject({ applied: 7, ignored: 0 });
  expect(store.harnessState({ server: { kind: "default" }, pane: asPaneId("%5") })).toMatchObject({
    harness: "pi",
    run_count: 1,
    last_text: "CLOSE: done",
  });
});

// --- the extension itself -------------------------------------------------

test("in the store-free mode the extension never loads the store, claims or asks tmux", async () => {
  vi.stubEnv("MU_PI_CHANNEL", "hooks");
  vi.stubEnv("TMUX", `/tmp/tmux-1000/default,${SERVER},0`);
  vi.stubEnv("TMUX_PANE", "%5");
  let storeImported = 0;
  const tmuxCalls: string[] = [];
  vi.doMock("../extension/store.js", () => {
    storeImported += 1;
    return { loadIdentity: () => ({}), openStore: () => ({}) };
  });
  const started = "Wed Nov  5 10:00:00 2026";
  vi.doMock("node:child_process", () => ({
    execFileSync: (command: string) => {
      if (command !== "ps") {
        tmuxCalls.push(command);
        return "";
      }
      return [
        `${process.pid} ${ROOT} ${started} node /opt/pi/dist/cli.js`,
        `${ROOT} ${SERVER} ${started} -zsh`,
        `${SERVER} 1 ${started} tmux new-session -d`,
      ].join("\n");
    },
  }));
  vi.doMock("../src/mux.js", async (original) => {
    const real = (await original()) as Record<string, unknown>;
    const record = (name: string) => () => {
      tmuxCalls.push(name);
      return null;
    };
    return {
      ...real,
      tmux: {
        currentWindow: record("currentWindow"),
        currentView: record("currentView"),
        panesInWindow: record("panesInWindow"),
        setWindowState: record("setWindowState"),
        setPaneState: record("setPaneState"),
        setPaneLabel: record("setPaneLabel"),
      },
    };
  });
  try {
    vi.resetModules();
    const { default: murmurPi } = await import("../extension/murmur-pi.js");
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    murmurPi({
      on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) =>
        handlers.set(event, handler),
      events: { on: () => undefined },
    } as never);
    // Only the vocabulary's events are registered: no runtime reporting.
    expect([...handlers.keys()].sort()).toEqual([
      "agent_settled",
      "agent_start",
      "input",
      "message_end",
      "session_shutdown",
      "session_start",
      "ui_prompt_start",
    ]);
    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("input")?.({}, {});
    await handlers.get("agent_settled")?.({}, {});
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(storeImported).toBe(0);
    expect(tmuxCalls).toEqual([]);
    const pane = join(inboxDir(), inboxKey(SERVER, ROOT));
    const written = readdirSync(pane)
      .sort()
      .map((file) => JSON.parse(readFileSync(join(pane, file), "utf8")) as InboxEvent);
    expect(written.map((event) => [event.event, event.harness, event.owner_pid])).toEqual([
      ["session_start", "pi", process.pid],
      ["session_start", "pi", process.pid],
      ["prompt_submitted", "pi", process.pid],
      ["turn_stopped", "pi", process.pid],
    ]);
  } finally {
    vi.doUnmock("../extension/store.js");
    vi.doUnmock("node:child_process");
    vi.doUnmock("../src/mux.js");
    vi.resetModules();
  }
});
