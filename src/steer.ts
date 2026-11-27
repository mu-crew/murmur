import { hasWarmSocket } from "./channel.js";
import { type InputRunner, sendPrompt } from "./dash-input.js";
import type { NodeIdentity } from "./identity.js";
import { parseJumpTarget } from "./jump-target.js";
import type { LocalOptions } from "./local.js";
import { type Mux, tmux } from "./mux.js";
import { localStatus, type Status } from "./status.js";
import { type Capture, type StopBounds, type StopState, stopPane } from "./stop.js";
import type { Store } from "./store.js";
import type { PaneView } from "./view.js";

export type ResolveResult =
  | { ok: true; agent: PaneView; latest: Status }
  | { ok: false; reason: "invalid_target" | "not_found"; message: string };

export type SteerDeps = {
  mux?: Mux;
  rex?: LocalOptions["rex"];
  warm?: (target: string) => boolean;
  run?: InputRunner;
  /** `stop`'s read back and ctl lookup; see `stopPane`. */
  capture?: Capture;
  ctlSocket?: (pane: PaneView, capture: Capture) => Promise<string | null>;
  stopBounds?: StopBounds;
};

/**
 * A `status --json` `jump_target` against a FRESH read of the full list, matched
 * on host_id + server + pane (a pane id is unique only per tmux server, and two
 * machines routinely hold the same `%1`). Shared by `jump`, `prompt` and `stop`.
 */
export async function resolveAgent(
  store: Store,
  identity: NodeIdentity,
  token: string,
  deps: Pick<SteerDeps, "mux" | "warm" | "rex"> = {},
): Promise<ResolveResult> {
  const address = parseJumpTarget(token);
  if (!address) return { ok: false, reason: "invalid_target", message: "not a valid jump target." };
  const latest = await localStatus(store, identity, Date.now(), {
    mux: deps.mux ?? tmux,
    warm: deps.warm ?? hasWarmSocket,
    rex: deps.rex,
  });
  const agent = latest.panes.find(
    (candidate) =>
      candidate.pane === address.pane &&
      candidate.host_id === address.host_id &&
      JSON.stringify(candidate.server) === JSON.stringify(address.server),
  );
  if (!agent)
    return { ok: false, reason: "not_found", message: `${address.pane} is no longer here.` };
  return { ok: true, agent, latest };
}

/** How a stop was delivered and what the pane said after it. */
type StopReceipt = {
  action: "stop";
  jump_target: string;
  via: "ctl" | "escape";
  /** Null when the pane's state could not be read back at all. */
  stopped: boolean | null;
  state: StopState | null;
};

export type SteerResult =
  | { ok: true; action: "prompt"; jump_target: string }
  | ({ ok: true; stopped: true } & StopReceipt)
  | ({ ok: false; reason: "not_stopped" | "unconfirmed"; message: string } & StopReceipt)
  | {
      ok: false;
      reason: "invalid_target" | "not_found" | "empty_prompt" | "delivery_failed";
      message: string;
    };

async function steer(
  store: Store,
  identity: NodeIdentity,
  token: string,
  deps: SteerDeps,
  send: (agent: PaneView) => Promise<SteerResult>,
): Promise<SteerResult> {
  const found = await resolveAgent(store, identity, token, deps);
  if (!found.ok) return found;
  return send(found.agent);
}

/** Type `text` into the agent's pane and press Enter, locally or over ssh. */
export function promptAgent(
  store: Store,
  identity: NodeIdentity,
  token: string,
  text: string,
  deps: SteerDeps = {},
): Promise<SteerResult> {
  if (text.trim() === "") {
    return Promise.resolve({ ok: false, reason: "empty_prompt", message: "prompt text is empty." });
  }
  return steer(store, identity, token, deps, async (agent) => {
    const result = await sendPrompt(store, agent, text, deps.run);
    return result.ok
      ? { ok: true, action: "prompt", jump_target: token }
      : { ok: false, reason: "delivery_failed", message: result.message };
  });
}

/**
 * Interrupt the agent (pi's ctl abort, else Escape), locally or over ssh, and
 * confirm it: `ok` only once the pane's state has left working. Delivery alone
 * is `not_stopped` (still working at the bound) or `unconfirmed` (unreadable).
 */
export function stopAgent(
  store: Store,
  identity: NodeIdentity,
  token: string,
  deps: SteerDeps = {},
): Promise<SteerResult> {
  return steer(store, identity, token, deps, async (agent) => {
    const outcome = await stopPane(store, agent, {
      run: deps.run,
      capture: deps.capture,
      ctlSocket: deps.ctlSocket,
      bounds: deps.stopBounds,
    });
    if (!outcome.delivered) {
      return { ok: false, reason: "delivery_failed", message: outcome.message };
    }
    const receipt = { action: "stop" as const, jump_target: token, via: outcome.via };
    if (outcome.stopped === true) {
      return { ok: true, ...receipt, stopped: true, state: outcome.state };
    }
    return {
      ok: false,
      reason: outcome.stopped === null ? "unconfirmed" : "not_stopped",
      message: outcome.message,
      ...receipt,
      stopped: outcome.stopped,
      state: outcome.state,
    };
  });
}
