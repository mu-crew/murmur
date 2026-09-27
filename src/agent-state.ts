import type { WindowId } from "./ids.js";
import type { Mux } from "./mux.js";
import type { Store } from "./store.js";
import type { TmuxServer } from "./types.js";
import { RENDER_PRIORITY, type RenderState, renderState } from "./view.js";

function sameServer(left: TmuxServer, right: TmuxServer): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "default" || right.kind === "default") return true;
  return left.value === right.value;
}

/**
 * Publish murmur's state for one window: every pane gets its own state, and the
 * window gets the strongest non-idle state among those panes.
 *
 * Every writer calls this after changing activity or attention. A pane option
 * cannot be painted from the event that just happened, because that event may
 * be weaker than an existing fact on the pane: a `done` must not replace
 * `crashed`, and a running agent with a `blocked` request is still `blocked`.
 *
 * Returns false when tmux could not list the window. Unknown membership is not
 * evidence that the panes are empty, so nothing is cleared.
 */
export function publishAgentStates(
  window: WindowId,
  mux: Mux,
  store: Store,
  server: TmuxServer = { kind: "default" },
): boolean {
  const panes = mux.panesInWindow(window, server);
  if (panes === null) return false;

  const localPanes = store.localPanes().filter((pane) => sameServer(pane.server, server));
  const states: RenderState[] = [];
  for (const pane of panes) {
    const local = localPanes.find((candidate) => candidate.pane === pane);
    const state = local
      ? renderState({ activity: local.agent?.activity ?? null, attention: local.attention })
      : null;
    mux.setPaneState(pane, state, server);
    if (state) states.push(state);
  }

  const windowState =
    RENDER_PRIORITY.find((state) => state !== "idle" && states.includes(state)) ?? null;
  mux.setWindowState(window, windowState, server);
  return true;
}
