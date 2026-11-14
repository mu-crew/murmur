// The harness tag at real, narrow widths. The dash App reads its size from
// process.stdout (useWindowSize), not from renderToString's `columns`, so this
// file drives the real stdout dimensions. FORCE_COLOR makes ink emit SGR codes.
const forced = vi.hoisted(() => {
  process.env.FORCE_COLOR = "3";
  return true;
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToString } from "ink";
import { createElement } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { visibleWidth } from "../src/ansi-width.js";
import { App as DashApp } from "../src/cli/dash.js";
import { App as SidepanelApp } from "../src/cli/sidepanel.js";
import { DEFAULT_DASH_PREFS } from "../src/dash-prefs.js";
import type { DashStore } from "../src/dash-store.js";
import { compactRow, compactRowLayout } from "../src/dash-tick.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import type { Status } from "../src/status.js";
import type { PaneView } from "../src/view.js";

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const plain = (text: string) => text.replace(ANSI, "");

function pane(over: Partial<PaneView> = {}): PaneView {
  return {
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
    harness: "pi",
    driver: "human",
    model: "model-1",
    provider: null,
    effort: "medium",
    provider_effort: null,
    context_pct: 35,
    context_tokens: null,
    context_window: null,
    usage: null,
    pending: null,
    updated_at: 1,
    snapshot_at: null,
    fetched_at: null,
    attached_pane: null,
    ...over,
  };
}

const counts = { crashed: 0, error: 0, blocked: 0, done: 0, running: 1, waiting: 0, idle: 0 };
const view = (panes: PaneView[]): Status => ({
  counts,
  orchestrated_counts: counts,
  panes,
  peers: [],
});
const dashStore = { store: {}, generation: { dev: 0n, ino: 0n } } as unknown as DashStore;

let configDir: string;
const saved = { columns: process.stdout.columns, rows: process.stdout.rows };
const env = { MURMUR_CONFIG_DIR: process.env.MURMUR_CONFIG_DIR };

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "hr-"));
  writeFileSync(join(configDir, "dash.toml"), "compact = true\n");
  process.env.MURMUR_CONFIG_DIR = configDir;
});
afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  if (env.MURMUR_CONFIG_DIR === undefined) delete process.env.MURMUR_CONFIG_DIR;
  else process.env.MURMUR_CONFIG_DIR = env.MURMUR_CONFIG_DIR;
  for (const key of ["columns", "rows"] as const) {
    Object.defineProperty(process.stdout, key, {
      value: saved[key],
      configurable: true,
      writable: true,
    });
  }
});

function dashFrame(panes: PaneView[], columns: number): string {
  for (const [key, value] of [
    ["columns", columns],
    ["rows", 24],
  ] as const) {
    Object.defineProperty(process.stdout, key, { value, configurable: true, writable: true });
  }
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    return renderToString(createElement(DashApp, { dashStore, initial: view(panes) }), { columns });
  } finally {
    stderr.mockRestore();
  }
}

function sidepanelFrame(panes: PaneView[], columns: number, compact: boolean): string {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    return renderToString(
      createElement(SidepanelApp, {
        dashStore,
        initial: view(panes),
        origin: { window: asWindowId("@1"), pane: asPaneId("%9") },
        initialPrefs: { ...DEFAULT_DASH_PREFS, compact },
        now: 120_001,
        dimensions: { columns, rows: 12 },
      }),
    );
  } finally {
    stderr.mockRestore();
  }
}

const dimTag = (tag: string) => new RegExp(`${ESC}\\[2m${tag}${ESC}\\[22m`);
const fits = (frame: string, width: number) => {
  for (const line of plain(frame).split("\n"))
    expect(visibleWidth(line)).toBeLessThanOrEqual(width);
};

test("the harness forced colour is on", () => {
  expect(forced).toBe(true);
  expect(dashFrame([pane()], 80)).toMatch(ANSI);
});

for (const name of ["worker-with-a-long-name", "工作者-とても長い名前-에이전트-with-a-long-name"]) {
  for (const columns of [30, 40, 80]) {
    for (const harness of ["pi", "claude"] as const) {
      test(`dash full card at ${columns} columns keeps a dim ${harness} tag with a long name`, () => {
        writeFileSync(join(configDir, "dash.toml"), "compact = false\n");
        const frame = dashFrame([pane({ harness, agent_name: name })], columns);
        fits(frame, columns);
        expect(plain(frame)).toContain(` ${harness}`);
        expect(frame).toMatch(dimTag(` ${harness}`));
      });
    }
  }
}

for (const columns of [30, 40]) {
  for (const harness of ["pi", "claude"] as const) {
    test(`dash compact at ${columns} columns keeps a dim ${harness} tag within the width`, () => {
      const frame = dashFrame([pane({ harness })], columns);
      fits(frame, columns);
      expect(plain(frame)).toContain(harness);
      expect(frame).toMatch(dimTag(harness));
    });
  }
}

// A full facts line cannot hold "running · claude" in 15 columns; there only
// the short tag is asserted.
for (const [columns, compact] of [
  [16, false],
  [16, true],
  [25, true],
  [40, false],
  [40, true],
] as const) {
  for (const harness of ["pi", "claude"] as const) {
    if (columns === 16 && !compact && harness === "claude") continue;
    test(`sidepanel ${compact ? "compact" : "full"} at ${columns} columns keeps a dim ${harness} tag`, () => {
      const frame = sidepanelFrame([pane({ harness })], columns, compact);
      fits(frame, columns);
      expect(plain(frame)).toContain(harness);
      expect(frame).toMatch(dimTag(harness));
    });
  }
}

// Pre-change pi row == the row without the tag column (a null harness renders
// exactly the old row). Equal except the tag and the width it takes.
const fieldsOf = (tag: string) => ({
  state: "●",
  agent: "worker-1",
  tag,
  host: "⌂",
  stream: "murmur",
  flags: "",
  age: "2m",
  summary: "model-1 · medium · 35.0%",
});

test("a pi compact row equals the pre-change row except the tag and its width", () => {
  let compared = 0;
  for (let width = 20; width <= 120; width += 1) {
    const before = fieldsOf("");
    const after = fieldsOf("pi");
    const l0 = compactRowLayout([before], width);
    const l1 = compactRowLayout([after], width);
    const old = compactRow(before, l0, "  ");
    const now = compactRow(after, l1, "  ");
    expect(visibleWidth(now)).toBe(width);
    // Every width: fits, and the tag is present.
    expect(plain(now)).toContain("pi");
    if (width < 50) continue;
    // REVISION 4: from 50 columns a pi row keeps every pre-change field.
    expect(l1.columns.join()).toBe(`tag,${l0.columns.join()}`);
    // Take the tag cell (and its separator) out; what is left is the old row,
    // clipped on the right only.
    const stripped = now.replace(/ {2}pi {2}/, "  ").trimEnd();
    expect(old.startsWith(stripped.replace(/…$/, ""))).toBe(true);
    if (width >= 80) expect(stripped).toBe(old.trimEnd());
    compared += 1;
  }
  // Generous widths and the width where the tag's columns clip the summary.
  expect(compared).toBeGreaterThan(40);
  const boundary = compactRow(fieldsOf("pi"), compactRowLayout([fieldsOf("pi")], 50), "  ");
  expect(plain(boundary)).toContain("pi");
  expect(visibleWidth(boundary)).toBe(50);
});
