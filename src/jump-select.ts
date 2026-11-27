import { spawnSync } from "node:child_process";
import { type JumpResult, jumpToAgent, outsideTmux, terminalText } from "./agents.js";
import { findHelper } from "./helper-path.js";
import type { NodeIdentity } from "./identity.js";
import { currentJumpCommand, renderJumpCommand } from "./jump-command.js";
import type { LocalOptions } from "./local.js";
import { type Mux, tmux } from "./mux.js";
import { resolveAgent } from "./steer.js";
import type { Store } from "./store.js";
import type { PaneView } from "./view.js";

export type JumpDeps = {
  /** Runs fzf for the hardware-tap confirmation; same tty as the caller. */
  fzf: (args: string[], input: string, env: NodeJS.ProcessEnv) => string;
  jump?: (store: Store, agent: PaneView, client?: string) => JumpResult;
  /** Whether stdin is a terminal; injectable for the JSON no-tty guard. */
  interactive?: () => boolean;
  mux?: Mux;
  warm?: (target: string) => boolean;
  /** How the fresh read reaches Rex; see `readLocal`. */
  rex?: LocalOptions["rex"];
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

export type JumpOptions = {
  /** tmux client to move (`switch-client -c`), for a caller outside that client. */
  client?: string;
  /** Print one JSON object on stdout for success and failure instead of stderr text. */
  json?: boolean;
};

type Reporter = (reason: string, message: string) => void;

function reporter(token: string, options: JumpOptions): { fail: Reporter; ok: () => void } {
  if (!options.json) return { fail: (_reason, message) => fail(message), ok: () => {} };
  return {
    fail: (reason, message) => {
      process.stdout.write(`${JSON.stringify({ ok: false, reason, message })}\n`);
      process.exitCode = 1;
    },
    ok: () => process.stdout.write(`${JSON.stringify({ ok: true, jump_target: token })}\n`),
  };
}

export async function runJump(
  store: Store,
  identity: NodeIdentity,
  token: string,
  deps: JumpDeps,
  options: JumpOptions = {},
): Promise<void> {
  const mux = deps.mux ?? tmux;
  const jumpTo =
    deps.jump ??
    ((jumpStore, target, client) =>
      jumpToAgent(jumpStore, target, mux, undefined, process.env, client));
  const out = reporter(token, options);
  const found = await resolveAgent(store, identity, token, { mux, warm: deps.warm, rex: deps.rex });
  // A miss means the pane went away between the collect and the keypress. Said
  // out loud: in a popup a silent return is indistinguishable from a dead key.
  if (!found.ok) {
    out.fail(found.reason, found.message);
    return;
  }
  const { agent } = found;
  // The attachment is a pane on this machine's tmux: only a tmux client can be
  // moved to it. Outside tmux, a bare `switch-client` failed or moved some other
  // terminal's client, so the jump goes on to open the agent itself.
  if (agent.attached_pane && (Boolean(process.env.TMUX) || options.client !== undefined)) {
    const focused =
      options.client === undefined
        ? mux.attach(agent.attached_pane)
        : mux.attach(agent.attached_pane, undefined, options.client);
    if (!focused) {
      out.fail("attach_failed", `could not focus local attachment ${agent.attached_pane}.`);
    } else out.ok();
    return;
  }

  // JSON callers are scripts: with no tmux client to move and no Rex to open a
  // tab in, the attach needs a terminal that is not there. Say so up front.
  const interactive = deps.interactive ?? (() => Boolean(process.stdin.isTTY));
  // A Rex jump runs no attach at all: its focus and select need no terminal.
  if (
    options.json &&
    agent.server.kind !== "rex" &&
    options.client === undefined &&
    !process.env.TMUX &&
    outsideTmux() === "inherit" &&
    !interactive()
  ) {
    out.fail(
      "no_tty",
      "not inside tmux or Rex and stdin is not a terminal; pass --client <tmux client> to jump.",
    );
    return;
  }

  if (!agent.local) {
    const latest = found.latest;
    const peer = store.peers().find((candidate) => candidate.host_id === agent.host_id);
    const needsTap = latest.peers.find((candidate) => candidate.name === agent.host)?.needs_session;
    if (peer && needsTap && agent.server.kind !== "rex") {
      // A script has no one to confirm the tap: say so instead of opening fzf.
      if (options.json && !interactive()) {
        out.fail("needs_session", `jumping to ${agent.host} may need a hardware token tap.`);
        return;
      }
      const command = renderJumpCommand(currentJumpCommand(peer.jump_command, peer.target), {
        server: agent.server,
        pane: agent.pane,
      });
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
      if (confirmed.trim().split("\t")[0] !== "jump") {
        // JSON promises one object for success or failure; text stays silent.
        if (options.json) out.fail("cancelled", "jump cancelled at the hardware-tap confirmation.");
        return;
      }
    }
  }

  const jump = jumpTo(store, agent, options.client);
  // A popup closes the moment this returns, so a bare failure looked exactly
  // like "enter did nothing". Say what happened and fail loudly.
  if (!jump.ok) out.fail(jump.reason, jump.message);
  else out.ok();
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
