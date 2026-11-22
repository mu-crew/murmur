import { spawnSync } from "node:child_process";
import { type JumpResult, jumpToAgent, terminalText } from "./agents.js";
import { hasWarmSocket } from "./channel.js";
import { findHelper } from "./helper-path.js";
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
 * The post-selection half of a picker: resolve an opaque `jump_target` against
 * a FRESH read, confirm a possible hardware tap, and jump.
 *
 * Behind `murmur jump`, which an external picker (tsesh) calls after a
 * selection. Failures are a single stderr line and exit code 1: under `display-popup -E` the popup closes on exit, so the caller is
 * expected to relay that line (e.g. `tmux display-message`).
 *
 * A fresh read of the FULL list, never the rows that were displayed: rows can
 * come from a reload that collected into the store after the launch snapshot,
 * and filtering is presentation that must not gate the action. Matched on
 * host_id + server + pane, because a pane id is unique only per tmux server and
 * two machines (or two servers) routinely hold the same `%1`.
 */
/**
 * Exactly one line, whatever went in: the caller relays stderr through a popup
 * that closes on exit, so a second line is lost or breaks the relay. Anything a
 * reader may split on (LF, CR, VT, FF, NEL, U+2028, U+2029) separates parts that
 * are joined with a space, and other control characters become `\ufffd`.
 */
export function reportJumpFailure(message: string): void {
  const line = message
    .split(/[\n\r\v\f\u0085\u2028\u2029]+/)
    .map((part) => terminalText(part).trim())
    .filter(Boolean)
    .join(" ");
  process.stderr.write(`${line || "jump failed."}\n`);
  process.exitCode = 1;
}

const fail = reportJumpFailure;

export function runJump(store: Store, identity: NodeIdentity, token: string, deps: JumpDeps): void {
  const mux = deps.mux ?? tmux;
  const warm = deps.warm ?? hasWarmSocket;
  const jumpTo = deps.jump ?? jumpToAgent;
  const address = parseJumpTarget(token);
  if (!address) {
    fail("not a valid jump target.");
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
    fail(`${address.pane} is no longer here.`);
    return;
  }
  if (agent.attached_pane) {
    if (!mux.attach(agent.attached_pane)) {
      fail(`could not focus local attachment ${agent.attached_pane}.`);
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
    fail(jump.message);
  }
}

/** Runs fzf on the caller's tty, stderr inherited, the way the picker does. */
export const spawnFzf: JumpDeps["fzf"] = (args, input, env) => {
  const executable = findHelper("fzf", env);
  if (executable === null) return "";
  return (
    spawnSync(executable, args, {
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "inherit"],
      env,
    }).stdout ?? ""
  );
};
