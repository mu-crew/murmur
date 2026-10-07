import { agentLabel } from "./agents.js";
import { visibleWidth } from "./ansi-width.js";
import { DASH_GLYPH, hostColor } from "./dash-paint.js";
import type { DashPrefs } from "./dash-prefs.js";
import { type CompactRowLayout, compactRowLayout, compactRowParts } from "./dash-tick.js";
import { dashRows } from "./dash-view.js";
import { age, type PaneView, pendingSummary, type RenderState, renderState } from "./view.js";

export function sidepanelPaneKey(pane: PaneView): string {
  return JSON.stringify([
    pane.host_id,
    pane.server.kind,
    pane.server.kind === "default" ? null : pane.server.value,
    pane.pane,
  ]);
}

export type SidepanelRow = {
  key: string;
  state: RenderState;
  icon: string;
  name: string;
  facts: string;
  host: string;
  /** The host's accent, the same on every surface. */
  hostColor: string;
  age: string;
  stream: string | null;
};

export function sidepanelRows(
  panes: PaneView[],
  prefs: DashPrefs,
  now = Date.now(),
): SidepanelRow[] {
  return dashRows(panes, prefs, now).map((pane) => {
    const state = renderState(pane);
    const elapsed = age(pane.updated_at === null ? null : now - pane.updated_at);
    const host = pane.local ? "here" : pane.host;
    return {
      key: sidepanelPaneKey(pane),
      state,
      icon: DASH_GLYPH[state],
      name: agentLabel(pane),
      facts: [state, pendingSummary(pane), host, elapsed].filter(Boolean).join(" · "),
      host,
      hostColor: hostColor(pane.host),
      age: elapsed,
      stream: pane.workstream ?? pane.session_name,
    };
  });
}

function compactFields(row: SidepanelRow) {
  return {
    state: row.icon,
    agent: row.name,
    host: row.host,
    stream: row.stream ?? "",
    flags: "",
    age: row.age,
    summary: "",
  };
}

export function sidepanelCompactLayout(
  rows: readonly SidepanelRow[],
  width: number,
): CompactRowLayout {
  return compactRowLayout(rows.map(compactFields), width);
}

export function sidepanelCompactLine(
  row: SidepanelRow,
  width: number,
  selected: boolean,
  layout = sidepanelCompactLayout([row], width),
): string {
  const { before, host, after } = sidepanelCompactParts(row, width, selected, layout);
  return before + host + after;
}

/** The compact line split around its host cell, for coloring the host alone. */
export function sidepanelCompactParts(
  row: SidepanelRow,
  width: number,
  selected: boolean,
  layout = sidepanelCompactLayout([row], width),
) {
  return compactRowParts(compactFields(row), layout, selected ? "▸ " : "  ");
}

export function moveSidepanelSelection(
  selected: number,
  key: "j" | "k" | "g" | "G",
  total: number,
): number {
  if (total <= 0) return 0;
  if (key === "g") return 0;
  if (key === "G") return total - 1;
  return (selected + (key === "j" ? 1 : total - 1)) % total;
}

export function sidepanelWindow(
  selected: number,
  total: number,
  availableRows: number,
  compact = false,
): { first: number; shown: number } {
  const shown = Math.min(
    Math.max(0, total),
    Math.max(0, compact ? availableRows : Math.floor((availableRows + 1) / 4)),
  );
  if (shown === 0) return { first: 0, shown: 0 };
  const bounded = Math.min(Math.max(0, selected), total - 1);
  return { first: Math.min(Math.max(0, bounded - shown + 1), total - shown), shown };
}

export const SIDEPANEL_MIN_WIDTH = 16;

/**
 * The columns the panel's content needs, so it can shrink to fit instead of
 * padding a fixed share of the window with blank space. One spare column keeps
 * the longest line off the pane border.
 */
export function sidepanelContentWidth(
  rows: readonly SidepanelRow[],
  compact: boolean,
  header: string,
): number {
  let lines: number[];
  if (compact) {
    const { widths, columns } = sidepanelCompactLayout(rows, Number.MAX_SAFE_INTEGER);
    const cells = [widths.state, widths.agent, ...columns.map((column) => widths[column])];
    lines = rows.length ? [2 + cells.reduce((a, b) => a + b, 0) + 2 * (cells.length - 1)] : [];
  } else {
    lines = rows.flatMap((row) => [
      visibleWidth(`${row.icon} ${row.name}`),
      visibleWidth(row.facts),
      visibleWidth(row.stream ?? ""),
    ]);
  }
  return Math.max(SIDEPANEL_MIN_WIDTH, visibleWidth(header), ...lines) + 1;
}

/**
 * Whether to ask tmux for a new width. Grows at once, since growing is what
 * stops clipping; shrinks only past a small slack so an age ticking from `9m`
 * to `10m` and back does not resize the layout every redraw.
 */
export function sidepanelResizeTarget(current: number, wanted: number): number | null {
  if (wanted > current || current - wanted > 2) return wanted;
  return null;
}

export function sidepanelWidth(windowWidth: number): number {
  const available = Math.max(0, Math.floor(windowWidth) - 1);
  if (available < 25) return 0;
  return Math.min(available, Math.max(25, Math.min(40, Math.floor(windowWidth * 0.25))));
}
