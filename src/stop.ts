/**
 * `murmur stop` that CONFIRMS: interrupt the agent, then read its pane's OSC
 * 7501 state back until it leaves `working`, bounded. Delivery alone is never
 * reported as a stop: pi ignores Escape mid-tool, so a receipt that only says
 * "the key was sent" lied about exactly the case that matters.
 *
 * The interrupt: a local tmux pi pane with a mu identity whose root process
 * carries `MU_CTL_SOCK` gets the mu pi extension's ctl `abort` (what `mu agent
 * abort` sends), but only after the socket's `hello` names that same agent and
 * workstream: a pane can inherit another agent's socket (a nested pi, a split
 * spawned inside a mu agent's shell), and aborting it would stop the wrong
 * agent. Any doubt, and every other pane, gets Escape, with the reason.
 *
 * The read back: local tmux by `display-message` on the pane's server, local
 * Rex by the collector's single `rex do` walk, a remote pane the same way over
 * the peer's route (its ssh, or `rex -S <rex_host>` first for Rex). A pane
 * that could never be read is `stopped: null`, not a guess either way.
 */
import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { rexArgv, shellQuote } from "./agents.js";
import { SSH_OPTIONS } from "./channel.js";
import {
  buildEscapeDelivery,
  type InputRoute,
  type InputRunner,
  inputRoute,
  remoteSelector,
  runInput,
} from "./dash-input.js";
import { helperPath } from "./helper-path.js";
import { programState } from "./local.js";
import { tmuxArgs, tmuxServerAbsent } from "./mux.js";
import { readPaneCtlSocket } from "./pane-process.js";
import { readRex, WALK } from "./rex.js";
import type { Store } from "./store.js";
import type { PaneState } from "./types.js";
import type { PaneView } from "./view.js";

/** Run a command for its stdout, killed at `ms`; rejects with its stderr. */
export type Capture = (
  command: "tmux" | "ssh" | "rex",
  args: string[],
  ms: number,
) => Promise<string>;

/** How long the read back may take in all, and how often it reads. */
export type StopBounds = { totalMs: number; intervalMs: number; probeMs: number; ctlMs: number };
export const STOP_BOUNDS: StopBounds = {
  totalMs: 5_000,
  intervalMs: 200,
  probeMs: 3_000,
  ctlMs: 2_000,
};

export type StopDeps = {
  run?: InputRunner;
  capture?: Capture;
  /** The pane's `MU_CTL_SOCK`, or null. Default: its root process's environment. */
  ctlSocket?: (pane: PaneView, capture: Capture, ms: number) => Promise<string | null>;
  bounds?: StopBounds;
};

/** What the pane said last: murmur's state word, or `gone` for a pane that no longer exists. */
export type StopState = PaneState | "gone";

/** Why a stop did not go over ctl, so a caller can tell an Escape by design from a refusal. */
export type CtlFallback =
  | "not_local"
  | "not_pi"
  | "no_identity"
  | "no_socket"
  | "no_answer"
  | "identity_mismatch"
  | "abort_failed";

export type StopOutcome =
  | { delivered: false; message: string }
  | {
      delivered: true;
      via: "ctl" | "escape";
      /** Null when `via` is `ctl`. */
      ctl_fallback: CtlFallback | null;
      /** Null: the pane's state could not be read at all within the bound. */
      stopped: boolean | null;
      state: StopState | null;
      message: string;
    };

const WORKING: ReadonlySet<StopState> = new Set<StopState>(["running", "waiting"]);

export const captureCommand: Capture = (command, args, ms) =>
  new Promise((resolve, reject) => {
    let file: string;
    try {
      file = helperPath(command);
    } catch (cause) {
      reject(cause instanceof Error ? cause : new Error(String(cause)));
      return;
    }
    execFile(
      file,
      args,
      { timeout: ms, killSignal: "SIGKILL", encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve(stdout);
      },
    );
  });

/** The pane's OSC 7501 record and lifecycle; the id last, as it may hold `|`. */
const STATE_FORMAT = "#{pane_dead}|#{pane_dead_status}|#{pane_program_state}|#{pane_program_id}";

/**
 * The state line's word, or null for anything not exactly one line of that
 * shape (empty, truncated, an ssh banner around it): unreadable, never `idle`.
 */
export function parseStateLine(line: string): PaneState | null {
  const text = line.replace(/\r?\n$/, "");
  if (text.includes("\n")) return null;
  const [dead, deadStatus, state, ...id] = text.split("|");
  if (dead === undefined || deadStatus === undefined || state === undefined || id.length === 0)
    return null;
  if ((dead !== "0" && dead !== "1") || !/^\d*$/.test(deadStatus)) return null;
  return programState({
    dead: dead === "1",
    deadStatus: deadStatus || null,
    state,
    id: id.join("|") || null,
  });
}

/** A failed tmux read that means the pane is not there any more. */
function paneGone(message: string): boolean {
  return /can't find pane/.test(message) || tmuxServerAbsent(message);
}

const REX_WALK = ["--timeout", "2s", "do", "-e", WALK, "--json"];

/** One read of the pane's state: its word, or an Error saying why it could not be read. */
async function probe(
  pane: PaneView,
  route: InputRoute,
  capture: Capture,
  ms: number,
): Promise<StopState | Error> {
  try {
    if (pane.server.kind === "rex") {
      const out = await rexWalk(route, pane.local, capture, Date.now() + ms);
      const read = await readRex(async () => JSON.parse(out));
      if (read === null) return new Error("Rex's reply could not be read");
      const found = read.panes.find(
        (block) => block.pane === pane.pane && block.session === pane.session,
      );
      if (found) return found.state;
      return read.live.has(pane.pane) ? "idle" : "gone";
    }
    const args = ["display-message", "-p", "-t", pane.pane, STATE_FORMAT];
    const out = pane.local
      ? await capture("tmux", tmuxArgs(pane.server, args), ms)
      : await capture(
          "ssh",
          [
            ...SSH_OPTIONS,
            route.target ?? "",
            "tmux",
            ...remoteSelector(pane.server),
            ...args.map(shellQuote),
          ],
          ms,
        );
    const state = parseStateLine(out);
    return (
      state ?? new Error(`tmux's reply could not be read: ${JSON.stringify(out.slice(0, 80))}`)
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Only tmux's own errors say a pane is gone; Rex's word for it is the walk's.
    return pane.server.kind !== "rex" && paneGone(message) ? "gone" : new Error(message);
  }
}

/**
 * The collector's Rex walk where the pane lives: here, `rex -S <rex_host>`, or
 * the peer's ssh. Both legs share one `deadline`, so a fallback gets only what
 * the first leg left.
 */
async function rexWalk(
  route: InputRoute,
  local: boolean,
  capture: Capture,
  deadline: number,
): Promise<string> {
  const left = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error("Rex read timed out");
    return ms;
  };
  if (local) return capture("rex", rexArgv(null, REX_WALK), left());
  const ssh = () =>
    capture(
      "ssh",
      [
        ...SSH_OPTIONS,
        route.target ?? "",
        ["rex", ...rexArgv(null, REX_WALK)].map(shellQuote).join(" "),
      ],
      left(),
    );
  if (route.rexHost === null) return ssh();
  // A read, so falling back after any failure types nothing twice.
  try {
    return await capture("rex", rexArgv(route.rexHost, REX_WALK), left());
  } catch {
    return ssh();
  }
}

/** A local tmux pane's `MU_CTL_SOCK`, from its root process's environment. */
export async function paneCtlSocket(
  pane: PaneView,
  capture: Capture,
  ms: number,
): Promise<string | null> {
  if (!pane.local || pane.server.kind === "rex") return null;
  try {
    const pid = await capture(
      "tmux",
      tmuxArgs(pane.server, ["display-message", "-p", "-t", pane.pane, "#{pane_pid}"]),
      ms,
    );
    return readPaneCtlSocket(pid.trim());
  } catch {
    return null;
  }
}

/** A ctl reply line is one short JSON object; anything longer is not a ctl socket. */
const CTL_REPLY_MAX = 64 * 1024;

/**
 * One mu pi extension ctl request (protocol v1: one JSON line each way, one
 * request per connection): the reply object, or null on no or a bad reply.
 */
export function ctlRequest(
  sock: string,
  request: { op: string },
  ms: number,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const conn = createConnection(sock);
    let buffer = "";
    let settled = false;
    const finish = (reply: Record<string, unknown> | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      resolve(reply);
    };
    const timer = setTimeout(() => finish(null), ms);
    conn.setEncoding("utf8");
    conn.on("connect", () => conn.write(`${JSON.stringify(request)}\n`));
    conn.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) {
        if (buffer.length > CTL_REPLY_MAX) finish(null);
        return;
      }
      try {
        const reply: unknown = JSON.parse(buffer.slice(0, end));
        const ok =
          typeof reply === "object" &&
          reply !== null &&
          "v" in reply &&
          reply.v === 1 &&
          "ok" in reply &&
          reply.ok === true;
        finish(ok ? (reply as Record<string, unknown>) : null);
      } catch {
        finish(null);
      }
    });
    conn.on("error", () => finish(null));
    conn.on("close", () => finish(null));
  });
}

/**
 * Abort the pane's pi over ctl, only once the socket says it is that pane's
 * agent: null when it did, else why not (and the caller sends Escape).
 */
async function ctlStop(
  pane: PaneView,
  capture: Capture,
  deps: StopDeps,
  ms: number,
): Promise<CtlFallback | null> {
  if (!pane.local || pane.server.kind === "rex") return "not_local";
  if (pane.harness !== "pi") return "not_pi";
  if (pane.agent_name === null || pane.workstream === null) return "no_identity";
  const sock = await (deps.ctlSocket ?? paneCtlSocket)(pane, capture, ms);
  if (sock === null) return "no_socket";
  const hello = await ctlRequest(sock, { op: "hello" }, ms);
  if (hello === null) return "no_answer";
  if (hello.agent !== pane.agent_name || hello.workstream !== pane.workstream)
    return "identity_mismatch";
  return (await ctlRequest(sock, { op: "abort" }, ms)) === null ? "abort_failed" : null;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Interrupt `pane` and read its state back until it leaves `working` or the bound passes. */
export async function stopPane(
  store: Store,
  pane: PaneView,
  deps: StopDeps = {},
): Promise<StopOutcome> {
  const capture = deps.capture ?? captureCommand;
  const bounds = deps.bounds ?? STOP_BOUNDS;
  const route = inputRoute(store, pane);
  if (!pane.local && !route.target)
    return { delivered: false, message: `no peer for ${pane.host}` };

  const ctl_fallback = await ctlStop(pane, capture, deps, bounds.ctlMs);
  const via: "ctl" | "escape" = ctl_fallback === null ? "ctl" : "escape";
  if (ctl_fallback !== null) {
    try {
      await (deps.run ?? runInput)(buildEscapeDelivery(pane, route.target, route.rexHost));
    } catch (error) {
      return { delivered: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  const deadline = Date.now() + bounds.totalMs;
  let state: StopState | null = null;
  let failure = "";
  for (;;) {
    const left = deadline - Date.now();
    const read = await probe(pane, route, capture, Math.max(1, Math.min(bounds.probeMs, left)));
    if (read instanceof Error) failure = read.message;
    else {
      state = read;
      if (!WORKING.has(read)) {
        return {
          delivered: true,
          via,
          ctl_fallback,
          stopped: true,
          state,
          message: `${pane.pane} is ${read}`,
        };
      }
    }
    if (Date.now() + bounds.intervalMs >= deadline) break;
    await wait(bounds.intervalMs);
  }
  const after = `${bounds.totalMs / 1000}s`;
  if (state === null) {
    return {
      delivered: true,
      via,
      ctl_fallback,
      stopped: null,
      state: null,
      message: `${via === "ctl" ? "aborted" : "sent Escape to"} ${pane.pane} but could not read its state: ${failure}`,
    };
  }
  return {
    delivered: true,
    via,
    ctl_fallback,
    stopped: false,
    state,
    message: `${pane.pane} is still ${state} ${after} after ${via === "ctl" ? "the ctl abort" : "Escape"}`,
  };
}
