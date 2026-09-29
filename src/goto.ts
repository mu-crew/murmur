import { asPaneId, asWindowId, type PaneId, type WindowId } from "./ids.js";
import type { Mux } from "./mux.js";

/**
 * The tmux option naming the pane a running `murmur dash` occupies.
 *
 * Server-global, not session- or window-scoped: `--goto` runs from whatever
 * session the operator happens to be in, and a session option would only be
 * readable from the dash's own session -- the one place you never need it.
 */
export const DASH_PANE_OPTION = "@murmur_dash_pane";

/**
 * The tmux option naming the client murmur itself attached for a remote jump.
 *
 * Lives on the REMOTE server, set by a one-shot `client-attached` hook that
 * murmur installs just before its jump attaches. It therefore marks exactly one
 * client: an ordinary human `ssh`+`tmux attach` to the same machine is not
 * murmur-controlled and must keep the ordinary switch behaviour.
 *
 * Stored as `#{client_name} #{client_created}` rather than the name alone. A
 * client name is a tty path, which the OS recycles, so a marker left behind by
 * a dead jump would otherwise make a later, unrelated client detach itself on
 * PREFIX G. The creation time makes the identity unforgeable by coincidence,
 * which is also why nothing has to clear this option on detach.
 */
export const JUMP_CLIENT_OPTION = "@murmur_jump_client";

/**
 * Hook index for the one-shot jump marker.
 *
 * A high index because hook arrays are shared with the user's own config:
 * writing `client-attached` unindexed would REPLACE whatever they had bound.
 * The hook removes itself when it fires, so it cannot mark a second client.
 */
export const JUMP_HOOK_INDEX = 9000;

/**
 * The session PREFIX G opens a dash in when none is running.
 *
 * Dedicated, so the dash never lands in whatever work session the key was
 * pressed from. Not plain `murmur`: that is a likely name for a session working
 * on murmur itself, and the dash would move in with it.
 */
export const DASH_SESSION = "murmur-dash";

/**
 * Where PREFIX G pressed in the dash takes a client back to: one server-global
 * option PER CLIENT, so two terminals toggling at once cannot send each other
 * to the wrong place.
 *
 * Keyed by the client name, which is a tty path, so it is flattened into an
 * option-safe word. The value leads with `client_created`, and a marker whose
 * creation time is not this client's is ignored: tty paths are recycled, and a
 * dead client's marker must not steer a new one.
 */
export function returnOption(clientName: string): string {
  return `@murmur_return_${clientName.replace(/[^A-Za-z0-9]/g, "_")}`;
}

export type Place = { pane: PaneId; window: WindowId };

export function formatReturnMarker(created: string, place: Place): string {
  return `${created} ${place.pane} ${place.window}`;
}

/** The recorded place, or null when the marker is absent, malformed or not this client's. */
export function parseReturnMarker(raw: string | null, created: string): Place | null {
  const [owner, pane, window, extra] = raw?.split(" ") ?? [];
  if (owner !== created || !pane?.startsWith("%") || !window?.startsWith("@") || extra) {
    return null;
  }
  return { pane: asPaneId(pane), window: asWindowId(window) };
}

export type GotoWorld = {
  insideTmux: boolean;
  /** This client as `name created`, or null if tmux would not name it. */
  client: string | null;
  /** The `@murmur_jump_client` marker, in the same shape. */
  jumpClient: string | null;
  dashPane: PaneId | null;
  /** null means tmux did not answer, which is not the same as "none". */
  livePanes: Set<PaneId> | null;
  /** Same distinction as `livePanes`. */
  liveWindows: Set<WindowId> | null;
  /** The pane the key was pressed in. */
  here: Place | null;
  /** This client's return marker, already checked to be this client's. */
  returnTo: Place | null;
  /** Whether `murmur init` has run, without which a spawned dash dies on start. */
  initialised: boolean;
};

export type GotoDecision =
  | { kind: "switch"; pane: PaneId }
  | { kind: "back"; target: PaneId | WindowId }
  | { kind: "spawn" }
  | { kind: "detach"; client: string }
  | { kind: "fail"; message: string };

const NOTHING_BACK = "nothing to go back to: the pane and window you came from are gone.";
const NOT_INITIALISED = "murmur is not initialised on this node; run: murmur init";

/**
 * What PREFIX G should do here, decided from tmux options alone.
 *
 * Pure, because the outcomes are the whole feature and the alternative --
 * asserting on argv through a fake -- would only restate the implementation.
 *
 * The key is a toggle. In the dash it goes BACK to the place recorded on the
 * way in: that pane if it is alive, else its window, else nowhere (the dash is
 * a fine place to be stranded -- enter goes anywhere from there). Anywhere else
 * it goes to the dash, opening one when none is running.
 *
 * Detach OUTRANKS switch, and that order is the point. On a murmur-controlled
 * remote visit the server being asked is the remote one, so "switch to the
 * marked dash" would move the operator to the remote machine's dash, one level
 * deeper into the nesting they are trying to leave. Detaching ends the wrapper's
 * attach, whose own restore command then returns the originating local client.
 */
export function gotoDecision(world: GotoWorld): GotoDecision {
  if (!world.insideTmux) {
    return {
      kind: "fail",
      message: "murmur dash --goto must run inside tmux; bind it to a tmux key.",
    };
  }

  if (world.client && world.jumpClient === world.client) {
    // The option carries `name created`; `detach-client -t` takes the name.
    const [name] = world.client.split(" ");
    if (name) return { kind: "detach", client: name };
  }

  // The PANE is the liveness authority here as everywhere else in murmur: the
  // dash clears this option on exit, but a SIGKILL cannot, so a marker alone
  // proves nothing. A null pane list means tmux would not answer, and treating
  // that as "no dash" would open a second one beside a live first.
  const dash =
    world.dashPane && (!world.livePanes || world.livePanes.has(world.dashPane))
      ? world.dashPane
      : null;

  if (dash && world.here?.pane === dash) {
    const back = world.returnTo;
    if (!back) return { kind: "fail", message: NOTHING_BACK };
    // Unknown liveness: try the pane and let tmux say no.
    if (!world.livePanes || world.livePanes.has(back.pane)) {
      return { kind: "back", target: back.pane };
    }
    if (world.liveWindows?.has(back.window)) return { kind: "back", target: back.window };
    return { kind: "fail", message: NOTHING_BACK };
  }

  if (dash) return { kind: "switch", pane: dash };
  if (!world.initialised) return { kind: "fail", message: NOT_INITIALISED };
  return { kind: "spawn" };
}

export type GotoResult = { ok: true } | { ok: false; message: string };

export type GotoOptions = {
  initialised: boolean;
  /** argv for a new dash: this install's own node and entry point, not $PATH's. */
  dashCommand: string[];
};

/** Read the world from tmux, decide, and act. The CLI layer only prints. */
export function runGoto(mux: Mux, env: NodeJS.ProcessEnv, options: GotoOptions): GotoResult {
  const client = mux.clientIdentity();
  const [clientName, created] = client?.split(" ") ?? [];
  const marker = clientName && created ? returnOption(clientName) : null;
  const dashPane = mux.dashPane();
  const here = mux.clientLocation();
  const inDash = dashPane !== null && here?.pane === dashPane;
  const decision = gotoDecision({
    insideTmux: Boolean(env.TMUX),
    client,
    jumpClient: mux.jumpClientMarker(),
    dashPane,
    livePanes: mux.livePanes(),
    // Only the back path reads these, so only it pays for them.
    liveWindows: inDash ? mux.liveWindows() : null,
    here,
    returnTo: inDash && marker && created ? parseReturnMarker(mux.option(marker), created) : null,
    initialised: options.initialised,
  });

  if (decision.kind === "fail") return { ok: false, message: decision.message };
  if (decision.kind === "detach") {
    // Reported, never swallowed. A silently failed goto is indistinguishable
    // from a key that is not bound -- the same symptom the jump path's own
    // "enter did nothing" comment exists to prevent.
    return mux.detachClient(decision.client)
      ? { ok: true }
      : {
          ok: false,
          message: `could not leave this remote session (tmux detach-client failed).`,
        };
  }
  if (decision.kind === "back") {
    return mux.showTarget(decision.target)
      ? { ok: true }
      : { ok: false, message: "could not go back (tmux switch-client failed)." };
  }

  // Recorded before leaving, so the dash knows where "back" is. A client tmux
  // will not name gets no marker and, in the dash, the NOTHING_BACK answer.
  if (marker && created && here) mux.setOption(marker, formatReturnMarker(created, here));

  if (decision.kind === "spawn") {
    const pane = mux.openDash(DASH_SESSION, options.dashCommand);
    if (!pane) return { ok: false, message: `could not open a dash in session ${DASH_SESSION}.` };
    // Marked NOW rather than when the dash has started, a few hundred ms later:
    // a second press in between would otherwise see no dash and open another.
    mux.markDashPane(pane);
    return mux.attach(pane)
      ? { ok: true }
      : { ok: false, message: "opened a dash but could not switch to it." };
  }
  return mux.attach(decision.pane)
    ? { ok: true }
    : {
        ok: false,
        message: `could not reach the murmur dash (tmux switch-client failed).`,
      };
}
