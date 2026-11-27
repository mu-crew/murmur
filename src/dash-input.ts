import { spawn } from "node:child_process";
import { peerForHost, rexArgv, shellQuote } from "./agents.js";
import { SSH_OPTIONS } from "./channel.js";
import { helperPath } from "./helper-path.js";
import type { PaneId } from "./ids.js";
import { tmuxArgs as serverArgs } from "./mux.js";
import type { Store } from "./store.js";
import type { TmuxServer } from "./types.js";
import type { PaneView } from "./view.js";

export type Composer = {
  text: string;
  cursor: number;
};

export type ComposerEdit =
  | { type: "insert"; text: string }
  | { type: "backspace" | "delete" | "left" | "right" | "home" | "end" };

export function emptyComposer(): Composer {
  return { text: "", cursor: 0 };
}

export function editComposer(state: Composer, edit: ComposerEdit): Composer {
  const characters = [...state.text];
  if (edit.type === "insert") {
    characters.splice(state.cursor, 0, ...edit.text);
    return { text: characters.join(""), cursor: state.cursor + [...edit.text].length };
  }
  if (edit.type === "left") return { ...state, cursor: Math.max(0, state.cursor - 1) };
  if (edit.type === "right")
    return { ...state, cursor: Math.min(characters.length, state.cursor + 1) };
  if (edit.type === "home") return { ...state, cursor: 0 };
  if (edit.type === "end") return { ...state, cursor: characters.length };
  if (edit.type === "backspace" && state.cursor > 0) {
    characters.splice(state.cursor - 1, 1);
    return { text: characters.join(""), cursor: state.cursor - 1 };
  }
  if (edit.type === "delete" && state.cursor < characters.length) {
    characters.splice(state.cursor, 1);
    return { text: characters.join(""), cursor: state.cursor };
  }
  return state;
}

/**
 * The dash's transient filter: a query plus whether the reader is typing it.
 *
 * Two fields rather than one nullable composer, because an empty query being
 * EDITED and no query at all are different screens -- the first shows a live
 * prompt the reader is mid-thought in, the second shows nothing.
 */
export type DashFilter = {
  editing: boolean;
  query: Composer;
};

export type DashFilterAction =
  | { type: "open" }
  | { type: "accept" }
  | { type: "cancel" }
  | { type: "edit"; edit: ComposerEdit };

export function emptyFilter(): DashFilter {
  return { editing: false, query: emptyComposer() };
}

/**
 * The `/` state machine, pure so the key bindings are assertable without ink.
 *
 * `open` resumes the existing query rather than clearing it: after Enter the
 * reader is navigating a filtered list, and `/` there almost always means
 * "refine that", not "start over". `accept` keeps the query and stops editing;
 * `cancel` clears it in both modes, so one Escape always gets you back to the
 * full list without having to know which mode you were in. Edits outside
 * editing mode are ignored, which is what lets the dash keep `j`/`k`/`q` as
 * navigation once the prompt is closed.
 */
export function dashFilter(state: DashFilter, action: DashFilterAction): DashFilter {
  if (action.type === "open") return { ...state, editing: true };
  if (action.type === "accept") return { ...state, editing: false };
  if (action.type === "cancel") return emptyFilter();
  if (!state.editing) return state;
  return { ...state, query: editComposer(state.query, action.edit) };
}

export type InputDelivery = {
  command: "tmux" | "ssh" | "sh" | "rex";
  args: string[];
  input: string;
  /** Run once this step succeeded: a `rex -S send`'s Enter. Never retried elsewhere. */
  next?: InputDelivery;
  /**
   * Tried only when this step failed AND certainly delivered nothing: the warm
   * ssh behind a `rex -S`. A step that timed out after it may have delivered
   * is reported as an unknown delivery instead, so nothing is typed twice.
   */
  fallback?: InputDelivery;
};

export type InputResult = { ok: true } | { ok: false; message: string };
export type InputRunner = (delivery: InputDelivery) => Promise<void>;

function tmuxArgs(pane: string, buffer: string): string[] {
  return [
    "load-buffer",
    "-b",
    buffer,
    "-",
    ";",
    "paste-buffer",
    "-b",
    buffer,
    "-t",
    pane,
    "-p",
    "-d",
    ";",
    "send-keys",
    "-t",
    pane,
    "Enter",
  ];
}

/**
 * Every delivery names the pane's server: pane ids are unique per host AND
 * server, so a bare tmux sent to whichever `%N` its own server holds. Locally
 * the default server is pinned with `-L default` (a bare tmux follows $TMUX);
 * over ssh it stays bare, since the remote shell is not inside tmux.
 */
function remoteSelector(server: TmuxServer): string[] {
  if (server.kind === "default") return [];
  if (server.kind === "rex") return ["--rex"];
  return [server.kind === "label" ? "-L" : "-S", shellQuote(server.value)];
}

/** A local Rex block's input: `rex send` (the text on stdin), then Enter or a key. */
function rexDelivery(pane: PaneView, text: string | null): InputDelivery {
  const rex = "rex --autostart=false";
  const script =
    text === null
      ? `${rex} send-key -s "$1" -b "$2" escape`
      : `${rex} send -s "$1" -b "$2" && ${rex} send-key -s "$1" -b "$2" enter`;
  return { command: "sh", args: ["-c", script, "sh", pane.session, pane.pane], input: text ?? "" };
}

/**
 * A remote Rex block's input. Over the peer's ssh, the remote shell runs its
 * own local `rex`; with a `rex_host` configured here, `rex -S <rex_host>` is
 * tried first and the ssh is the fallback.
 */
function remoteRexDelivery(
  pane: PaneView,
  text: string | null,
  target: string,
  rexHost: string | null,
): InputDelivery {
  const block = ["-s", pane.session, "-b", pane.pane];
  const remote = (args: string[]) => ["rex", ...rexArgv(null, args)].map(shellQuote).join(" ");
  const command =
    text === null
      ? remote(["send-key", ...block, "escape"])
      : `${remote(["send", ...block])} && ${remote(["send-key", ...block, "enter"])}`;
  const ssh: InputDelivery = {
    command: "ssh",
    args: [...SSH_OPTIONS, target, command],
    input: text ?? "",
  };
  if (rexHost === null) return ssh;
  // `--timeout` bounds rex's own connect and request; the runner's per-step
  // deadline bounds a rex that hangs past it, so a dead host reaches the ssh.
  const direct = (args: string[], input: string): InputDelivery => ({
    command: "rex",
    args: ["-S", rexHost, "--timeout", REX_TIMEOUT, ...rexArgv(null, args)],
    input,
  });
  if (text === null) return { ...direct(["send-key", ...block, "escape"], ""), fallback: ssh };
  return {
    ...direct(["send", ...block], text),
    next: direct(["send-key", ...block, "enter"], ""),
    fallback: ssh,
  };
}

export function buildPromptDelivery(
  pane: PaneView,
  text: string,
  target: string | null,
  buffer = `murmur-input-${process.pid}`,
  rexHost: string | null = null,
): InputDelivery {
  if (pane.server.kind === "rex") {
    return pane.local
      ? rexDelivery(pane, text)
      : remoteRexDelivery(pane, text, target ?? "", rexHost);
  }
  if (pane.local) {
    return {
      command: "tmux",
      args: serverArgs(pane.server, tmuxArgs(pane.pane, buffer)),
      input: text,
    };
  }
  const args = tmuxArgs(shellQuote(pane.pane), buffer).map((arg) => (arg === ";" ? "\\;" : arg));
  return {
    command: "ssh",
    args: [...SSH_OPTIONS, target ?? "", "tmux", ...remoteSelector(pane.server), ...args],
    input: text,
  };
}

export function buildEscapeDelivery(
  pane: PaneView,
  target: string | null,
  rexHost: string | null = null,
): InputDelivery {
  if (pane.server.kind === "rex") {
    return pane.local
      ? rexDelivery(pane, null)
      : remoteRexDelivery(pane, null, target ?? "", rexHost);
  }
  if (pane.local) {
    return {
      command: "tmux",
      args: serverArgs(pane.server, ["send-keys", "-t", pane.pane, "Escape"]),
      input: "",
    };
  }
  return {
    command: "ssh",
    args: [
      ...SSH_OPTIONS,
      target ?? "",
      "tmux",
      ...remoteSelector(pane.server),
      "send-keys",
      "-t",
      shellQuote(pane.pane),
      "Escape",
    ],
    input: "",
  };
}

/** `rex -S`'s own bound on connecting and on each request. */
const REX_TIMEOUT = "3s";

/** Per-step and total deadlines; the total matches the jump probe's 10s. */
export type InputBounds = { rexMs: number; sshMs: number; totalMs: number };
export const INPUT_BOUNDS: InputBounds = { rexMs: 4_000, sshMs: 6_000, totalMs: 10_000 };

/** A failed step; `maybeDelivered` when it may have reached the pane first. */
class StepError extends Error {
  constructor(
    message: string,
    readonly maybeDelivered: boolean,
  ) {
    super(message);
  }
}

/**
 * A rex error that came after the connection was up, on a request that timed
 * out: the server may have acted on it. A connect timeout delivered nothing.
 */
function rexTimedOutAfterConnect(stderr: string): boolean {
  return /timed out|deadline exceeded/i.test(stderr) && !/connecting to Rex server/.test(stderr);
}

/**
 * One step, killed at `ms` with its whole process group, so a hung child (or a
 * grandchild of `sh -c`) can neither stall the steer nor hold its pipes open.
 */
function runStep(step: InputDelivery, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let file: string;
    try {
      file = helperPath(step.command);
    } catch (cause) {
      // Not found (no `rex` here, say): nothing was delivered.
      reject(new StepError(cause instanceof Error ? cause.message : String(cause), false));
      return;
    }
    // Its own process group, so the deadline can kill all of it.
    const child = spawn(file, step.args, { stdio: ["pipe", "ignore", "pipe"], detached: true });
    let error = "";
    let settled = false;
    const settle = (fail: StepError | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (fail) reject(fail);
      else resolve();
    };
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      settle(new StepError(`${step.command} timed out after ${ms / 1000}s`, true));
    }, ms);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      error += chunk;
    });
    child.on("error", (cause) => settle(new StepError(cause.message, false)));
    child.on("close", (code) => {
      if (code === 0) return settle(null);
      const message = error.trim() || `${step.command} exited ${code ?? "without status"}`;
      const maybe = step.command === "rex" ? rexTimedOutAfterConnect(error) : true;
      settle(new StepError(message, maybe));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(step.input);
  });
}

/**
 * Run a delivery under one total deadline: each step bounded on its own, a
 * fallback only after a failure that certainly delivered nothing, and a step
 * that may have delivered reported as an unknown delivery, never retried.
 */
export function makeInputRunner(bounds: InputBounds = INPUT_BOUNDS): InputRunner {
  return async (delivery) => {
    const deadline = Date.now() + bounds.totalMs;
    let step: InputDelivery | undefined = delivery;
    while (step) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out after ${bounds.totalMs / 1000}s`);
      const own = step.command === "rex" ? bounds.rexMs : bounds.sshMs;
      const ms = step.command === "rex" || step.command === "ssh" ? Math.min(own, left) : left;
      try {
        await runStep(step, ms);
      } catch (error) {
        if (!(error instanceof StepError)) throw error;
        if (step.fallback && !error.maybeDelivered) {
          step = step.fallback;
          continue;
        }
        if (step.fallback) {
          throw new Error(
            `unknown delivery: ${error.message}; not retried over ssh, check the pane`,
          );
        }
        throw new Error(error.message);
      }
      step = step.next;
    }
  };
}

const runInput: InputRunner = makeInputRunner();

/** How a delivery reaches the pane's node: the ssh target, and its Rex host if set here. */
type InputRoute = { target: string | null; rexHost: string | null };

function inputRoute(store: Store, pane: PaneView): InputRoute {
  if (pane.local) return { target: null, rexHost: null };
  const resolved = peerForHost(store, pane.host_id);
  return { target: resolved?.target ?? null, rexHost: resolved?.peer.rex_host ?? null };
}

async function deliver(
  store: Store,
  pane: PaneView,
  makeDelivery: (route: InputRoute) => InputDelivery,
  run: InputRunner,
): Promise<InputResult> {
  const route = inputRoute(store, pane);
  if (!pane.local && !route.target) return { ok: false, message: `no peer for ${pane.host}` };
  try {
    await run(makeDelivery(route));
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export function sendPrompt(
  store: Store,
  pane: PaneView,
  text: string,
  run: InputRunner = runInput,
): Promise<InputResult> {
  return deliver(
    store,
    pane,
    (route) => buildPromptDelivery(pane, text, route.target, undefined, route.rexHost),
    run,
  );
}

/**
 * Remote acknowledgement runs `murmur clear` ON the pane's node: attention is
 * owned by the node that raised it, so the dash must not write a remote row
 * into its own store, where the next collect would overwrite it anyway.
 */
export function buildClearDelivery(pane: PaneView, target: string): InputDelivery {
  return {
    command: "ssh",
    args: [
      ...SSH_OPTIONS,
      target,
      "murmur",
      "clear",
      "--pane",
      shellQuote(pane.pane),
      ...remoteSelector(pane.server),
    ],
    input: "",
  };
}

/**
 * Acknowledge the pane's attention. Local panes go through `clearLocal` (the
 * same `clearPane` that `murmur clear` runs); remote ones over ssh.
 * A pane with nothing to acknowledge costs nothing, so no ssh round trip.
 */
export function acknowledgeAttention(
  store: Store,
  pane: PaneView,
  clearLocal: (pane: PaneId, server: TmuxServer) => void,
  run: InputRunner = runInput,
): Promise<InputResult> {
  if (pane.attention.length === 0) return Promise.resolve({ ok: true });
  if (pane.local) {
    clearLocal(pane.pane, pane.server);
    return Promise.resolve({ ok: true });
  }
  return deliver(store, pane, (route) => buildClearDelivery(pane, route.target ?? ""), run);
}

export function sendEscape(
  store: Store,
  pane: PaneView,
  run: InputRunner = runInput,
): Promise<InputResult> {
  return deliver(
    store,
    pane,
    (route) => buildEscapeDelivery(pane, route.target, route.rexHost),
    run,
  );
}
