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

function running(pane: string, window = "@1"): void {
  const claim = store.claimAgent({
    location: location(pane, window),
    owner_pid: process.pid,
    meta: META,
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
  const windows: [WindowId, RenderState | null][] = [];
  return {
    panes,
    windows,
    mux: fakeMux({
      panesInWindow: () => [asPaneId("%1"), asPaneId("%2"), asPaneId("%shell")],
      setPaneState: (pane, state) => void panes.push([pane, state]),
      setWindowState: (window, state) => void windows.push([window, state]),
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
  expect(states.windows).toEqual([["@1", "crashed"]]);
});

test("publishes idle for an agent pane but leaves the aggregate unset", () => {
  store.claimAgent({ location: location("%1"), owner_pid: process.pid, meta: META });
  const states = recorder();

  publishAgentStates(asWindowId("@1"), states.mux, store);

  expect(states.panes).toContainEqual(["%1", "idle"]);
  expect(states.windows).toEqual([["@1", null]]);
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
});
