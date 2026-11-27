import { execFile, execFileSync, spawn } from "node:child_process";
import { peerForHost, rexArgv, shellQuote } from "./agents.js";
import { endLinesWithReset, scan, sgrOnly } from "./ansi.js";
import { SSH_OPTIONS } from "./channel.js";
import { helperPath } from "./helper-path.js";
import { tmux, tmuxArgs } from "./mux.js";
import type { Store } from "./store.js";
import type { PaneView } from "./view.js";

/**
 * Glance: the last few lines a pane printed.
 *
 * The cheap half of what "render any pane from the master" hides: a stateless
 * `capture-pane`, not a frame stream -- no resize negotiation, arbitrary key
 * routing, or reconnect. Dash can submit a buffered prompt, but that remains one
 * stateless command rather than a terminal protocol, keeping murmur a state
 * layer rather than a multiplexer.
 */

const GLANCE_LINES = 40;

/** Terminal default tab stop, and what a pane's own output was laid out for. */
const TAB_WIDTH = 8;

/**
 * Expand tabs to spaces, per line, at the terminal's 8-column stops.
 *
 * A tab is one character and up to eight columns. Every width-aware consumer
 * here -- ink's `truncate-end`, via `string-width` -- scores it as 2, so a line
 * measured as fitting the glance box was advanced by the terminal to the next
 * tab stop, overflowed, wrapped, and pushed every row below it down. Tabs are
 * ordinary in pane output (`git status`, `make`, most log formats), so the dash
 * mis-rendered on unremarkable content.
 *
 * Expanded rather than stripped or replaced 1:1, because the columns are the
 * point of a tab: collapsing them would shear exactly the table-shaped output
 * that uses them. Counted per line, since a tab stop is measured from the start
 * of the row.
 *
 * The column counter advances on printable text only. Since `capture-pane -e`,
 * a `git status` line arrives with a colour prefix in front of it, and counting
 * those bytes moved every stop on the line to the left.
 */
export function expandTabs(text: string, width = TAB_WIDTH): string {
  if (!text.includes("\t")) return text;
  return text
    .split("\n")
    .map((line) => {
      let out = "";
      let column = 0;
      for (const token of scan(line)) {
        if (token.kind === "sgr") {
          out += token.value;
          continue;
        }
        for (const character of token.value) {
          if (character === "\t") {
            const advance = width - (column % width);
            out += " ".repeat(advance);
            column += advance;
          } else {
            out += character;
            column += 1;
          }
        }
      }
      return out;
    })
    .join("\n");
}

/**
 * What a capture must pass through before anything paints it.
 *
 * Two rules, in this order. SGR only, because the preview is a fixed box inside
 * the dash rather than a terminal: a cursor move or erase paints outside it and
 * corrupts the chrome, and an OSC 52 in pane output would write the operator's
 * clipboard once per redraw. Then a reset per line, because tmux routinely
 * captures output mid-attribute and an unterminated background bled into the
 * border and every row the dash drew after it.
 *
 * Tabs are expanded between the two: the stops are visible columns, so they must
 * be counted after the non-SGR bytes are gone.
 */
function previewSafe(captured: string): string {
  return endLinesWithReset(expandTabs(sgrOnly(captured)));
}

/**
 * The one ssh a glance runs, injectable for the same reason `agents.ts` has
 * `Runner`: without a seam the remote branch cannot be tested without a second
 * machine, and the skip below -- which is the whole point of this file's
 * bug history -- would have no coverage at all.
 */
export type GlanceRunner = (target: string, argv: string[]) => string;

/** execFile's default maxBuffer, which the sync runner inherits. */
const STDOUT_MAX_BYTES = 1024 * 1024;

const sshRunner: GlanceRunner = (target, argv) =>
  execFileSync(helperPath("ssh"), [...SSH_OPTIONS, target, ...argv], {
    encoding: "utf8",
    timeout: 3000,
    stdio: ["ignore", "pipe", "ignore"],
  });

/** The async twin of `GlanceRunner`, for callers that must not block on the ssh. */
export type GlanceRunnerAsync = (target: string, argv: string[]) => Promise<string>;

const sshRunnerAsync: GlanceRunnerAsync = (target, argv) =>
  new Promise((resolve, reject) => {
    // spawn, not execFile: execFile always pipes stderr (its `stdio` option is
    // ignored), so remote shell diagnostics would count against maxBuffer and
    // fail a good capture. Ignoring stdin and stderr here matches the sync
    // runner; stdout keeps the same 1 MiB cap and 3 s timeout, both rejecting.
    const child = spawn(helperPath("ssh"), [...SSH_OPTIONS, target, ...argv], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    // Our own timer, not spawn's `timeout`: a child that traps SIGTERM and
    // exits 0 must still count as a failure, as execFileSync's timeout does.
    const timer = setTimeout(() => {
      if (failed) return;
      failed = true;
      child.kill();
      reject(new Error("ssh timed out"));
    }, 3000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > STDOUT_MAX_BYTES) {
        if (!failed) {
          failed = true;
          child.kill();
          reject(new Error("ssh stdout exceeded maxBuffer"));
        }
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (failed) return;
      failed = true;
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (failed) return;
      if (code !== 0) reject(new Error(`ssh exited ${code ?? signal}`));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });

/**
 * A local `rex` run, its stdout or a throw: the seam for a Rex capture, local
 * or through `rex -S`, as `GlanceRunner` is for the ssh.
 */
export type RexGlanceRunner = (args: string[]) => string;
export type RexGlanceRunnerAsync = (args: string[]) => Promise<string>;

const rexRunner: RexGlanceRunner = (args) =>
  execFileSync(helperPath("rex"), args, {
    encoding: "utf8",
    timeout: 3000,
    stdio: ["ignore", "pipe", "ignore"],
  });

const rexRunnerAsync: RexGlanceRunnerAsync = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      helperPath("rex"),
      args,
      { encoding: "utf8", timeout: 3000, maxBuffer: STDOUT_MAX_BYTES },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

/** The `rex capture` of one block, against the local server or `-S <host>`. */
function rexCaptureArgs(agent: PaneView, server: string | null): string[] {
  return rexArgv(server, ["capture", "-s", agent.session, "-b", agent.pane, "--format", "vt"]);
}

/** A Rex capture's last `lines` lines. */
const tail = (out: string, lines: number) => out.split("\n").slice(-lines).join("\n");

/**
 * How a remote glance reaches the pane: `rex -S <rex_host>` first for a Rex
 * pane whose peer has one configured here, then the ssh (null when it must not
 * run), or null when nothing may run at all.
 *
 * Shared by `glance` and `glanceAsync` so the skip rules and the quoting exist
 * once; only the way each is waited on differs.
 */
function remoteGlance(
  store: Store,
  agent: PaneView,
  lines: number,
): { rex: string[] | null; ssh: { target: string; argv: string[] } | null } | null {
  const resolved = peerForHost(store, agent.host_id);
  if (!resolved) return null;
  const { peer, target } = resolved;
  const rex = agent.server.kind === "rex";
  // `rex -S` is its own transport, so a failed murmur collect over ssh does not
  // gate it; the skip below is about the ssh's cost.
  const direct = rex && peer.rex_host !== null ? rexCaptureArgs(agent, peer.rex_host) : null;
  // Never dial a peer whose last attempt failed.
  //
  // The preview runs PER KEYPRESS as the cursor moves, so this ssh is on the
  // interactive path in a way the collector's never is. A host that cannot
  // authenticate costs the full exchange to fail -- measured at ~1.5s against a
  // real peer rejecting keyboard-interactive, against 70ms for a local row --
  // and every pass over that row paid it again. That was "the picker is slow".
  //
  // `last_error` is the right question and costs nothing: the store clears it on
  // every successful fetch, so a non-null value means the MOST RECENT collect
  // failed. Not keyed on `freshness`, which is a clock: a peer can be stale
  // merely because the floor has not come round yet, and skipping it would
  // withhold a glance from a host that answers fine.
  //
  // The row itself still previews. Its metadata is cached and worth reading --
  // and a peer whose fetch failed keeps its last-known snapshot, which is
  // exactly why the row is on screen at all.
  if (peer.last_error !== null) return direct ? { rex: direct, ssh: null } : null;
  // A remote Rex pane over ssh: that node's own local `rex capture`.
  if (agent.server.kind === "rex") {
    const argv = [["rex", ...rexCaptureArgs(agent, null)].map(shellQuote).join(" ")];
    return { rex: direct, ssh: { target, argv } };
  }
  // ssh's remote side is a login shell. Build the tmux argv first, including
  // the snapshot's server selector, then quote every word into its one remote
  // command so hostile server values and pane ids remain data. `-e` keeps the
  // same styling local and remote; previewSafe accepts SGR and strips the rest.
  const argv = [
    "tmux",
    ...tmuxArgs(agent.server, ["capture-pane", "-p", "-e", "-t", agent.pane, "-S", `-${lines}`]),
  ];
  return { rex: null, ssh: { target, argv: [argv.map(shellQuote).join(" ")] } };
}

/** The first of `attempts` that answers, or null when none does. */
function firstAnswer(attempts: (() => string)[]): string | null {
  for (const attempt of attempts) {
    try {
      return attempt();
    } catch {
      // Cold socket, dead tmux or Rex, gone pane: try the next way, then say so.
    }
  }
  return null;
}

async function firstAnswerAsync(attempts: (() => Promise<string>)[]): Promise<string | null> {
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch {
      // As `firstAnswer`.
    }
  }
  return null;
}

export function glance(
  store: Store,
  agent: PaneView,
  lines = GLANCE_LINES,
  run: GlanceRunner = sshRunner,
  rexRun: RexGlanceRunner = rexRunner,
): string | null {
  if (agent.local) {
    const local =
      agent.server.kind === "rex"
        ? firstAnswer([() => tail(rexRun(rexCaptureArgs(agent, null)), lines)])
        : tmux.capture(agent.pane, lines, agent.server);
    return local === null ? null : previewSafe(local);
  }
  const remote = remoteGlance(store, agent, lines);
  if (!remote) return null;
  const { rex, ssh } = remote;
  const out = firstAnswer([
    ...(rex ? [() => rexRun(rex)] : []),
    ...(ssh ? [() => run(ssh.target, ssh.argv)] : []),
  ]);
  // The preview says a capture failed rather than the picker failing.
  return out === null ? null : previewSafe(agent.server.kind === "rex" ? tail(out, lines) : out);
}

/**
 * `glance` without blocking the event loop on the ssh: the dash repaints and
 * reads keys while a remote capture is in flight. A local pane is still the
 * synchronous capture, which is a few milliseconds and not worth a hop.
 */
export async function glanceAsync(
  store: Store,
  agent: PaneView,
  lines = GLANCE_LINES,
  run: GlanceRunnerAsync = sshRunnerAsync,
  rexRun: RexGlanceRunnerAsync = rexRunnerAsync,
): Promise<string | null> {
  if (agent.local && agent.server.kind !== "rex") return glance(store, agent, lines);
  const remote = agent.local
    ? { rex: rexCaptureArgs(agent, null), ssh: null }
    : remoteGlance(store, agent, lines);
  if (!remote) return null;
  const { rex, ssh } = remote;
  const out = await firstAnswerAsync([
    ...(rex ? [() => rexRun(rex)] : []),
    ...(ssh ? [() => run(ssh.target, ssh.argv)] : []),
  ]);
  return out === null ? null : previewSafe(agent.server.kind === "rex" ? tail(out, lines) : out);
}
