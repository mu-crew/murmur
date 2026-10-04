import { Box, renderToString } from "ink";
import { createElement } from "react";
import { expect, test } from "vitest";
import {
  activateSidepanelSelection,
  reconcileSidepanelSelection,
  routeSidepanelInput,
  SidepanelHelp,
  selectedSidepanelPane,
  sidepanelHelpSections,
  toggleSidepanelCompact,
  toggleSidepanelCrew,
} from "../src/cli/sidepanel.js";
import { DEFAULT_DASH_PREFS } from "../src/dash-prefs.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { type SidepanelRow, sidepanelRows } from "../src/sidepanel-view.js";
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
  pending: null,
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

test("a close failure is reported and keeps the renderer open", async () => {
  const result = await activateSidepanelSelection(store, pane, origin, {
    jump: () => ({ ok: true }),
    close: () => ({ ok: false, message: "layout failed" }),
  });

  expect(result).toEqual({ close: false, error: "layout failed" });
});

test("selection and activation distinguish the same pane id on two tmux servers", async () => {
  const first = pane;
  const second = {
    ...pane,
    server: { kind: "label", value: "mule" } as const,
    agent_name: "worker-2",
  };
  const rows = sidepanelRows([first, second], DEFAULT_DASH_PREFS, 1_000);
  const selected = selectedSidepanelPane([first, second], rows, 1);
  const jumped: PaneView[] = [];

  expect(selected).toBe(second);
  if (!selected) throw new Error("missing selected pane");
  await activateSidepanelSelection(store, selected, origin, {
    jump: (_store, target) => {
      jumped.push(target);
      return { ok: false, reason: "attach_failed", message: "stop" };
    },
  });
  expect(jumped).toEqual([second]);
});

test.each([
  ["j", {}, true, { type: "move", key: "j" }],
  ["", { downArrow: true }, true, { type: "move", key: "j" }],
  ["k", {}, true, { type: "move", key: "k" }],
  ["", { upArrow: true }, true, { type: "move", key: "k" }],
  ["g", {}, true, { type: "move", key: "g" }],
  ["", { home: true }, true, { type: "move", key: "g" }],
  ["G", {}, true, { type: "move", key: "G" }],
  ["", { end: true }, true, { type: "move", key: "G" }],
  ["a", {}, true, { type: "crew" }],
  ["c", {}, true, { type: "compact" }],
  ["?", {}, true, { type: "help-open" }],
  ["q", {}, true, { type: "close" }],
  ["c", { ctrl: true }, true, { type: "close" }],
  ["", { return: true }, true, { type: "activate" }],
  ["", { return: true }, false, { type: "none" }],
] as const)("routes %s input", (input, key, hasSelection, expected) => {
  expect(routeSidepanelInput(false, input, key, hasSelection)).toEqual(expected);
});

test("the help overlay closes with question mark or escape and swallows other keys", () => {
  expect(routeSidepanelInput(true, "?", {}, true)).toEqual({ type: "help-close" });
  expect(routeSidepanelInput(true, "", { escape: true }, true)).toEqual({ type: "help-close" });
  expect(routeSidepanelInput(true, "q", {}, true)).toEqual({ type: "none" });
});

test("help lists every side panel key", () => {
  expect(sidepanelHelpSections({ crew: false, compact: true })).toEqual([
    {
      title: "navigation",
      hints: [
        { chord: "j/↓", label: "next" },
        { chord: "k/↑", label: "previous" },
        { chord: "g/home", label: "top" },
        { chord: "G/end", label: "bottom" },
        { chord: "enter", label: "jump" },
        { chord: "click", label: "select" },
        { chord: "2click", label: "jump" },
        { chord: "wheel", label: "move" },
      ],
    },
    {
      title: "view",
      hints: [
        { chord: "a", label: "crew only", value: "off" },
        { chord: "c", label: "compact", value: "on" },
      ],
    },
    {
      title: "panel",
      hints: [
        { chord: "q/^c", label: "close" },
        { chord: "?/esc", label: "close this help" },
      ],
    },
  ]);
});

test("help fits the default 27-column panel without truncation", () => {
  const output = renderToString(
    createElement(
      Box,
      { width: 27, height: 18 },
      createElement(SidepanelHelp, { prefs: DEFAULT_DASH_PREFS }),
    ),
  );

  expect(output).toContain("j/↓");
  expect(output).toContain("k/↑");
  expect(output).toContain("g/home");
  expect(output).toContain("G/end");
  expect(output).not.toContain("…");
});

test("compact persistence updates the shared dashboard preference", () => {
  const prefs = { ...DEFAULT_DASH_PREFS, sort: "age" as const, crew: true };
  let saved = DEFAULT_DASH_PREFS;

  const updated = toggleSidepanelCompact(prefs, (next) => {
    saved = next;
  });

  expect(updated).toEqual({ ...prefs, compact: true });
  expect(saved).toEqual(updated);
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
  return {
    key,
    state: "running",
    icon: ">",
    name: key,
    facts: "running",
    host: "here",
    age: "",
    stream: null,
  };
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
