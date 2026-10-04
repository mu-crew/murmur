import { expect, test } from "vitest";
import { visibleWidth } from "../src/ansi.js";
import { DASH_GLYPH } from "../src/dash-paint.js";
import { type DashPrefs, DEFAULT_DASH_PREFS } from "../src/dash-prefs.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import {
  moveSidepanelSelection,
  type SidepanelRow,
  sidepanelCompactLine,
  sidepanelContentWidth,
  sidepanelResizeTarget,
  sidepanelRows,
  sidepanelWidth,
  sidepanelWindow,
} from "../src/sidepanel-view.js";
import type { PaneView } from "../src/view.js";

function pane(over: Partial<PaneView> = {}): PaneView {
  return {
    host_id: "H",
    host: "localhost",
    local: true,
    server: { kind: "default" },
    pane: asPaneId("%1"),
    session: asSessionId("$0"),
    window: asWindowId("@0"),
    session_name: "session",
    window_name: "window",
    activity: "running",
    attention: [],
    freshness: "fresh",
    agent_id: "a-1",
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
    updated_at: 0,
    snapshot_at: null,
    fetched_at: null,
    attached_pane: null,
    ...over,
  };
}

function prefs(over: Partial<DashPrefs> = {}): DashPrefs {
  return { ...DEFAULT_DASH_PREFS, hidden_states: [], ...over };
}

test("row keys distinguish identical pane ids on different tmux servers", () => {
  const rows = sidepanelRows(
    [pane(), pane({ server: { kind: "label", value: "mule" } })],
    prefs(),
    1_000,
  );

  expect(rows.map((row) => row.key)).toEqual([
    '["H","default",null,"%1"]',
    '["H","label","mule","%1"]',
  ]);
});

test("rows name the agent, rendered state, host, age, and workstream", () => {
  const [row] = sidepanelRows([pane()], prefs(), 120_000);
  expect(row).toEqual({
    key: '["H","default",null,"%1"]',
    name: "worker-1",
    state: "running",
    icon: DASH_GLYPH.running,
    facts: "running · here · 2m",
    host: "here",
    age: "2m",
    stream: "murmur",
  });

  const [remote] = sidepanelRows(
    [
      pane({
        host_id: "R",
        host: "devbox",
        local: false,
        pane: asPaneId("%2"),
        agent_name: "reviewer-1",
        workstream: null,
        session_name: "review",
        updated_at: null,
      }),
    ],
    prefs(),
    120_000,
  );
  expect(remote).toMatchObject({
    key: '["R","default",null,"%2"]',
    facts: "running · devbox",
    stream: "review",
  });
});

test.each([
  ["priority" as const, ["%3", "%1", "%2"]],
  ["node" as const, ["%1", "%2", "%3"]],
  ["age" as const, ["%2", "%3", "%1"]],
])("rows honor the saved %s sort through dashRows", (sort, expected) => {
  const rows = [
    pane({ pane: asPaneId("%1"), host: "here", updated_at: 100 }),
    pane({ pane: asPaneId("%2"), host: "alpha", local: false, updated_at: 900 }),
    pane({
      pane: asPaneId("%3"),
      host: "beta",
      local: false,
      updated_at: 500,
      attention: [{ kind: "blocked", requested_at: 500, message: "help" }],
    }),
  ];
  expect(sidepanelRows(rows, prefs({ sort }), 1_000).map((row) => JSON.parse(row.key)[3])).toEqual(
    expected,
  );
});

test("rows inherit crew, stale, and hidden-state gates from dashRows", () => {
  const rows = [
    pane({ pane: asPaneId("%1"), driver: "orchestrated" }),
    pane({
      pane: asPaneId("%2"),
      driver: "orchestrated",
      attention: [{ kind: "blocked", requested_at: 1, message: "help" }],
    }),
    pane({ pane: asPaneId("%3"), local: false, freshness: "stale" }),
    pane({ pane: asPaneId("%4"), activity: "stopped" }),
  ];

  expect(sidepanelRows(rows, prefs()).map((row) => row.key)).toEqual([
    '["H","default",null,"%2"]',
    '["H","default",null,"%3"]',
    '["H","default",null,"%4"]',
  ]);
  expect(sidepanelRows(rows, prefs({ crew: true })).map((row) => row.key)).toContain(
    '["H","default",null,"%1"]',
  );
  expect(sidepanelRows(rows, prefs({ hide_stale: true })).map((row) => row.key)).not.toContain(
    '["H","default",null,"%3"]',
  );
  expect(
    sidepanelRows(rows, prefs({ hidden_states: ["idle"] })).map((row) => row.key),
  ).not.toContain('["H","default",null,"%4"]');
});

test("selection wraps, jumps to edges, and handles an empty list", () => {
  expect(moveSidepanelSelection(2, "j", 3)).toBe(0);
  expect(moveSidepanelSelection(0, "k", 3)).toBe(2);
  expect(moveSidepanelSelection(1, "g", 3)).toBe(0);
  expect(moveSidepanelSelection(1, "G", 3)).toBe(2);
  expect(moveSidepanelSelection(4, "j", 0)).toBe(0);
});

test("the viewport spends four lines per full row and one per compact row", () => {
  expect(sidepanelWindow(0, 5, 2)).toEqual({ first: 0, shown: 0 });
  expect(sidepanelWindow(0, 5, 3)).toEqual({ first: 0, shown: 1 });
  expect(sidepanelWindow(0, 5, 7)).toEqual({ first: 0, shown: 2 });
  expect(sidepanelWindow(3, 5, 7)).toEqual({ first: 2, shown: 2 });
  expect(sidepanelWindow(4, 5, 99)).toEqual({ first: 0, shown: 5 });
  expect(sidepanelWindow(2, 0, 7)).toEqual({ first: 0, shown: 0 });
  expect(sidepanelWindow(3, 10, 7, true)).toEqual({ first: 0, shown: 7 });
  expect(sidepanelWindow(8, 10, 7, true)).toEqual({ first: 2, shown: 7 });
});

test("compact lines keep identity first and add columns as width allows", () => {
  const row = sidepanelRows(
    [pane({ agent_name: "worker-with-a-long-name", workstream: "murmur-sidebar" })],
    prefs(),
    120_000,
  )[0];
  if (!row) throw new Error("missing row");

  const narrow = sidepanelCompactLine(row, 24, true);
  expect(narrow.startsWith(`▸ ${DASH_GLYPH.running}  worker`)).toBe(true);
  expect(narrow).not.toContain("running");
  expect(visibleWidth(narrow)).toBe(24);

  expect(sidepanelCompactLine(row, 40, false)).toContain("here");
  expect(sidepanelCompactLine(row, 56, false)).toContain("murmur-sidebar");
});

test("width uses a quarter of the window within readable bounds", () => {
  expect(sidepanelWidth(0)).toBe(0);
  expect(sidepanelWidth(1)).toBe(0);
  expect(sidepanelWidth(24)).toBe(0);
  expect(sidepanelWidth(26)).toBe(25);
  expect(sidepanelWidth(100)).toBe(25);
  expect(sidepanelWidth(120)).toBe(30);
  expect(sidepanelWidth(160)).toBe(40);
  expect(sidepanelWidth(250)).toBe(40);

  for (let windowWidth = 0; windowWidth < 600; windowWidth += 1) {
    expect(sidepanelWidth(windowWidth)).toBeLessThanOrEqual(Math.max(0, windowWidth - 1));
  }
});

test("content width shrinks to the data rather than the window share", () => {
  const rows = sidepanelRows([pane({ agent_name: "w1", workstream: "mu" })], prefs(), 120_000);
  const header = "murmur · 1 agent";

  // Full rows: the widest of name, facts and stream, plus one spare column.
  expect(sidepanelContentWidth(rows, false, header)).toBe(
    Math.max(visibleWidth(header), visibleWidth("running · here · 2m")) + 1,
  );
  // Nothing to show still leaves a usable panel.
  expect(sidepanelContentWidth([], false, "m")).toBe(17);

  const long = sidepanelRows(
    [pane({ agent_name: "worker-with-a-long-name", workstream: "murmur-sidebar" })],
    prefs(),
    120_000,
  );
  const compact = sidepanelContentWidth(long, true, header);
  expect(visibleWidth(sidepanelCompactLine(long[0] as SidepanelRow, compact, true).trimEnd())).toBe(
    compact - 1,
  );
});

test("resizing grows at once and shrinks only past a small slack", () => {
  expect(sidepanelResizeTarget(25, 30)).toBe(30);
  expect(sidepanelResizeTarget(30, 29)).toBeNull();
  expect(sidepanelResizeTarget(30, 28)).toBeNull();
  expect(sidepanelResizeTarget(30, 27)).toBe(27);
  expect(sidepanelResizeTarget(30, 30)).toBeNull();
});
