import { execFileSync } from "node:child_process";
import { asPaneId, asWindowId, type PaneId, type WindowId } from "./ids.js";
import { reflowSidepanelAdded, reflowSidepanelRemoved } from "./sidepanel-layout.js";
import { sidepanelWidth } from "./sidepanel-view.js";

export const SIDEPANEL_ROLE_OPTION = "@murmur_role";
export const SIDEPANEL_ROLE = "sidepanel";

export type SidepanelOrigin = { window: WindowId; pane: PaneId };
export type SidepanelResult = { ok: true } | { ok: false; message: string };
type TmuxResult = { ok: boolean; stdout: string; error: string };

export interface SidepanelTmux {
  run(args: string[]): TmuxResult;
}

const productionTmux: SidepanelTmux = {
  run(args) {
    try {
      return {
        ok: true,
        stdout: execFileSync("tmux", args, {
          encoding: "utf8",
          timeout: 3000,
          stdio: ["ignore", "pipe", "pipe"],
        }).trim(),
        error: "",
      };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stderr?: string | Buffer };
      const stderr =
        typeof failure.stderr === "string" ? failure.stderr : failure.stderr?.toString();
      return { ok: false, stdout: "", error: stderr?.trim() || failure.message };
    }
  },
};

function detail(prefix: string, result: TmuxResult): string {
  return result.error ? `${prefix}: ${result.error}` : prefix;
}

function panelRows(window: WindowId, tmux: SidepanelTmux): PaneId[] | null {
  const result = tmux.run([
    "list-panes",
    "-t",
    window,
    "-F",
    `#{pane_id}\t#{${SIDEPANEL_ROLE_OPTION}}`,
  ]);
  if (!result.ok) return null;
  return result.stdout.split("\n").flatMap((line) => {
    const [pane, role] = line.split("\t");
    return pane && role === SIDEPANEL_ROLE ? [asPaneId(pane)] : [];
  });
}

export function sidepanelOrigin(
  env: NodeJS.ProcessEnv = process.env,
  tmux: SidepanelTmux = productionTmux,
): SidepanelOrigin | null {
  const rawPane = env.TMUX_PANE;
  if (!rawPane) return null;
  const result = tmux.run(["display-message", "-t", rawPane, "-p", "#{window_id}\t#{pane_id}"]);
  if (!result.ok) return null;
  const [window, pane, extra] = result.stdout.split("\t");
  if (!window || pane !== rawPane || extra !== undefined) return null;
  return { window: asWindowId(window), pane: asPaneId(pane) };
}

export function findSidepanel(
  window: WindowId,
  tmux: SidepanelTmux = productionTmux,
): PaneId | null {
  const panels = panelRows(window, tmux);
  return panels?.length === 1 ? (panels[0] ?? null) : null;
}

function rollback(panel: PaneId, tmux: SidepanelTmux): void {
  tmux.run(["kill-pane", "-t", panel]);
}

export function openSidepanel(
  origin: SidepanelOrigin,
  command: string[],
  tmux: SidepanelTmux = productionTmux,
): { ok: true; panel: PaneId } | { ok: false; message: string } {
  const widthResult = tmux.run(["display-message", "-t", origin.window, "-p", "#{window_width}"]);
  if (!widthResult.ok) {
    return { ok: false, message: detail("could not read tmux window width", widthResult) };
  }
  const rawWidth = Number(widthResult.stdout);
  const width = Number.isFinite(rawWidth) ? sidepanelWidth(rawWidth) : 0;
  if (width === 0) {
    return { ok: false, message: `tmux window ${origin.window} is too narrow for a side panel` };
  }

  const split = tmux.run([
    "split-window",
    "-hbf",
    "-l",
    String(width),
    "-t",
    origin.pane,
    "-d",
    "-P",
    "-F",
    "#{pane_id}",
    "--",
    ...command,
  ]);
  if (!split.ok) return { ok: false, message: detail("could not create side panel", split) };
  if (!/^%\d+$/.test(split.stdout)) {
    return { ok: false, message: "tmux returned an invalid side panel pane id" };
  }
  const panel = asPaneId(split.stdout);

  const marked = tmux.run(["set-option", "-p", "-t", panel, SIDEPANEL_ROLE_OPTION, SIDEPANEL_ROLE]);
  if (!marked.ok) {
    rollback(panel, tmux);
    return { ok: false, message: detail("could not mark side panel", marked) };
  }

  const layoutResult = tmux.run(["display-message", "-t", origin.window, "-p", "#{window_layout}"]);
  if (!layoutResult.ok) {
    rollback(panel, tmux);
    return { ok: false, message: detail("could not read tmux window layout", layoutResult) };
  }
  const layout = reflowSidepanelAdded(layoutResult.stdout, panel, width);
  if (!layout) {
    rollback(panel, tmux);
    return { ok: false, message: "could not reflow tmux window for side panel" };
  }
  const applied = tmux.run(["select-layout", "-t", origin.window, layout]);
  if (!applied.ok) {
    rollback(panel, tmux);
    return { ok: false, message: detail("could not apply side panel layout", applied) };
  }

  const focused = tmux.run(["select-pane", "-t", panel]);
  if (!focused.ok) {
    return {
      ok: false,
      message: detail("side panel opened but could not be focused", focused),
    };
  }
  return { ok: true, panel };
}

export function closeSidepanel(
  window: WindowId,
  panel: PaneId,
  tmux: SidepanelTmux = productionTmux,
): SidepanelResult {
  const identity = tmux.run([
    "display-message",
    "-t",
    panel,
    "-p",
    `#{window_id}\t#{pane_id}\t#{${SIDEPANEL_ROLE_OPTION}}`,
  ]);
  if (!identity.ok) return { ok: false, message: detail("could not verify side panel", identity) };
  const [actualWindow, actualPane, role] = identity.stdout.split("\t");
  if (actualWindow !== window || actualPane !== panel || role !== SIDEPANEL_ROLE) {
    return { ok: false, message: `pane ${panel} is not the side panel for window ${window}` };
  }

  const layoutResult = tmux.run(["display-message", "-t", window, "-p", "#{window_layout}"]);
  if (!layoutResult.ok) {
    return { ok: false, message: detail("could not read tmux window layout", layoutResult) };
  }
  const layout = reflowSidepanelRemoved(layoutResult.stdout, panel);
  if (!layout) return { ok: false, message: "could not reflow tmux window after side panel" };

  // tmux rejects the post-removal layout while the panel still exists. Queueing
  // both commands makes tmux kill it first. If select-layout then fails, tmux
  // cannot atomically recreate the pane; report the failure rather than hiding it.
  const closed = tmux.run(["kill-pane", "-t", panel, ";", "select-layout", "-t", window, layout]);
  return closed.ok
    ? { ok: true }
    : { ok: false, message: detail("could not close side panel", closed) };
}

export function toggleSidepanel(
  command: string[],
  env: NodeJS.ProcessEnv = process.env,
  tmux: SidepanelTmux = productionTmux,
): SidepanelResult {
  const origin = sidepanelOrigin(env, tmux);
  if (!origin) return { ok: false, message: "murmur sidepanel must run inside tmux" };
  const panels = panelRows(origin.window, tmux);
  if (panels === null) return { ok: false, message: "could not list panes in the current window" };
  if (panels.length > 1) {
    return { ok: false, message: `multiple side panels found in window ${origin.window}` };
  }
  const panel = panels[0];
  if (panel) return closeSidepanel(origin.window, panel, tmux);
  const opened = openSidepanel(origin, command, tmux);
  return opened.ok ? { ok: true } : opened;
}
