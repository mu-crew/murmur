import type { PaneId, SessionId, WindowId } from "../../src/ids.js";
import type { Mux, PublishPlan } from "../../src/mux.js";
import type { TmuxServer } from "../../src/types.js";
import type { RenderState } from "../../src/view.js";

/**
 * The per-step hooks a publish used to call one tmux process at a time. The
 * real Mux now reads once (`publishTargets`) and writes once (`publish`); the
 * fake's defaults for those two replay through these hooks, so a test asserts
 * the option values a publish writes rather than the argv that carries them.
 */
export type PublishHooks = {
  sessionPanes?: (
    window: WindowId,
    server?: TmuxServer,
  ) => { session: SessionId; panes: PaneId[] } | null;
  setSessionState?: (session: SessionId, state: RenderState | null, server?: TmuxServer) => void;
  setStateCounts?: (counts: PublishPlan["counts"], server?: TmuxServer) => void;
};

/**
 * A Mux that answers every method with a harmless default.
 *
 * Five separate hand-rolled fakes used to spell this out, so adding one method
 * to the interface broke four unrelated test files. Each test overrides only
 * the methods whose behaviour it is actually asserting on, which also makes the
 * override list a readable statement of what the test is about.
 *
 * The defaults are chosen so a test that forgets an override fails rather than
 * passes: no windows, no sessions, no client.
 *
 * ONE DEFAULT BREAKS THAT PROMISE, deliberately and with a cost worth knowing.
 * `panesInWindow: () => []` describes a state real tmux cannot return: if
 * `windowForPane` just resolved a pane's window, that window contains at least
 * that pane. Two badge tests combined a resolved window with the empty default
 * and passed for years, asserting against an impossible world -- they only
 * surfaced when `notify` started recomputing the badge from the window's panes
 * and suddenly needed the fixture to be coherent.
 *
 * Left as `[]` rather than made to throw, because plenty of tests legitimately
 * never touch it and a throwing default would force noise into all of them. So:
 * IF YOUR TEST RESOLVES A WINDOW, STUB THIS TOO. A passing badge assertion
 * against the default is not evidence.
 */
/**
 * Adds `publishTargets` and `publish` to a plain `vi.doMock` tmux object,
 * replaying through whichever old per-step methods it defines -- the same
 * replay `fakeMux` does, for mocks that deliberately stub only a few methods.
 */
export function withPublish<T extends object>(
  mock: T,
): T & Pick<Mux, "publishTargets" | "publish"> {
  // The mocks spell ids as plain strings; the replay only passes them through.
  const typed = mock as Partial<Mux> & PublishHooks;
  const replay = fakeMux(typed);
  return {
    ...mock,
    publishTargets: (window, server) =>
      typed.panesInWindow ? replay.publishTargets(window, server) : null,
    publish: (window, plan, server) => replay.publish(window, plan, server),
  };
}

export function fakeMux(over: Partial<Mux> & PublishHooks = {}): Mux {
  const { sessionPanes, setSessionState, setStateCounts, ...rest } = over;
  const mux: Mux = {
    currentWindow: () => null,
    livePanes: () => new Set<PaneId>(),
    localPaneProcesses: () => [],
    setWindowState: () => {},
    setPaneState: () => {},
    setPaneLabel: () => {},
    // Read at call time through `mux`, so a test that reassigns a method
    // after construction still sees its override.
    publishTargets: (window, server) => {
      const panes = mux.panesInWindow(window, server);
      if (panes === null) return null;
      const session = sessionPanes?.(window, server) ?? null;
      return {
        session: session?.session ?? null,
        windowPanes: panes,
        sessionPanes: session?.panes ?? [],
      };
    },
    publish: (window, plan, server) => {
      for (const { pane, state, label } of plan.panes) {
        mux.setPaneState(pane, state, server);
        mux.setPaneLabel(pane, label, server);
      }
      mux.setWindowState(window, plan.window.state, server, plan.window.hasAgent);
      if (plan.session) setSessionState?.(plan.session.session, plan.session.state, server);
      setStateCounts?.(plan.counts, server);
    },
    attach: () => true,
    capture: () => null,
    windowForPane: () => null,
    panesInWindow: () => [],
    clientName: () => null,
    currentTarget: () => null,
    sessionNamed: () => false,
    newSession: () => true,
    setSessionOption: () => {},
    switchClient: () => true,
    markDashPane: () => {},
    unmarkDashPane: () => {},
    dashPane: () => null,
    clientIdentity: () => null,
    jumpClientMarker: () => null,
    armJumpMarkerCommand: () => "set-hook -g client-attached[9000] 'fake'",
    detachClient: () => true,
    clientLocation: () => null,
    liveWindows: () => new Set(),
    option: () => null,
    setOption: () => {},
    showTarget: () => true,
    openDash: () => null,
    ...rest,
  };
  return mux;
}
