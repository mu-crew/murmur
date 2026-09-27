import type { WindowId } from "./ids.js";
import type { Mux } from "./mux.js";
import type { Store } from "./store.js";
import { DEFAULT_DRIVER, type LocalPane, type TmuxServer } from "./types.js";
import {
  emptyCounts,
  RENDER_PRIORITY,
  type RenderState,
  renderState,
  statusRollup,
} from "./view.js";

function sameServer(left: TmuxServer, right: TmuxServer): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "default" || right.kind === "default") return true;
  return left.value === right.value;
}

function paneState(pane: LocalPane): RenderState {
  return renderState({ activity: pane.agent?.activity ?? null, attention: pane.attention });
}

/** The strongest non-idle state, or null. Idle is the absence of news. */
function strongest(states: readonly RenderState[]): RenderState | null {
  return RENDER_PRIORITY.find((state) => state !== "idle" && states.includes(state)) ?? null;
}

/**
 * Publish murmur's state for one window: every pane gets its own state, the
 * window and its session get the strongest non-idle state among their panes,
 * and the server gets this host's counts for a status pill.
 *
 * Every writer calls this after changing activity or attention. A pane option
 * cannot be painted from the event that just happened, because that event may
 * be weaker than an existing fact on the pane: a `done` must not replace
 * `crashed`, and a running agent with a `blocked` request is still `blocked`.
 *
 * The session aggregate is computed from the store over the session's panes,
 * not by folding the other windows' published options: an option another
 * writer set before a crash would otherwise outlive the fact it described.
 *
 * Returns false when tmux could not list the window. Unknown membership is not
 * evidence that the panes are empty, so nothing is cleared. A session that
 * cannot be listed leaves its option alone for the same reason.
 */
export function publishAgentStates(
  window: WindowId,
  mux: Mux,
  store: Store,
  server: TmuxServer = { kind: "default" },
): boolean {
  const panes = mux.panesInWindow(window, server);
  if (panes === null) return false;

  const allLocal = store.localPanes();
  const localPanes = allLocal.filter((pane) => sameServer(pane.server, server));
  const stateOf = (pane: string): RenderState | null => {
    const local = localPanes.find((candidate) => candidate.pane === pane);
    return local ? paneState(local) : null;
  };

  const states: RenderState[] = [];
  for (const pane of panes) {
    const state = stateOf(pane);
    mux.setPaneState(pane, state, server);
    if (state) states.push(state);
  }
  mux.setWindowState(window, strongest(states), server);

  const session = mux.sessionPanes(window, server);
  if (session) {
    const sessionStates = session.panes.flatMap((pane) => {
      const state = stateOf(pane);
      return state ? [state] : [];
    });
    mux.setSessionState(session.session, strongest(sessionStates), server);
  }

  // Every local agent on this server, not only this window's: the pill is a
  // host-wide rollup, and this is the one place every writer passes through.
  const human = emptyCounts();
  const crew = emptyCounts();
  for (const pane of localPanes) {
    const target = (pane.agent?.driver ?? DEFAULT_DRIVER) === "human" ? human : crew;
    target[paneState(pane)] += 1;
  }
  mux.setStateCounts(statusRollup(human, crew), server);
  return true;
}
