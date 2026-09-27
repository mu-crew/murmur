import { expect, test } from "vitest";
import {
  activateSidepanelSelection,
  reconcileSidepanelSelection,
  routeSidepanelInput,
  toggleSidepanelCrew,
} from "../src/cli/sidepanel.js";
import { DEFAULT_DASH_PREFS } from "../src/dash-prefs.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import type { SidepanelRow } from "../src/sidepanel-view.js";
import type { Store } from "../src/store.js";
import type { PaneView } from "../src/view.js";

const store = {} as Store;
const origin = { window: asWindowId("@1"), pane: asPaneId("%9") };
const pane = {
  host_id: "here",
  host: "here",
  local: true,
  server: { kind: "default" },
  pane: asPaneId("%1"),
  session: asSessionId("$1"),
  window: asWindowId("@1"),
  session_name: "work",
  window_name: null,
  activity: "running",
  attention: [],
  freshness: "fresh",
  agent_id: "agent-1",
  agent_name: "worker-1",
  pi_session: null,
  workstream: "murmur",
  role: null,
  cli: "pi",
  driver: "human",
  model: null,
  provider: null,
  effort: null,
  provider_effort: null,
  context_pct: null,
  context_tokens: null,
  context_window: null,
  usage: null,
  updated_at: 1,
  snapshot_at: null,
  fetched_at: null,
  attached_pane: null,
} satisfies PaneView;

test("a failed jump leaves the source panel open", async () => {
  const events: string[] = [];
  const result = await activateSidepanelSelection(store, pane, origin, {
    jump: () => ({ ok: false, reason: "attach_failed", message: "nope" }),
    close: () => {
      events.push("close");
      return { ok: true };
    },
  });

  expect(result).toEqual({ close: false, error: "nope" });
  expect(events).toEqual([]);
});

test("a successful jump closes the captured source panel afterward", async () => {
  const events: string[] = [];
  const result = await activateSidepanelSelection(store, pane, origin, {
    jump: () => {
      events.push("jump");
      return { ok: true };
    },
    close: (window, panel) => {
      events.push(`close ${window} ${panel}`);
      return { ok: true };
    },
  });

  expect(events).toEqual(["jump", "close @1 %9"]);
  expect(result).toEqual({ close: true, error: null });
});

test("a close failure is reported after the successful jump", async () => {
  const result = await activateSidepanelSelection(store, pane, origin, {
    jump: () => ({ ok: true }),
    close: () => ({ ok: false, message: "layout failed" }),
  });

  expect(result).toEqual({ close: true, error: "layout failed" });
});

test.each([
  ["j", {}, true, { type: "move", key: "j" }],
  ["k", {}, true, { type: "move", key: "k" }],
  ["g", {}, true, { type: "move", key: "g" }],
  ["G", {}, true, { type: "move", key: "G" }],
  ["a", {}, true, { type: "crew" }],
  ["q", {}, true, { type: "close" }],
  ["c", { ctrl: true }, true, { type: "close" }],
  ["", { return: true }, true, { type: "activate" }],
  ["", { return: true }, false, { type: "none" }],
] as const)("routes %s input", (input, key, hasSelection, expected) => {
  expect(routeSidepanelInput(input, key, hasSelection)).toEqual(expected);
});

test("crew persistence keeps every other shared preference", () => {
  const prefs = {
    ...DEFAULT_DASH_PREFS,
    sort: "age" as const,
    hide_stale: true,
    hidden_states: ["done" as const],
    preview: 0.2,
    compact: true,
  };
  let saved = DEFAULT_DASH_PREFS;

  const updated = toggleSidepanelCrew(prefs, (next) => {
    saved = next;
  });

  expect(updated).toEqual({ ...prefs, crew: true });
  expect(saved).toEqual(updated);
});

function row(key: string): SidepanelRow {
  return { key, state: "running", icon: ">", name: key, facts: "running", stream: null };
}

test("selection follows its stable key when rows reorder", () => {
  expect(reconcileSidepanelSelection([row("B"), row("A")], "A", 0)).toEqual({
    key: "A",
    index: 1,
  });
});

test("a missing selection clamps to the nearest remaining row", () => {
  expect(reconcileSidepanelSelection([row("A"), row("B")], "gone", 9)).toEqual({
    key: "B",
    index: 1,
  });
  expect(reconcileSidepanelSelection([], "gone", 1)).toEqual({ key: null, index: 0 });
});
