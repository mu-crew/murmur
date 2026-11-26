import type { PaneId } from "../../src/ids.js";
import type { Mux } from "../../src/mux.js";

/**
 * A Mux that answers every method with a harmless default.
 *
 * Each test overrides only the methods whose behaviour it asserts on, which
 * makes the override list a readable statement of what the test is about.
 *
 * The defaults are chosen so a test that forgets an override fails rather than
 * passes: no servers, no panes, no client.
 */
export function fakeMux(over: Partial<Mux> = {}): Mux {
  return {
    livePanes: () => new Set<PaneId>(),
    localPaneProcesses: () => [],
    servers: () => [],
    listPanes: () => [],
    serverInfo: () => null,
    run: () => {},
    attach: () => true,
    capture: () => null,
    clientName: () => null,
    currentTarget: () => null,
    sessionNamed: () => false,
    newSession: () => true,
    setSessionOption: () => {},
    sessionOption: () => null,
    killSession: () => true,
    switchClient: () => true,
    markDashPane: () => {},
    unmarkDashPane: () => {},
    dashPane: () => null,
    clientIdentity: () => null,
    jumpClientMarker: () => null,
    detachClient: () => true,
    clientLocation: () => null,
    liveWindows: () => new Set(),
    option: () => null,
    setOption: () => {},
    showTarget: () => true,
    openDash: () => null,
    ...over,
  };
}
