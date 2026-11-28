import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { SSH_OPTIONS } from "./channel.js";
import { JUMP_CLIENT_OPTION } from "./goto.js";
import { findHelper } from "./helper-path.js";
import { asPaneId } from "./ids.js";
import {
  currentJumpCommand,
  renderJumpCommand,
  shellQuote,
  supportsServer,
  tmuxAttachCommand,
  unsupportedServerMessage,
} from "./jump-command.js";
import { conventionalTmuxDirectory, type Mux, tmux } from "./mux.js";
import { CLIENT_IDENTITY_FORMAT, WRAPPER_ROUTE_OPTION, wrapperRoute } from "./routing.js";
import type { Store } from "./store.js";
import { DEFAULT_TMUX_SERVER, type PeerRecord, type TmuxServer } from "./types.js";
import type { PaneView } from "./view.js";

/**
 * The last segment of a slash-separated tmux session name.
 *
 * Session names are conventionally paths -- `tms` and friends name a session
 * after the directory it was opened in -- so the last segment identifies the
 * work: `hacking/murmur` is about `murmur`.
 *
 * SESSION names only. A window name that reaches the label is one a human chose
 * (see `chosenWindowName`) and shortening it would be presumptuous; a session
 * name is the last-resort fallback and almost never chosen by hand.
 *
 * Not `path.basename`: a session name only looks like a path. Splitting on `/`
 * cannot start resolving `..` or behaving differently per platform.
 *
 * Degenerate inputs keep the original rather than returning "": a session called
 * `/` has no last segment, and an empty name column is worse than an odd one.
 */
export function sessionLeaf(session: string): string {
  const leaf = session.split("/").filter(Boolean).at(-1);
  return leaf ?? session;
}

/**
 * The most specific human-readable name a pane's agent has, never a tmux id.
 *
 * Four sources, most to least specific: mu's agent name (`@mu_agent`), the
 * pane's title (pi names its session there), the tmux window name, the tmux
 * session name. All are recorded by the node owning
 * the pane, so a local and a remote row read the same -- a reader cannot resolve
 * a remote window id against its own tmux.
 *
 * The session name is shortened to its last segment, and that last segment is
 * reached far more often than it looks: `agent_name` is mu-only, `window_name`
 * is null whenever tmux is auto-renaming (its default), and a pane title is
 * null until its program sets one. So the common row for a hand-started agent
 * printed `hacking/murmur` -- a path where a name belongs.
 *
 * The full name is not lost: the picker's stream column shows it, and shows it
 * BECAUSE of this shortening, since that column blanks when it would repeat the
 * name. Shortened, the row reads `murmur` + `hacking/murmur` -- same width,
 * strictly more information.
 *
 * Falls back to the window id only when a node recorded no names at all, which
 * means a non-tmux harness.
 */
export function agentLabel(agent: PaneView): string {
  const name =
    agent.agent_name ??
    agent.pane_title ??
    agent.window_name ??
    (agent.session_name === null ? null : sessionLeaf(agent.session_name));
  return terminalText(name ?? agent.window);
}

/**
 * Where the pane lives, for the second column. Names only -- the ids are what
 * jumps, not what a human reads.
 */
export function agentLocation(agent: PaneView): string {
  const session = agent.session_name ?? agent.session;
  const window = agent.window_name ?? agent.window;
  return terminalText(session === window ? session : `${session}:${window}`);
}

export function terminalText(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f) ? "�" : character;
    })
    .join("");
}

export { shellQuote };

/**
 * The peer that reaches a pane's host, and the ssh target to use for it.
 *
 * One boundary for a POLICY, not a convenience: "match on host_id, prefer
 * `target`, fall back to `name`". It was written out twice -- here and in
 * `glance` -- so peer identity gaining a second key would have needed both sites
 * changed with nothing saying so.
 *
 * Returns the row and the target together, so callers narrow on the PEER rather
 * than on the target. Narrowing on the target was what left both sites carrying
 * defensive `peer?.name` and `peer?.last_error` where `peer` was provably
 * defined.
 */
export function peerForHost(
  store: Store,
  hostId: string,
): { peer: PeerRecord; target: string } | null {
  const peer = store.peers().find((candidate) => candidate.host_id === hostId);
  if (!peer) return null;
  const target = peer.target ?? peer.name;
  return target ? { peer, target } : null;
}

/** A `~`-marked wrapper name, with tmux target syntax stripped from the label. */
export function remoteSessionName(
  peerName: string,
  hostId?: string,
  server: TmuxServer = DEFAULT_TMUX_SERVER,
): string {
  const base = hostSessionName(peerName, hostId);
  // The default server keeps its historical name. A wrapper holds ONE remote
  // client, attached to ONE remote server, and `switch-client` cannot move it
  // to another server's panes -- so reuse must key on the server as well.
  if (server.kind === "default") return base;
  let hash = 0;
  for (const character of `${server.kind}:${"value" in server ? server.value : ""}`) {
    hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
  }
  return `${base.slice(0, -1)}-s${Math.abs(hash).toString(36).padStart(6, "0").slice(0, 6)}~`;
}

function hostSessionName(peerName: string, hostId?: string): string {
  const label = peerName.replace(/^[@$%=]+/, "").replaceAll(/[:.\s]+/g, "-");
  // The sanitised label is NOT injective -- `a:b` and `a.b` both become `a-b`,
  // and `@foo` becomes `foo`. Reuse is matched on this name, so two peers
  // colliding here meant a jump to the second finding the FIRST one's wrapper,
  // taking the reuse branch, and attaching the operator to the wrong machine
  // while reporting ok. That is the failure the pane retarget already fixed one
  // level down, reappearing at the level of the host.
  //
  // The host id disambiguates because it is what actually identifies the
  // destination; the name is a label a human typed. Hashed rather than sliced:
  // a host id is a uuid in production but nothing enforces that, and slicing
  // hex characters out of an arbitrary string reintroduces the collision it is
  // here to prevent (`remote-host` yields `ee`). Six base-36 characters of a
  // cheap hash keep the session list readable and separate any two ids.
  //
  // Optional so a caller without a host id still gets the sanitised form.
  if (!hostId) return `${label}~`;
  let hash = 0;
  for (const character of hostId) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
  return `${label}-${Math.abs(hash).toString(36).padStart(6, "0").slice(0, 6)}~`;
}

/**
 * The process calls jump makes outside tmux: the remote probe and the configured
 * interactive command. Injectable so the jump decision
 * table is testable without an ssh binary or a live peer -- without this seam,
 * replacing `jumpToAgent`'s body with `return { ok: true }` kept every jump
 * test green.
 */
export type Runner = (
  file: string,
  args: string[],
  inherit?: boolean,
) => { status: number | null; stdout: string; failed: boolean };

/**
 * Bounds the PROBE, and only the probe.
 *
 * A probe runs on the picker's interactive path, so it must not hang the list;
 * ten seconds is far above a warm ssh and still finite for a sleeping laptop.
 */
export const PROBE_TIMEOUT_MS = 10_000;

/**
 * The real runner, parameterised by the probe's deadline.
 *
 * The deadline is an argument rather than a module constant so the timeout
 * POSTURE can be asserted in milliseconds. It used to be baked in, which left
 * only one way to prove the interactive path is unbounded: outlive the real 10s
 * with a `sleep 12`, and pay 22 seconds of wall clock across two tests on every
 * run. The posture is the claim; the size of the number never was.
 *
 * Same lesson as the two-postures comment below, one level up: a constant that
 * only one caller may choose is a seam missing, not a value.
 */
export function makeSpawnRunner(probeTimeoutMs: number = PROBE_TIMEOUT_MS): Runner {
  return (file, args, inherit = false) => {
    const executable = findHelper(file);
    if (executable === null) return { status: null, stdout: "", failed: true };
    const result = spawnSync(executable, args, {
      encoding: "utf8",
      // `inherit` means the user is SITTING IN this process -- the outside-tmux
      // ssh attach -- and a session a human is working in must have no deadline.
      // spawnSync's timeout is a hard kill, so the shared 10s SIGTERMed the ssh
      // ten seconds into a working remote pane, and because that leaves
      // `status: null` with ETIMEDOUT, `failed` went true and murmur reported
      // "ssh attach failed" with exit 1 for a session that was fine.
      //
      // Two callers, two postures: the same lesson as SSH_OPTIONS in channel.ts,
      // where one posture reused across two purposes was also the bug.
      ...(inherit ? { stdio: "inherit" as const } : { timeout: probeTimeoutMs }),
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      // spawnSync reports a failure to start the child in `error` and leaves
      // status null. Collapsing both keeps the decision table below one question.
      failed: result.error !== undefined,
    };
  };
}

/**
 * Exported for its TIMEOUT POSTURE only, which no fake can assert: every jump
 * test injects a `Runner`, so the real one's options object was the one thing
 * with no coverage -- and a hard kill on the interactive path is exactly the
 * kind of bug that hides there.
 */
export const spawnRunner: Runner = makeSpawnRunner();

export type JumpResult =
  | { ok: true }
  | {
      ok: false;
      // Local to this process: the picker prints `message` and nothing else, and
      // no reason code here is ever stored or published in a snapshot.
      reason:
        | "no_peer"
        | "unreachable"
        | "no_tmux"
        | "pane_gone"
        | "unsupported_server"
        | "attach_failed";
      message: string;
    };

/**
 * A `rex` argv against one server: the local one, or `-S <host>`. Never starts
 * a server: a jump or a steer must not bring one into existence.
 */
export function rexArgv(server: string | null, args: readonly string[]): string[] {
  return [...(server === null ? [] : ["-S", server]), "--autostart=false", ...args];
}

/**
 * How this node reaches a remote Rex pane's server: `rex -S <rex_host>` when
 * the peer has one configured here, and the peer's warm ssh to its own local
 * Rex either way, as the fallback. Null when no peer reaches the host.
 *
 * Viewer-side by design: the pane on the wire is a bare `{ kind: "rex" }` on
 * `host_id`, and only this node knows what its `rex hosts` calls that machine.
 */
export function rexRoute(
  store: Store,
  agent: Pick<PaneView, "host_id">,
): { peer: PeerRecord; target: string; rexHost: string | null } | null {
  const resolved = peerForHost(store, agent.host_id);
  return resolved ? { ...resolved, rexHost: resolved.peer.rex_host } : null;
}

const succeeded = (result: ReturnType<Runner>) => result.status === 0 && !result.failed;

/**
 * Raise Rex.app on macOS via AppKit (`NSRunningApplication`), without
 * LaunchServices (`open -a`, which fails with -54 in some contexts) or
 * AppleEvents (`tell application`, which needs Automation permission).
 */
export const RAISE_REX_JXA =
  'ObjC.import("AppKit"); const a = $.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.superlogical.rex"); if (a.count > 0) a.objectAtIndex(0).activateWithOptions($.NSApplicationActivateAllWindows | $.NSApplicationActivateIgnoringOtherApps);';

/** Best-effort raise of Rex.app when jumping into Rex from another terminal on macOS. */
function raiseRexApp(run: Runner, env: NodeJS.ProcessEnv): void {
  if (process.platform !== "darwin" || env.TERM_PROGRAM === "rex") return;
  run("osascript", ["-l", "JavaScript", "-e", RAISE_REX_JXA]);
}

/**
 * Jump to a Rex block, in two steps, both Rex's own API since a Rex pane has no
 * tmux to attach:
 *
 * 1. focus the block on the server that OWNS it (`session.focus_block`): the
 *    local one, or a peer's via `rex -S <rex_host>`, else over the peer's ssh;
 * 2. show its session in THIS machine's Rex.app (`session.select`, a client
 *    action). A Rex server only knows its own sessions, so a remote pane must
 *    be selected through `-S <rex_host>`, always pinned with `-C <label>` to
 *    THIS machine's app client (read from the local server's `rex client ls`)
 *    so it never steers another machine's screen.
 *
 * `session.select` exits 1 when the session cannot be shown (or Remote Control
 * is off) and 3 when the named app client is not connected to that server; each
 * gets its own remediation.
 */
/**
 * This machine's Rex.app client on the local server (`rex client ls`),
 * honouring `$REX_CLIENT` (by label or ID). Null with no `rex`, no running
 * server, or only CLI clients.
 */
function localRexApp(run: Runner, client: string | undefined): { label: string | null } | null {
  const listed = run("rex", rexArgv(null, ["client", "ls", "--json"]));
  if (!succeeded(listed)) return null;
  let clients: unknown;
  try {
    clients = (JSON.parse(listed.stdout) as { clients?: unknown }).clients;
  } catch {
    return null;
  }
  if (!Array.isArray(clients)) return null;
  for (const entry of clients) {
    if (!entry || typeof entry !== "object") continue;
    const { client_id: id, info } = entry as {
      client_id?: unknown;
      info?: { kind?: unknown; label?: unknown };
    };
    if (info?.kind !== "app") continue;
    if (!client || info.label === client || (typeof id === "string" && id.endsWith(client))) {
      return { label: typeof info.label === "string" && info.label ? info.label : null };
    }
  }
  return null;
}

function jumpToRex(store: Store, agent: PaneView, run: Runner, env: NodeJS.ProcessEnv): JumpResult {
  const label = agentLabel(agent);
  const route = agent.local ? null : rexRoute(store, agent);
  if (!agent.local && !route) {
    return {
      ok: false,
      reason: "no_peer",
      message: `${label} is a Rex pane on ${agent.host}, and no peer reaches that host.`,
    };
  }
  const client = env.REX_CLIENT;
  const app = client ? `Rex.app client "${client}"` : "Rex.app";
  // Before anything remote: without a Rex.app here (a Linux box, an SSH
  // session) the jump cannot end anywhere, and focusing first would move the
  // owning machine's Rex for nothing.
  const localApp = localRexApp(run, client);
  if (!localApp) {
    return {
      ok: false,
      reason: "attach_failed",
      message: `${label} is a Rex pane on ${agent.host}, but ${app} is not connected to this machine's Rex server, so there is nothing here to show it in. Jump to it from a machine running Rex.app; the dash still previews it.`,
    };
  }
  const focus = [
    "api",
    "call",
    "session.focus_block",
    JSON.stringify({ session_id: agent.session, block_id: agent.pane }),
  ];
  let focused: boolean;
  let hint = "";
  if (!route) focused = succeeded(run("rex", rexArgv(null, focus)));
  else {
    focused = route.rexHost !== null && succeeded(run("rex", rexArgv(route.rexHost, focus)));
    focused ||= succeeded(
      run("ssh", [
        ...SSH_OPTIONS,
        route.target,
        ["rex", ...rexArgv(null, focus)].map(shellQuote).join(" "),
      ]),
    );
    if (route.rexHost === null) {
      hint = ` Set its Rex host with \`murmur peer set ${route.peer.name} --rex-host <label>\`.`;
    }
  }
  if (!focused) {
    return {
      ok: false,
      reason: "attach_failed",
      message: `could not focus ${label} in Rex on ${agent.host} (session.focus_block failed).${hint}`,
    };
  }
  // Remote select goes through the peer's Rex server, pinned with `-C` to THIS
  // machine's app label so it can only move our own Rex.app. Without a label,
  // never send an unpinned `-S` select.
  const selectServer =
    route && route.rexHost !== null && localApp.label !== null ? route.rexHost : null;
  const selectClient = selectServer !== null ? localApp.label : client;
  const select = run(
    "rex",
    rexArgv(selectServer, [
      ...(selectClient ? ["-C", selectClient] : []),
      "do",
      "session.select",
      `session_id=${agent.session}`,
      ...(agent.window.startsWith("window:") ? [`window_id=${agent.window}`] : []),
    ]),
  );
  if (succeeded(select)) {
    raiseRexApp(run, env);
    return { ok: true };
  }
  const message =
    select.status === 3
      ? selectServer !== null
        ? `focused ${label} on ${agent.host}, but ${app} does not show that machine's Rex server; connect it in Rex.app (\`rex hosts\`).`
        : `focused ${label}, but ${app} is not connected to this machine's Rex server (is Rex.app open with Remote Control on? set $REX_CLIENT to name it).`
      : select.status === 1
        ? agent.local
          ? `focused ${label}, but ${app} could not show its session (it is gone, or the app is on another server).`
          : selectServer !== null
            ? `focused ${label} on ${agent.host}, but ${app} could not show its session (is Remote Control on in Rex.app, and is ${selectServer} connected in \`rex hosts\`?).`
            : `focused ${label} on ${agent.host}, but ${app} does not show that machine's Rex server; connect it in Rex.app (\`rex hosts\`).${hint}`
        : `focused ${label}, but could not show it in ${app} (rex do session.select failed).`;
  return { ok: false, reason: "attach_failed", message };
}

/**
 * Jump to a pane, wherever it lives.
 *
 * NEVER MUTATES STATE ON FAILURE. A failure is a report: a reason and a message,
 * nothing written. The next collect reconciles either way, and only the owning
 * node can author facts about its own panes.
 */
/**
 * How a jump reaches the terminal when it is not inside tmux.
 *
 * - `inherit`: run the attach in this process's terminal, blocking until it
 *   ends. The picker, run from a plain shell.
 * - `rex`: open it in a new Rex tab (`rex window new`), so the caller -- the
 *   dash, or a picker in a Rex pane -- keeps its own terminal and the agent
 *   gets a tab of its own. (That tab carries no program status: tmux drops
 *   OSC 7501 from the pane, so `rex-feed` is what shows the agent's state.)
 *
 * Inside tmux neither applies: a local jump is a `switch-client` and a remote
 * one a wrapper session, as before.
 */
export type Outside = "inherit" | "rex";

/** The Rex session target for the current pane: `$REX_SESSION` (older Rex) or `$REX_BLOCK`. */
function rexSessionTarget(env: NodeJS.ProcessEnv): string | undefined {
  return env.REX_SESSION || env.REX_BLOCK || undefined;
}

/** `rex` when this process runs in a Rex pane, else `inherit`. */
export function outsideTmux(env: NodeJS.ProcessEnv = process.env): Outside {
  return env.TERM_PROGRAM === "rex" && rexSessionTarget(env) ? "rex" : "inherit";
}

/**
 * Run an interactive attach outside tmux.
 *
 * `rex` hands the command to `rex window new` in the caller's session, with
 * the agent's label as the tab name, then shows that tab in Rex.app. It
 * returns at once: the tab owns the attach from there, and closes when it ends.
 */
function runOutside(
  run: Runner,
  how: Outside,
  command: string,
  label: string,
  env: NodeJS.ProcessEnv,
): boolean {
  if (how !== "rex") return succeeded(run("sh", ["-c", command], true));
  const target = rexSessionTarget(env);
  const opened = run(
    "rex",
    rexArgv(null, [
      "window",
      "new",
      ...(target ? ["-s", target] : []),
      "--json",
      // A positional before `--`, so rex parses a leading `-` as a flag:
      // a pane title (set by the program, OSC 2) of `--shell=...` or
      // `--help` became an option of this command. Never a dash first.
      label.replace(/^-+/, "") || "agent",
      "--",
      "sh",
      "-c",
      command,
    ]),
  );
  if (!succeeded(opened)) return false;
  showRexWindow(run, target, jsonField(opened.stdout, "window_id"), env);
  return true;
}

/** A string field of a JSON object on stdout, or null. */
function jsonField(stdout: string, key: string): string | null {
  try {
    const value: unknown = JSON.parse(stdout);
    if (value && typeof value === "object") {
      const field = (value as Record<string, unknown>)[key];
      if (typeof field === "string" && field) return field;
    }
  } catch {
    // not JSON: nothing to read
  }
  return null;
}

/**
 * Show a tab `rex window new` just made. The server makes it its session's
 * active window, but Rex.app keeps showing the window it was on (a floating
 * picker that launched the jump closes back onto it), so select it in the app
 * the way `jumpToRex` does. `session.select` wants a session ID, and the
 * target may be a block: ask Rex which session holds it. Best effort: the tab
 * is open either way, so a failure here is not a failed jump.
 */
function showRexWindow(
  run: Runner,
  target: string | undefined,
  windowId: string | null,
  env: NodeJS.ProcessEnv,
): void {
  if (!target || !windowId) return;
  const session = target.startsWith("session:")
    ? target
    : jsonField(
        run("rex", rexArgv(null, ["session", "inspect", target, "--json"])).stdout,
        "session_id",
      );
  if (!session) return;
  const client = env.REX_CLIENT;
  run(
    "rex",
    rexArgv(null, [
      ...(client ? ["-C", client] : []),
      "do",
      "session.select",
      `session_id=${session}`,
      `window_id=${windowId}`,
    ]),
  );
}

/**
 * Local session option on a jump wrapper naming the remote server-global
 * option its remote client recorded itself in, as `name created`.
 */
export const WRAPPER_CLIENT_OPTION = "@murmur_wrapper_client";
const WRAPPER_OPTION = /^@murmur_wrapper_[0-9a-f]+$/;

/** How many names a route's wrapper may take when another route holds its own. */
const WRAPPER_SLOTS = 4;

/**
 * The wrapper session for `route`: the one already stamped with it (reuse), or
 * else the first free name. A taken name whose stamp differs -- another
 * route's wrapper, an unstamped older one, a session that is not murmur's -- is
 * never touched. Null when every slot is taken by something else.
 */
function wrapperSlot(
  mux: Mux,
  base: string,
  route: string,
): { name: string; reuse: boolean } | null {
  let free: string | null = null;
  for (let slot = 0; slot < WRAPPER_SLOTS; slot += 1) {
    const name = slot === 0 ? base : `${base.slice(0, -1)}-${slot + 1}~`;
    if (!mux.sessionNamed(name)) free ??= name;
    else if (mux.sessionOption(name, WRAPPER_ROUTE_OPTION) === route) return { name, reuse: true };
  }
  return free ? { name: free, reuse: false } : null;
}

/**
 * A socket path as the kernel resolves it: realpath of its deepest existing
 * ancestor, the rest appended as spelled, so `/tmp/...` and `/private/tmp/...`
 * on macOS compare equal whether or not the socket exists yet.
 */
function canonicalSocket(path: string): string {
  const rest: string[] = [];
  let at = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(at), ...rest);
    } catch {
      const parent = dirname(at);
      if (parent === at) return resolve(path);
      rest.unshift(basename(at));
      at = parent;
    }
  }
}

/** The socket path tmux itself would use for `server`. */
function tmuxSocketPath(server: Exclude<TmuxServer, { kind: "rex" }>): string {
  if (server.kind === "path") return server.value;
  return join(conventionalTmuxDirectory(), server.kind === "label" ? server.value : "default");
}

/**
 * Whether `$TMUX` (the server this process runs inside) is definitely NOT the
 * tmux server `server`. A tmux client lives on one server, so `switch-client`
 * sent to another one cannot move it: it failed with `no current client`, or
 * moved some other terminal's client attached there and reported ok.
 *
 * Both sides are compared as canonical socket paths: `default` and `-L` resolve
 * to tmux's conventional directory (`$TMUX_TMPDIR` or `/tmp`, then
 * `tmux-<uid>`), and every path through realpath. A socket name alone is not a
 * server: `-S /elsewhere/default` is not the default server, and `-S` spelled
 * through `/tmp` is the same server as through `/private/tmp`.
 */
export function onOtherTmuxServer(env: NodeJS.ProcessEnv, server: TmuxServer): boolean {
  const own = env.TMUX?.split(",")[0];
  if (!own || server.kind === "rex") return false;
  return canonicalSocket(own) !== canonicalSocket(tmuxSocketPath(server));
}

function tmuxServerName(server: TmuxServer): string {
  if (server.kind === "label") return `-L ${server.value}`;
  if (server.kind === "path") return `-S ${server.value}`;
  return "default";
}

export function jumpToAgent(
  store: Store,
  agent: PaneView,
  mux: Mux = tmux,
  run: Runner = spawnRunner,
  env: NodeJS.ProcessEnv = process.env,
  // An explicit tmux client to move: the jump is steering a client this process
  // is not running in, so "outside tmux" does not apply.
  explicitClient?: string,
): JumpResult {
  const server = agent.server;
  if (server.kind === "rex") return jumpToRex(store, agent, run, env);
  // A tmux pane from here on: the address an attach can name.
  const destination = { server, pane: agent.pane };
  const inside = Boolean(env.TMUX) || explicitClient !== undefined;
  if (agent.local && !inside) {
    // Outside tmux there is no client to switch. A bare `switch-client` did
    // not fail here: tmux picked SOME attached client -- another terminal's --
    // and moved that one, so the jump "succeeded" on a screen the operator
    // was not looking at. Attach instead, as the remote path does.
    const panes = mux.livePanes(server);
    if (panes && !panes.has(agent.pane)) {
      return {
        ok: false,
        reason: "pane_gone",
        message: `${agentLabel(agent)} is gone -- its pane no longer exists.`,
      };
    }
    const attach = tmuxAttachCommand(destination);
    return runOutside(run, outsideTmux(env), attach, agentLabel(agent), env)
      ? { ok: true }
      : {
          ok: false,
          reason: "attach_failed",
          message: `could not attach to ${agentLabel(agent)} (${attach} failed).`,
        };
  }
  if (agent.local && explicitClient === undefined && onOtherTmuxServer(env, server)) {
    return {
      ok: false,
      reason: "unsupported_server",
      message: `${agentLabel(agent)} is on another tmux server than this client (${tmuxServerName(server)}); switch-client cannot cross servers. Jump from outside tmux or from that server.`,
    };
  }
  if (agent.local) {
    // The PANE decides. This once asked about the WINDOW, which a live pane
    // routinely outlives: after `move-pane -s %0 -t @1`, list-panes still has
    // %0 and list-windows no longer has @0, so healthy agents read as gone.
    const panes = mux.livePanes(server);
    if (panes && !panes.has(agent.pane)) {
      return {
        ok: false,
        reason: "pane_gone",
        message: `${agentLabel(agent)} is gone -- its pane no longer exists.`,
      };
    }
    // Reported, not assumed. A failed attach is the local twin of the remote
    // symptom: the picker closes, nothing moves, nothing says why.
    //
    // Keyed on the PANE, the same thing liveness was just asked about, so the
    // check above and the action here cannot disagree about what is being
    // jumped to. Passing the recorded window instead meant a pane that had
    // moved passed the liveness check and then failed to attach.
    if (!mux.attach(agent.pane, server, explicitClient)) {
      return {
        ok: false,
        reason: "attach_failed",
        message: `could not attach to ${agentLabel(agent)} (tmux switch-client failed).`,
      };
    }
    return { ok: true };
  }
  const resolved = peerForHost(store, agent.host_id);
  const peer = resolved?.peer;
  const target = resolved?.target;
  if (!peer || !target) {
    return {
      ok: false,
      reason: "no_peer",
      message: `No peer configured for host ${agent.host_id.slice(0, 8)}. Try: murmur peer add <target>`,
    };
  }

  const template = currentJumpCommand(peer.jump_command, target);
  if (!supportsServer(template, agent.server)) {
    return {
      ok: false,
      reason: "unsupported_server",
      message: unsupportedServerMessage(peer, target, agentLabel(agent), agent.pane),
    };
  }

  // Confirm the pane exists before opening a window to attach to it, and ask
  // about PANES: a recorded window id goes stale every time the pane moves.
  // Without this the attach fails inside a new tmux window that closes
  // instantly, indistinguishable from "enter did nothing" -- the symptom that
  // sent us hunting a quoting bug that did not exist.
  //
  // The format string is quoted because ssh takes no argv: it joins its
  // arguments and hands the string to a remote shell, which mangles a bare
  // `#{pane_id}` into tmux answering `-F expects an argument` -- which looked
  // exactly like an unreachable host.
  //
  // Shares the collector's SSH_OPTIONS rather than passing BatchMode alone.
  // Without ControlPath the probe misses the warm master socket the collector
  // rides; without ConnectTimeout it inherits the kernel's 75s dial, so a
  // sleeping laptop froze the picker for ten seconds before admitting it.
  //
  // Named after the peer as configured, matching the picker's host column: a
  // self-reported display_name can be a container id, unrecognisable in a
  // session list.

  const tmuxPrefix =
    server.kind === "default"
      ? "tmux"
      : `tmux ${server.kind === "label" ? "-L" : "-S"} ${shellQuote(server.value)}`;
  const probe = run("ssh", [
    ...SSH_OPTIONS,
    target,
    `${tmuxPrefix} list-panes -a -F ${shellQuote("#{pane_id}")}`,
  ]);
  if (probe.status !== 0) {
    // 255 is ssh's own failure code; anything else came from the remote command.
    // Conflating them was wrong in the common case: on a warm socket the host
    // answers instantly and it is tmux that is gone, so "unreachable" sent you
    // looking at the network for a problem that was not there.
    const sshFailed = probe.status === 255 || probe.failed;
    if (sshFailed) {
      // Nothing recorded: we learned only that we could not ask. Its agents may
      // be alive behind a cold socket, so deleting them would be guessing.
      return {
        ok: false,
        reason: "unreachable",
        message: `cannot reach ${target} over ssh. Nothing here ever prompts for auth, so check the host is awake and reachable, or connect once by hand to see the real error.`,
      };
    }

    // ssh worked, tmux did not: a real fact about the host, still nothing
    // deleted. The peer's own next snapshot removes its panes, because only
    // that node may author about them.
    return {
      ok: false,
      reason: "no_tmux",
      message: `${target} has no tmux server running, so its agents are gone. They will disappear on the next collect.`,
    };
  }
  const remotePanes = new Set(probe.stdout.split("\n").filter(Boolean).map(asPaneId));
  if (!remotePanes.has(agent.pane)) {
    return {
      ok: false,
      reason: "pane_gone",
      message: `${agentLabel(agent)} is gone -- ${target} no longer has that pane.`,
    };
  }

  // The PANE, which the probe immediately above just proved is alive on that
  // host. Addressing the window instead was the remote twin of the local attach
  // defect and failed the same two ways: you landed on whichever pane that
  // window last had active (a split holding the agent and a shell drops you on
  // the shell), and a pane that moved windows since the peer's last export
  // attached to a stale `@id` -- "can't find window: @99" -- while the pane
  // itself was alive and had just been confirmed.
  //
  // Establishing the pane and then addressing the window is precisely what
  // "only a pane may decide whether an agent exists" exists to prevent, applied
  // one level short of the action. `tmux attach -t %pane` resolves session,
  // window and pane together, verified against a real tmux server.
  //
  // The wrapper's attach (below) also MARKS its own remote client, so `murmur
  // dash --goto` on the remote machine detaches instead of switching. Part of
  // the attach command, so only a client that really attached is marked: a
  // one-shot client-attached hook armed by the probe was left behind whenever
  // the wrapper then failed to start, and marked the next unrelated login. A
  // `{pane}` template has no attach of ours to extend, so it stays unmarked;
  // PREFIX G there opens the remote dash rather than coming home.
  //
  // Outside tmux there is no wrapper and no local client: a detach there would
  // drop the operator out of their own shell's session for nothing.
  const attach = renderJumpCommand(template, destination);

  // Hand the ssh to tmux as its own detached SESSION rather than running it
  // here: a picker is usually a display-popup, and a popup is modal, so an
  // ssh started inside it dies the moment the picker exits and the remote pane
  // flashed and vanished.
  //
  // A session, not a window, because session options are per-session and that is
  // what makes the nesting stop being felt:
  //
  //   status off   -- the remote's own bar is the only one on screen.
  //   prefix None  -- ^b reaches the remote directly. No ^b b to learn.
  //
  // Both would be global on a window and would break every local session. The
  // cost is that the local server is unreachable from inside the wrapper; the
  // README documents a root-table key that detaches out.
  if (inside) {
    // Reuse this route's wrapper rather than stacking one per jump -- three
    // jumps to bubba left three identical windows. Found by its route stamp,
    // not its name: the name is a hashed label, and another route's wrapper
    // (or a session that is not murmur's) can hold it.
    const slot = wrapperSlot(
      mux,
      remoteSessionName(peer.name, agent.host_id, agent.server),
      wrapperRoute(agent),
    );
    if (!slot) {
      return {
        ok: false,
        reason: "attach_failed",
        message: `could not open a session to attach to ${target}: every wrapper session name for ${peer.name} is taken.`,
      };
    }
    const { name, reuse } = slot;

    // Read BEFORE the wrapper exists, or the wrapper itself is recorded as the
    // place to come back to and the return is a no-op.
    // An explicit client has no "current" place to return to.
    const client = explicitClient ?? mux.clientName();
    const origin = explicitClient === undefined ? mux.currentTarget() : null;

    if (reuse) {
      // RETARGET the remote client first. Reuse is matched on the host's name
      // alone, so without this the wrapper still shows whichever pane the last
      // jump left it on: jump to agent A on a host, come back, pick agent B on
      // the same host, and you land on A while the call reports `ok: true`. A
      // wrong destination claiming success is the failure this file's own
      // "a silently failed jump looked exactly like enter did nothing" comment
      // exists to prevent, and the local attach had the identical bug.
      //
      // One extra round trip, on the reuse path only, over the socket the
      // wrapper's own ssh already warmed.
      //
      // `-c` the wrapper's OWN remote client, which its attach recorded under
      // a per-wrapper option (named in the local session's
      // WRAPPER_CLIENT_OPTION). A bare `switch-client -t` lets tmux pick a
      // client: with another operator attached to that host it moved theirs,
      // reported success, and left the wrapper where it was. The recorded
      // client (tty, pid, creation) must still be live, checked in the same
      // remote shell that switches it: tty and second alone recur.
      // `sh -c`, so a non-POSIX login shell on the remote parses none of it.
      const recorded = mux.sessionOption(name, WRAPPER_CLIENT_OPTION);
      if (recorded && WRAPPER_OPTION.test(recorded)) {
        const script =
          `m=$(${tmuxPrefix} show-options -gqv ${recorded}) && [ -n "$m" ] && ` +
          `${tmuxPrefix} list-clients -F ${shellQuote(CLIENT_IDENTITY_FORMAT)} | grep -Fqx -- "$m" && ` +
          `${tmuxPrefix} switch-client -c "\${m%% *}" -t ${shellQuote(agent.pane)}`;
        const retarget = run("ssh", [...SSH_OPTIONS, target, `sh -c ${shellQuote(script)}`]);
        // Reported, and BEFORE the local switch: the client must not move on
        // a retarget that did not happen.
        if (retarget.status === 255 || retarget.failed) {
          return {
            ok: false,
            reason: "attach_failed",
            message: `could not reach ${target} to retarget the existing ${name} session at ${agent.pane}.`,
          };
        }
        if (retarget.status === 0) {
          return mux.switchClient(client, name)
            ? { ok: true }
            : {
                ok: false,
                reason: "attach_failed",
                message: `could not switch to the existing ${name} session.`,
              };
        }
      }
      // The wrapper's client cannot be identified (a client gone): replace
      // the wrapper, whose route the stamp just proved, rather than steer
      // some other client.
      if (!mux.killSession(name)) {
        return {
          ok: false,
          reason: "attach_failed",
          message: `could not replace the existing ${name} session.`,
        };
      }
    }

    // The peer's opaque command template owns its shell quoting. The default
    // retains both layers: one for this local shell and one for ssh's remote
    // shell, so a tmux target containing `$` cannot expand on either side.

    // The return home, inside the wrapper's own command: when the attach exits
    // -- inner detach, remote session killed, ssh dropped -- this runs, then the
    // wrapper has no command left and tmux destroys it.
    //
    // Explicit rather than trusting detach-on-destroy, whose `previous` picked a
    // stray unrelated session in testing rather than the one the jump started
    // from. Still set below, as the fallback for when this cannot run (SIGKILL).
    const restore = origin
      ? `; tmux switch-client ${client ? `-c ${shellQuote(client)} ` : ""}-t ${shellQuote(`=${origin}`)}`
      : "";

    // A fresh option per wrapper, so reuse can name this wrapper's remote
    // client among any others on that host, including other machines' jumps.
    const clientOption = `@murmur_wrapper_${randomBytes(6).toString("hex")}`;
    const wrapper = renderJumpCommand(template, destination, [JUMP_CLIENT_OPTION, clientOption]);
    if (!mux.newSession(name, `${wrapper}${restore}`)) {
      return {
        ok: false,
        reason: "attach_failed",
        message: `could not open a session to attach to ${target}.`,
      };
    }

    mux.setSessionOption(name, WRAPPER_ROUTE_OPTION, wrapperRoute(agent));
    mux.setSessionOption(name, WRAPPER_CLIENT_OPTION, clientOption);
    mux.setSessionOption(name, "status", "off");
    mux.setSessionOption(name, "prefix", "None");
    mux.setSessionOption(name, "detach-on-destroy", "previous");

    if (mux.switchClient(client, name)) return { ok: true };
    // The wrapper started detached and may already hold a marked remote
    // client and the host's only ssh session; nobody will ever see it. Close
    // it, then unset the remote marks naming its client. Best effort: a mark
    // set after this names a client that is gone, and an identity with a pid
    // matches no later one.
    mux.killSession(name);
    const unmark =
      `m=$(${tmuxPrefix} show-options -gqv ${clientOption}); ${tmuxPrefix} set-option -gu ${clientOption}; ` +
      `[ -n "$m" ] && [ "$(${tmuxPrefix} show-options -gqv ${JUMP_CLIENT_OPTION})" = "$m" ] && ` +
      `${tmuxPrefix} set-option -gu ${JUMP_CLIENT_OPTION}; true`;
    run("ssh", [...SSH_OPTIONS, target, `sh -c ${shellQuote(unmark)}`]);
    return {
      ok: false,
      reason: "attach_failed",
      message: `opened session ${name} to ${target}, but could not switch to it, so closed it.`,
    };
  }

  // Outside tmux there is no popup to escape, so run it directly. stdio is
  // inherited, which both hands the terminal to the remote session and -- see
  // `spawnRunner` -- is what waives the probe's timeout, so this blocks for as
  // long as the user stays rather than being killed ten seconds in.
  //
  // None of the wrapper machinery above applies, and must not: there is no local
  // client to switch, nothing to return to but the invoking shell, and no local
  // status bar or prefix to suppress -- this path is already full-screen and
  // prefix-clean, since the whole problem is an artifact of being inside tmux.
  // A local session here would attach a client to a server the user never asked
  // for and leave them in tmux on exit rather than at their prompt.
  //
  // The tradeoff, no reuse of an existing attach, is correct rather than
  // missing: there is no local server holding one.
  return runOutside(run, outsideTmux(env), attach, `${peer.name} · ${agentLabel(agent)}`, env)
    ? { ok: true }
    : {
        ok: false,
        reason: "attach_failed",
        message: `attach to ${target} failed.`,
      };
}
