/**
 * `murmur stop` that CONFIRMS: interrupt the agent, then read its pane's OSC
 * 7501 state back until it leaves `working`, bounded. Delivery alone is never
 * reported as a stop: pi ignores Escape mid-tool, so a receipt that only says
 * "the key was sent" lied about exactly the case that matters.
 *
 * The interrupt: a local tmux pane whose root process carries `MU_CTL_SOCK`
 * gets the mu pi extension's ctl `abort` (what `mu agent abort` sends); a
 * socket nothing answers on, and every other pane, gets Escape as before.
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
  ctlSocket?: (pane: PaneView, capture: Capture) => Promise<string | null>;
  bounds?: StopBounds;
};

/** What the pane said last: murmur's state word, or `gone` for a pane that no longer exists. */
export type StopState = PaneState | "gone";

export type StopOutcome =
  | { delivered: false; message: string }
  | {
      delivered: true;
      via: "ctl" | "escape";
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

export function parseStateLine(line: string): PaneState {
  const [dead = "", deadStatus = "", state = "", ...id] = line.replace(/\n+$/, "").split("|");
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
      const out = await rexWalk(route, pane.local, capture, ms);
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
    return parseStateLine(out);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return paneGone(message) ? "gone" : new Error(message);
  }
}

/** The collector's Rex walk where the pane lives: here, `rex -S <rex_host>`, or the peer's ssh. */
async function rexWalk(
  route: InputRoute,
  local: boolean,
  capture: Capture,
  ms: number,
): Promise<string> {
  if (local) return capture("rex", rexArgv(null, REX_WALK), ms);
  const ssh = () =>
    capture(
      "ssh",
      [
        ...SSH_OPTIONS,
        route.target ?? "",
        ["rex", ...rexArgv(null, REX_WALK)].map(shellQuote).join(" "),
      ],
      ms,
    );
  if (route.rexHost === null) return ssh();
  // A read, so falling back after any failure types nothing twice.
  try {
    return await capture("rex", rexArgv(route.rexHost, REX_WALK), ms);
  } catch {
    return ssh();
  }
}

/** A local tmux pane's `MU_CTL_SOCK`, from its root process's environment. */
export async function paneCtlSocket(pane: PaneView, capture: Capture): Promise<string | null> {
  if (!pane.local || pane.server.kind === "rex") return null;
  try {
    const pid = await capture(
      "tmux",
      tmuxArgs(pane.server, ["display-message", "-p", "-t", pane.pane, "#{pane_pid}"]),
      STOP_BOUNDS.ctlMs,
    );
    return readPaneCtlSocket(pid.trim());
  } catch {
    return null;
  }
}

/**
 * The mu pi extension's ctl `abort` (protocol v1: one JSON line each way, one
 * request per connection). True only on an `ok` reply.
 */
export function ctlAbort(sock: string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = createConnection(sock);
    let buffer = "";
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), ms);
    conn.setEncoding("utf8");
    conn.on("connect", () => conn.write(`${JSON.stringify({ op: "abort" })}\n`));
    conn.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        const reply: unknown = JSON.parse(buffer.slice(0, end));
        const fields = typeof reply === "object" && reply !== null ? reply : {};
        finish("v" in fields && fields.v === 1 && "ok" in fields && fields.ok === true);
      } catch {
        finish(false);
      }
    });
    conn.on("error", () => finish(false));
    conn.on("close", () => finish(false));
  });
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

  const sock = await (deps.ctlSocket ?? paneCtlSocket)(pane, capture);
  let via: "ctl" | "escape" = "escape";
  if (sock !== null && (await ctlAbort(sock, bounds.ctlMs))) via = "ctl";
  else {
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
        return { delivered: true, via, stopped: true, state, message: `${pane.pane} is ${read}` };
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
      stopped: null,
      state: null,
      message: `${via === "ctl" ? "aborted" : "sent Escape to"} ${pane.pane} but could not read its state: ${failure}`,
    };
  }
  return {
    delivered: true,
    via,
    stopped: false,
    state,
    message: `${pane.pane} is still ${state} ${after} after ${via === "ctl" ? "the ctl abort" : "Escape"}`,
  };
}
