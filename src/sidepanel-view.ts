import { agentLabel } from "./agents.js";
import { DASH_GLYPH } from "./dash-paint.js";
import type { DashPrefs } from "./dash-prefs.js";
import { dashRows } from "./dash-view.js";
import { age, type PaneView, type RenderState, renderState } from "./view.js";

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
    return {
      key: sidepanelPaneKey(pane),
      state,
      icon: DASH_GLYPH[state],
      name: agentLabel(pane),
      facts: [state, pane.local ? "here" : pane.host, elapsed].filter(Boolean).join(" · "),
      stream: pane.workstream ?? pane.session_name,
    };
  });
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

export function sidepanelWidth(windowWidth: number): number {
  const available = Math.max(0, Math.floor(windowWidth) - 1);
  if (available < 25) return 0;
  return Math.min(available, Math.max(25, Math.min(40, Math.floor(windowWidth * 0.1))));
}
