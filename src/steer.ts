import { hasWarmSocket } from "./channel.js";
import { type InputRunner, sendEscape, sendPrompt } from "./dash-input.js";
import type { NodeIdentity } from "./identity.js";
import { parseJumpTarget } from "./jump-target.js";
import type { LocalOptions } from "./local.js";
import { type Mux, tmux } from "./mux.js";
import { localStatus, type Status } from "./status.js";
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

export type SteerResult =
  | { ok: true; action: "prompt" | "stop"; jump_target: string }
  | {
      ok: false;
      reason: "invalid_target" | "not_found" | "empty_prompt" | "delivery_failed";
      message: string;
    };

async function steer(
  store: Store,
  identity: NodeIdentity,
  token: string,
  action: "prompt" | "stop",
  deps: SteerDeps,
  send: (agent: PaneView) => ReturnType<typeof sendPrompt>,
): Promise<SteerResult> {
  const found = await resolveAgent(store, identity, token, deps);
  if (!found.ok) return found;
  const result = await send(found.agent);
  return result.ok
    ? { ok: true, action, jump_target: token }
    : { ok: false, reason: "delivery_failed", message: result.message };
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
  return steer(store, identity, token, "prompt", deps, (agent) =>
    sendPrompt(store, agent, text, deps.run),
  );
}

/** Interrupt the agent (Escape), locally or over ssh. */
export function stopAgent(
  store: Store,
  identity: NodeIdentity,
  token: string,
  deps: SteerDeps = {},
): Promise<SteerResult> {
  return steer(store, identity, token, "stop", deps, (agent) => sendEscape(store, agent, deps.run));
}
