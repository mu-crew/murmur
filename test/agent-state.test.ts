import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { publishAgentStates } from "../src/agent-state.js";
import { asPaneId, asSessionId, asWindowId, type PaneId, type WindowId } from "../src/ids.js";
import { openStore, type Store } from "../src/store.js";
import type { AgentMeta, Location } from "../src/types.js";
import type { RenderState } from "../src/view.js";
import { fakeMux } from "./helpers/fake-mux.js";

let store: Store;

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-agent-state-"));
  store = openStore();
});

afterEach(() => {
  store.close();
});

function location(pane: string, window = "@1"): Location {
  return {
    server: { kind: "default" },
    session: asSessionId("$1"),
    window: asWindowId(window),
    pane: asPaneId(pane),
    session_name: null,
    window_name: null,
  };
}

const META: AgentMeta = {
  agent_name: "worker-1",
  pi_session: null,
  workstream: "murmur",
  role: null,
  cli: "pi",
  driver: "orchestrated",
};

function running(pane: string, window = "@1", meta: AgentMeta = META): void {
  const claim = store.claimAgent({
    location: location(pane, window),
    owner_pid: process.pid,
    meta,
  });
  if (claim.outcome === "refused") throw new Error("refused");
  store.setActivity({
    agent_id: claim.agent_id,
    owner_pid: process.pid,
    activity: "running",
    location: location(pane, window),
  });
}

function recorder() {
  const panes: [PaneId, RenderState | null][] = [];
  const labels: [PaneId, string | null][] = [];
  const windows: [WindowId, RenderState | null, boolean | undefined][] = [];
  return {
    panes,
    labels,
    windows,
    mux: fakeMux({
      panesInWindow: () => [asPaneId("%1"), asPaneId("%2"), asPaneId("%shell")],
      setPaneState: (pane, state) => void panes.push([pane, state]),
      setPaneLabel: (pane, label) => void labels.push([pane, label]),
      setWindowState: (window, state, _server, hasAgent) =>
        void windows.push([window, state, hasAgent]),
    }),
  };
}

test("publishes each pane's full state and the window's strongest state", () => {
  running("%1");
  running("%2");
  store.recordCrash(location("%2"));
  const states = recorder();

  expect(publishAgentStates(asWindowId("@1"), states.mux, store)).toBe(true);

  expect(states.panes).toEqual([
    ["%1", "running"],
    ["%2", "crashed"],
    ["%shell", null],
  ]);
  expect(states.labels).toEqual([
    ["%1", "worker-1"],
    ["%2", "worker-1"],
    ["%shell", null],
  ]);
  expect(states.windows).toEqual([["@1", "crashed", true]]);
});

test("pane labels fall back through pi session and cli", () => {
  running("%1", "@1", { ...META, agent_name: null, pi_session: "session-1" });
  running("%2", "@1", { ...META, agent_name: null, pi_session: null, cli: "codex" });
  const states = recorder();

  publishAgentStates(asWindowId("@1"), states.mux, store);

  expect(states.labels).toEqual([
    ["%1", "session-1"],
    ["%2", "codex"],
    ["%shell", null],
  ]);
});

test("publishes idle for an agent pane but leaves the aggregate unset", () => {
  store.claimAgent({ location: location("%1"), owner_pid: process.pid, meta: META });
  const states = recorder();

  publishAgentStates(asWindowId("@1"), states.mux, store);

  expect(states.panes).toContainEqual(["%1", "idle"]);
  expect(states.windows).toEqual([["@1", null, true]]);
});

test("does not guess when tmux cannot list the window", () => {
  running("%1");
  const states = recorder();
  const mux = fakeMux({
    panesInWindow: () => null,
    setPaneState: states.mux.setPaneState,
    setWindowState: states.mux.setWindowState,
  });

  expect(publishAgentStates(asWindowId("@1"), mux, store)).toBe(false);
  expect(states.panes).toEqual([]);
  expect(states.windows).toEqual([]);
  expect(states.labels).toEqual([]);
});

function sessionRecorder(sessionPanes: string[] | null) {
  const sessions: [string, RenderState | null][] = [];
  const counts: { totals: Record<RenderState, number>; crew: number }[] = [];
  return {
    sessions,
    counts,
    mux: fakeMux({
      panesInWindow: () => [asPaneId("%1")],
      sessionPanes: () =>
        sessionPanes === null
          ? null
          : { session: asSessionId("$1"), panes: sessionPanes.map(asPaneId) },
      setSessionState: (session, state) => void sessions.push([session, state]),
      setStateCounts: (value) => void counts.push(value),
    }),
  };
}

test("the session gets the strongest state across all its windows", () => {
  running("%1", "@1");
  running("%2", "@2");
  store.recordCrash(location("%2", "@2"));
  const states = sessionRecorder(["%1", "%2", "%shell"]);

  publishAgentStates(asWindowId("@1"), states.mux, store);

  expect(states.sessions).toEqual([["$1", "crashed"]]);
});

test("a later done does not replace a crashed session", () => {
  running("%1", "@1");
  running("%2", "@2");
  store.recordCrash(location("%2", "@2"));
  store.requestAttention({ kind: "done", location: location("%1"), message: "", source: "pi" });
  const states = sessionRecorder(["%1", "%2"]);

  publishAgentStates(asWindowId("@1"), states.mux, store);

  expect(states.sessions).toEqual([["$1", "crashed"]]);
});

test("a session with only idle agents is unset", () => {
  store.claimAgent({ location: location("%1"), owner_pid: process.pid, meta: META });
  const states = sessionRecorder(["%1"]);

  publishAgentStates(asWindowId("@1"), states.mux, store);

  expect(states.sessions).toEqual([["$1", null]]);
});

test("a session tmux cannot list keeps its state", () => {
  running("%1");
  const states = sessionRecorder(null);

  expect(publishAgentStates(asWindowId("@1"), states.mux, store)).toBe(true);

  expect(states.sessions).toEqual([]);
});

test("the pill counts match murmur status for this host", async () => {
  const { status, tmuxStatus } = await import("../src/status.js");
  const human = { ...META, driver: "human" as const };
  running("%1", "@1", human);
  running("%2", "@1", human);
  store.requestAttention({ kind: "blocked", location: location("%2"), message: "", source: "pi" });
  store.claimAgent({
    location: location("%3"),
    owner_pid: process.pid,
    meta: { ...META, driver: "orchestrated" },
  });
  running("%4");
  store.recordCrash(location("%4"));
  const states = sessionRecorder(["%1"]);

  publishAgentStates(asWindowId("@1"), states.mux, store);

  const [published] = states.counts;
  const lines = Object.entries(published?.totals ?? {})
    .filter(([, n]) => n > 0)
    .map(([state, n]) => `${state === "running" ? "working" : state}\t${n}\n`)
    .join("");
  const crew = published?.crew ? `crew\t${published.crew}\n` : "";
  const identity = { host_id: "HOST", display_name: "host" };
  // Human running and blocked count; the crew idle and crashed agents add a
  // crashed (a human must see it) and the crew total, not an idle.
  expect(lines + crew).toBe("crashed\t1\nblocked\t1\nworking\t1\ncrew\t2\n");
  expect(lines + crew).toBe(tmuxStatus(status(store, identity)));
});
