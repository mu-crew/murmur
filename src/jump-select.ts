import { spawnSync } from "node:child_process";
import { type JumpResult, jumpToAgent } from "./agents.js";
import { hasWarmSocket } from "./channel.js";
import type { NodeIdentity } from "./identity.js";
import { renderJumpCommand } from "./jump-command.js";
import { parseJumpTarget } from "./jump-target.js";
import { type Mux, tmux } from "./mux.js";
import { status } from "./status.js";
import type { Store } from "./store.js";
import type { PaneView } from "./view.js";

export type JumpDeps = {
  /** Runs fzf for the hardware-tap confirmation; same tty as the caller. */
  fzf: (args: string[], input: string, env: NodeJS.ProcessEnv) => string;
  jump?: (store: Store, agent: PaneView) => JumpResult;
  mux?: Mux;
  warm?: (target: string) => boolean;
};

/**
 * The post-selection half of the picker: resolve an opaque `jump_target` against
 * a FRESH read, confirm a possible hardware tap, and jump.
 *
 * Shared by `murmur pick` and `murmur jump`, so an external picker (tsesh) and
 * the built-in one cannot disagree. Failures are a single stderr line and exit
 * code 1: under `display-popup -E` the popup closes on exit, so the caller is
 * expected to relay that line (e.g. `tmux display-message`).
 *
 * A fresh read of the FULL list, never the rows that were displayed: rows can
 * come from a reload that collected into the store after the launch snapshot,
 * and filtering is presentation that must not gate the action. Matched on
 * host_id + server + pane, because a pane id is unique only per tmux server and
 * two machines (or two servers) routinely hold the same `%1`.
 */
export function runJump(store: Store, identity: NodeIdentity, token: string, deps: JumpDeps): void {
  const mux = deps.mux ?? tmux;
  const warm = deps.warm ?? hasWarmSocket;
  const jumpTo = deps.jump ?? jumpToAgent;
  const address = parseJumpTarget(token);
  if (!address) {
    process.stderr.write("not a valid jump target.\n");
    process.exitCode = 1;
    return;
  }
  const latest = status(store, identity, Date.now(), warm, undefined, { mux });
  const agent = latest.panes.find(
    (candidate) =>
      candidate.pane === address.pane &&
      candidate.host_id === address.host_id &&
      JSON.stringify(candidate.server) === JSON.stringify(address.server),
  );
  // A miss means the pane went away between the collect and the keypress. Said
  // out loud: in a popup a silent return is indistinguishable from a dead key.
  if (!agent) {
    process.stderr.write(`${address.pane} is no longer here.\n`);
    process.exitCode = 1;
    return;
  }
  if (agent.attached_pane) {
    if (!mux.attach(agent.attached_pane)) {
      process.stderr.write(`could not focus local attachment ${agent.attached_pane}.\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (!agent.local) {
    const peer = store.peers().find((candidate) => candidate.host_id === agent.host_id);
    const needsTap = latest.peers.find((candidate) => candidate.name === agent.host)?.needs_session;
    if (peer && needsTap) {
      const command = renderJumpCommand(peer.jump_command, agent);
      const confirmed = deps.fzf(
        [
          "--ansi",
          "--layout",
          "reverse",
          "--prompt",
          "tap required> ",
          "--header",
          `This jump may prompt for a hardware token tap.\n${command}\nenter jump   esc cancel`,
          "--no-multi",
        ],
        "jump\tcontinue",
        process.env,
      );
      if (confirmed.trim().split("\t")[0] !== "jump") return;
    }
  }

  const jump = jumpTo(store, agent);
  // A popup closes the moment this returns, so a bare failure looked exactly
  // like "enter did nothing". Say what happened and fail loudly.
  if (!jump.ok) {
    process.stderr.write(`${jump.message}\n`);
    process.exitCode = 1;
  }
}

/** Runs fzf on the caller's tty, stderr inherited, the way the picker does. */
export const spawnFzf: JumpDeps["fzf"] = (args, input, env) =>
  spawnSync("fzf", args, {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
    env,
  }).stdout ?? "";
