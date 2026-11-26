import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DASH_PANE_OPTION, JUMP_CLIENT_OPTION } from "./goto.js";
import { helperPath } from "./helper-path.js";
import { asPaneId, asWindowId, type PaneId, type WindowId } from "./ids.js";
import { CLIENT_IDENTITY_FORMAT } from "./routing.js";
import { splitTmuxFields, tmuxFormat, tmuxText } from "./tmux-format.js";
import { serverKey, type TmuxSocket } from "./types.js";

/** What `doctor` asks a tmux server about itself. */
export type ServerInfo = {
  /** `#{vtmux_version}`: null on stock tmux, which has no such variable. */
  vtmux: string | null;
  /** `#{version}`, as the server reports it. */
  version: string | null;
  /** The `vtmux-program-status` server option (`on`/`off`), null where unknown. */
  programStatus: string | null;
  /** The `vtmux-program-resume` server option, likewise. */
  programResume: string | null;
};

// Up to this many candidate panes, `localPaneProcesses` runs `ps` once per pid.
const PER_PID_PS_MAX = 4;

export type LocalPaneProcess = {
  pane: PaneId;
  current_command: string;
  arguments: string;
};

export interface Mux {
  livePanes(server?: TmuxSocket): Set<PaneId> | null;
  /**
   * Local panes with their argv. `commands`, when given, keeps only panes whose
   * foreground command is in the set, so no process is read for a pane that
   * cannot match; an empty set reads nothing.
   */
  localPaneProcesses(commands?: ReadonlySet<string>): LocalPaneProcess[];
  /**
   * Every tmux server this user runs on this host, as far as a socket in the
   * conventional directory (or `$TMUX`) says. A stale socket is listed too:
   * asking it is how a dead server reads as an empty one.
   */
  servers(): TmuxSocket[];
  /**
   * ONE `list-panes -a -F` on `server`, one row of `fields` per pane: `[]`
   * when no server is running there (a definite answer), null when it could
   * not be asked. The single read a collect makes per server.
   */
  listPanes(fields: readonly string[], server: TmuxSocket): string[][] | null;
  /**
   * Server-wide facts for `doctor`: the vtmux version (null on stock tmux)
   * and its two OSC options. Null when the server cannot be asked.
   */
  serverInfo(server: TmuxSocket): ServerInfo | null;
  /** Run tmux commands on `server` as one chained call. */
  run(commands: readonly string[][], server: TmuxSocket): void;
  // Takes the PANE, which is the address, so one call resolves session, window
  // and pane together. Reports whether the attach happened: runTmux swallows
  // failures into null, and a silently failed jump looked exactly like "enter
  // did nothing" -- the symptom the remote probe exists to prevent, reproduced
  // locally.
  attach(pane: PaneId, server?: TmuxSocket, client?: string): boolean;
  capture(pane: PaneId, lines?: number, server?: TmuxSocket): string | null;
  // --- remote-jump session seam -------------------------------------------
  // A remote attach lives in its own local session rather than a window, so it
  // can be full-screen (no local status bar) and prefix-free (no nested ^b).
  // See jumpToAgent for why that is worth five extra methods.
  clientName(): string | null;
  currentTarget(): string | null;
  sessionNamed(name: string): boolean;
  newSession(name: string, command: string): boolean;
  setSessionOption(session: string, option: string, value: string): void;
  sessionOption(session: string, option: string): string | null;
  killSession(session: string): boolean;
  switchClient(client: string | null, session: string): boolean;
  // --- goto seam ----------------------------------------------------------
  // `murmur dash --goto` decides from server-global tmux options only, so each
  // of these is one option read or one action. See src/goto.ts for why the
  // decision itself is pure and lives outside this file.
  //
  // Marks the pane a running dash occupies, for its lifetime.
  markDashPane(pane: PaneId): void;
  // Clears the mark, but only if it still names THIS pane. The option is one
  // server-global value, so a second dash overwrites the first's mark; an
  // unconditional unset then let whichever dash exited first clear the
  // survivor's mark, leaving `--goto` reporting no dash with one on screen.
  unmarkDashPane(pane: PaneId): void;
  dashPane(): PaneId | null;
  // This client as `name created`. The creation time is what stops a recycled
  // tty path from inheriting a dead jump's marker.
  clientIdentity(): string | null;
  jumpClientMarker(): string | null;
  detachClient(client: string): boolean;
  // The pane and window of the client running this command -- the key press's
  // client. Untargeted on purpose: `run-shell` exports no $TMUX_PANE.
  clientLocation(): { pane: PaneId; window: WindowId } | null;
  // Same null-versus-empty contract as livePanes.
  liveWindows(): Set<WindowId> | null;
  option(name: string): string | null;
  setOption(name: string, value: string): void;
  // Switch this client to a pane or window id.
  showTarget(target: PaneId | WindowId): boolean;
  // Start a dash as a new window of `session`, creating the session when
  // absent. Returns the new pane, or null.
  openDash(session: string, command: string[]): PaneId | null;
}

/**
 * The argv selecting one tmux server. `default` is pinned with `-L default`
 * rather than left bare: a bare tmux follows `$TMUX`, so a collector running
 * inside any other server -- nested, or a private `-L` rig -- read THAT
 * server's panes as the default one's and reconcile deleted every agent whose
 * pane it could not see. `deriveTmuxServer` only calls a socket `default` when
 * it is the conventional `default` socket, which is exactly what `-L default`
 * names.
 *
 * `undefined` is the ambient server, for questions about wherever this process
 * is running: its own pane, its client, the dash pane it registered.
 */
export function tmuxArgs(server: TmuxSocket | undefined, args: string[]): string[] {
  if (!server) return args;
  if (server.kind === "label") return ["-L", server.value, ...args];
  if (server.kind === "path") return ["-S", server.value, ...args];
  return ["-L", "default", ...args];
}

export function conventionalTmuxDirectory(): string {
  return join(
    realpathSync(process.env.TMUX_TMPDIR || "/tmp"),
    `tmux-${process.getuid?.() ?? process.geteuid?.()}`,
  );
}

export function deriveTmuxServer(
  socketPath: string,
  conventionalDirectory = conventionalTmuxDirectory(),
): TmuxSocket {
  if (dirname(socketPath) !== conventionalDirectory) return { kind: "path", value: socketPath };
  const label = basename(socketPath);
  return label === "default" ? { kind: "default" } : { kind: "label", value: label };
}

/**
 * Whether tmux's stderr says there is no server to ask -- a definite "zero
 * panes", unlike a timeout or a permission error, which say nothing. tmux words
 * this `no server running on <socket>` for a stale socket and `error connecting
 * to <socket> (No such file or directory)` when the socket file is gone.
 */
export function tmuxServerAbsent(stderr: string): boolean {
  return (
    stderr.includes("no server running on ") ||
    /error connecting to .* \(No such file or directory\)/.test(stderr)
  );
}

function runTmux(args: string[], server?: TmuxSocket): string | null {
  try {
    return execFileSync(helperPath("tmux"), tmuxArgs(server, args), {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * tmux reads an argv element that ends in `;` as a command separator and drops
 * the `;`, so a label of `;` or `worker;` would split the chain. A backslash
 * before that final `;` keeps it literal (verified on tmux 3.7c).
 */
export function chainArg(arg: string): string {
  return arg.endsWith(";") ? `${arg.slice(0, -1)}\\;` : arg;
}

// tmux refuses a single command line past ~16KB ("command too long"), so a
// very large window goes out in several calls rather than not at all.
const CHAIN_LIMIT = 8000;

/**
 * Run tmux commands as `;`-joined chains, then ONE `refresh-client -S` last:
 * with no attached client it fails and aborts whatever follows it. A `-q` set
 * on a pane that vanished does not abort the chain.
 */
export function chainedTmuxCalls(commands: readonly (readonly string[])[]): string[][] {
  const calls: string[][] = [];
  let call: string[] = [];
  let size = 0;
  for (const command of [...commands, ["refresh-client", "-S"]]) {
    const args = command.map(chainArg);
    const length = args.reduce((total, arg) => total + arg.length + 1, 2);
    if (call.length > 0 && size + length > CHAIN_LIMIT) {
      calls.push(call.slice(0, -1));
      call = [];
      size = 0;
    }
    call.push(...args, ";");
    size += length;
  }
  calls.push(call.slice(0, -1));
  return calls;
}

/**
 * A session NAME as an exact target, in the two spellings tmux needs. Neither
 * takes a SessionId, which is why neither is branded.
 *
 * Bare names match by PREFIX, so a wrapper for host `bub` silently retargets a
 * session called `bubba` once one exists -- verified, and it sets options on the
 * wrong session rather than failing. A leading `=` demands an exact match.
 * (`name=` is not the syntax: it reads as part of the name and matches nothing.)
 *
 * The trailing colon is the easy part to get wrong. `switch-client -t` takes a
 * target-SESSION, where `=name` is right; `set-option -t` and `show-options -t`
 * take a target-PANE, where `=name` fails with `no such session` and the exact
 * form is `=name:`, the empty window/pane part resolving to the current pane.
 * Hence `exactPaneTarget` being named for what it RETURNS.
 *
 * Neither rescues a name starting with `@`, `$` or `%`, which introduce tmux's
 * id syntax. `remoteSessionName` keeps those out.
 */
export function exactSession(session: string): string {
  return `=${session}`;
}

export function exactPaneTarget(session: string): string {
  return `=${session}:`;
}

/**
 * One process's argv from `<procRoot>/<pid>/cmdline`, joined with single
 * spaces, or null when the pid is gone, unreadable, or has an empty cmdline (a
 * zombie or kernel thread). The caller has already checked `pid` is all digits.
 *
 * argv ONLY: never read `/proc/<pid>/environ`. The environment carries every
 * API key in the pane, and the matcher needs none of it -- see the `ps ww`
 * note in `localPaneProcesses`.
 */
export function procArgv(pid: string, procRoot = "/proc"): string | null {
  let raw: string;
  try {
    raw = readFileSync(join(procRoot, pid, "cmdline"), "utf8");
  } catch {
    return null;
  }
  const argv = raw.replace(/\0+$/, "").split("\0").join(" ");
  return argv || null;
}

export const tmux: Mux = {
  // Which of this host's PANES still exist: the only liveness question tmux is
  // asked, and the one matching how an agent is addressed, since a pane keeps its
  // id across windows while a recorded window id can be gone with the agent
  // alive.
  //
  // null means tmux could not answer, an empty set means there are none.
  // Conflating them would delete every agent the moment tmux was unreachable.
  //
  // A server that is not running IS an answer: it has no panes. Treating it as
  // null left a host whose tmux died (reboot, kill-server) exporting its last
  // panes forever, because reconciliation never had evidence to reap them.
  livePanes(server?: TmuxSocket) {
    let out: string;
    try {
      out = execFileSync(
        helperPath("tmux"),
        tmuxArgs(server, ["list-panes", "-a", "-F", "#{pane_id}"]),
        {
          encoding: "utf8",
          timeout: 3000,
          stdio: ["ignore", "pipe", "pipe"],
        },
      ).trim();
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? "");
      return tmuxServerAbsent(stderr) ? new Set() : null;
    }
    return new Set(out.split("\n").filter(Boolean).map(asPaneId));
  },

  servers() {
    const found = new Map<string, TmuxSocket>();
    let directory: string | null = null;
    try {
      directory = conventionalTmuxDirectory();
    } catch {
      // No tmux directory at all: no server has ever run here.
    }
    if (directory !== null) {
      let names: string[] = [];
      try {
        names = readdirSync(directory);
      } catch {
        names = [];
      }
      for (const name of names.sort()) {
        const path = join(directory, name);
        try {
          if (!statSync(path).isSocket()) continue;
        } catch {
          continue;
        }
        const server = deriveTmuxServer(path, directory);
        found.set(serverKey(server), server);
      }
    }
    // The server this process runs inside, wherever its socket lives: a `-S`
    // server outside the conventional directory is found no other way.
    const own = process.env.TMUX?.split(",")[0];
    if (own) {
      try {
        const server = deriveTmuxServer(own, directory ?? undefined);
        found.set(serverKey(server), server);
      } catch {
        // An unreadable $TMUX names nothing.
      }
    }
    return [...found.values()];
  },

  listPanes(fields, server) {
    let out: string;
    try {
      out = execFileSync(
        helperPath("tmux"),
        tmuxArgs(server, ["list-panes", "-a", "-F", tmuxFormat(...fields)]),
        { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? "");
      return tmuxServerAbsent(stderr) ? [] : null;
    }
    return out
      .split("\n")
      .filter((line) => line !== "")
      .map(splitTmuxFields);
  },

  serverInfo(server) {
    const out = runTmux(
      ["display-message", "-p", tmuxFormat("#{vtmux_version}", "#{version}")],
      server,
    );
    if (out === null) return null;
    const [vtmux, version] = splitTmuxFields(out);
    // `-q`: stock tmux has no such option, and says so on stderr.
    const option = (name: string) => runTmux(["show-options", "-sqv", name], server) || null;
    return {
      vtmux: vtmux || null,
      version: version || null,
      programStatus: vtmux ? option("vtmux-program-status") : null,
      programResume: vtmux ? option("vtmux-program-resume") : null,
    };
  },

  run(commands, server) {
    for (const call of chainedTmuxCalls(commands)) runTmux(call, server);
  },

  // A separate best-effort read for presentation. Unlike livePanes(), failure
  // and no panes have the same harmless result here: no attachment hint.
  localPaneProcesses(commands?: ReadonlySet<string>) {
    const out = runTmux([
      "list-panes",
      "-a",
      "-F",
      tmuxFormat("#{pane_id}", tmuxText("pane_current_command"), "#{pane_pid}"),
    ]);
    if (!out) return [];
    const rows = out.split("\n").flatMap((line) => {
      const [pane, currentCommand, pid] = splitTmuxFields(line);
      // A pid is all digits, and it is interpolated into a `ps` argument list
      // or a `/proc/<pid>` path -- so this is the argv boundary and the guard
      // against path traversal, checked rather than trusted.
      if (!pane || !currentCommand || !pid || !/^\d+$/.test(pid)) return [];
      // Filtered before any process read: the common case is no pane running
      // an ssh-like command at all, and then nothing below runs.
      if (commands && !commands.has(currentCommand)) return [];
      return [{ pane: asPaneId(pane), current_command: currentCommand, pid }];
    });
    if (rows.length === 0) return [];

    // On Linux, read argv straight from /proc. procps `ps` scans ALL of /proc
    // whatever pids it is given: measured at 79ms for 81 pids on a host with
    // 780 processes, against 0.92ms reading the 81 cmdline files. A pid that is
    // gone or has no argv just loses its row.
    if (process.platform === "linux") {
      return rows.flatMap((row) => {
        const arguments_ = procArgv(row.pid);
        return arguments_
          ? [{ pane: row.pane, current_command: row.current_command, arguments: arguments_ }]
          : [];
      });
    }

    // A handful of candidates: one `ps` per pid. macOS `ps` costs ~5ms for one
    // pid but ~75ms for two or more, so a call per pid wins until the count is
    // large. Many candidates: ONE `ps` for all of them, since this runs on every
    // status tick and a fork per pane would not scale.
    //
    // `ww` and NOT `eww`. The `e` flag appends the process ENVIRONMENT, which
    // murmur has no business reading: measured at 3452 bytes for one pane,
    // including `BRAVE_SEARCH_API_KEY` and `ROUTER_API_KEY`. It was added
    // on the theory that macOS `ps` might expose MU_AGENT_NAME that way -- it
    // does not, which was the finding of the commit that added it -- so it
    // leaked every secret in every pane's environment into a string for no
    // consumer at all. argv is what the matcher reads and all it needs.
    const groups =
      rows.length <= PER_PID_PS_MAX ? rows.map((row) => [row.pid]) : [rows.map((row) => row.pid)];
    const deadline = Date.now() + 3000;
    let listing = "";
    for (const pids of groups) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        listing += `${execFileSync(helperPath("ps"), ["ww", "-o", "pid=,command=", ...pids], {
          encoding: "utf8",
          timeout: remaining,
          stdio: ["ignore", "pipe", "ignore"],
        })}\n`;
      } catch {
        // BSD/macOS ps can refuse the whole call when a pid is gone, which is
        // ordinary: a pane can die between the tmux read and this one. That
        // call's panes lose their hint; no attachment hint is the harmless
        // answer, same as every other failure on this path.
      }
    }

    const argvByPid = new Map<string, string>();
    for (const line of listing.split("\n")) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (match?.[1] && match[2]) argvByPid.set(match[1], match[2].trim());
    }
    return rows.flatMap((row) => {
      const arguments_ = argvByPid.get(row.pid);
      return arguments_
        ? [{ pane: row.pane, current_command: row.current_command, arguments: arguments_ }]
        : [];
    });
  },

  attach(pane, server?: TmuxSocket, client?: string) {
    // ONE call, targeting the pane. tmux resolves a bare `%N` to its session,
    // window and pane together, which is the whole reason this takes the
    // address rather than a session and window.
    //
    // The two-step it replaced (`switch-client -t $session` then
    // `select-window -t @window`) was wrong twice over:
    //
    //   It landed on the window's ACTIVE pane, not the one asked for. A window
    //   holding an agent beside a shell put the cursor on whichever was last
    //   focused, so enter on the agent row selected the shell.
    //
    //   It targeted the RECORDED window id, which a live pane routinely
    //   outlives -- `move-pane` and `break-pane` keep the pane and change the
    //   window. `jumpToAgent` proves the pane is alive and then failed to
    //   attach to it, reporting `attach_failed` for a healthy moved agent.
    //   test/mux-targets.test.ts pins that a stale window id is not a usable
    //   target, which is the mechanism.
    //
    // Both were symptoms of addressing by window when the model says the pane
    // is the address, so both go away together here rather than being patched
    // one at a time.
    // `-c` names the client to move when the caller is not inside it (mural,
    // a script): a bare switch-client lets tmux pick one.
    const args = client
      ? ["switch-client", "-c", client, "-t", pane]
      : ["switch-client", "-t", pane];
    return runTmux(args, server) !== null;
  },

  // Which client to send home when the remote attach exits. `switch-client`
  // without -c moves whichever client tmux considers current, and the picker
  // usually runs in a popup -- its own client, which dies with the popup. Naming
  // the real client is what lets the return outlive the picker.
  clientName() {
    return runTmux(["display-message", "-p", "#{client_name}"]) || null;
  },

  // Where the jump started, as a switch-client target. Window-level, since the
  // right session and the wrong window is still the wrong place. The window id
  // is stable where its index is not, renumber-windows renumbering on close.
  currentTarget() {
    return runTmux(["display-message", "-p", "#{session_name}:#{window_id}"]) || null;
  },

  // Whether a wrapper session for this host exists. Returns no id on purpose: a
  // session is addressed by name, so a `#{session_id}` would only be converted
  // back into one.
  sessionNamed(name) {
    const out = runTmux(["list-sessions", "-F", "#{session_name}"]);
    if (out === null) return false;
    return out.split("\n").includes(name);
  },

  newSession(name, command) {
    // Detached, because the caller sets the per-session options before showing
    // it: attached would paint one frame with the local status bar up and the
    // local prefix live, the flicker this design exists to remove.
    return runTmux(["new-session", "-d", "-s", name, command]) !== null;
  },

  setSessionOption(session, option, value) {
    runTmux(["set-option", "-t", exactPaneTarget(session), option, value]);
  },

  sessionOption(session, option) {
    return runTmux(["show-options", "-qv", "-t", exactPaneTarget(session), option]) || null;
  },

  killSession(session) {
    return runTmux(["kill-session", "-t", exactSession(session)]) !== null;
  },

  switchClient(client, session) {
    const target = exactSession(session);
    const args = client
      ? ["switch-client", "-c", client, "-t", target]
      : ["switch-client", "-t", target];
    return runTmux(args) !== null;
  },

  markDashPane(pane) {
    runTmux(["set-option", "-gq", DASH_PANE_OPTION, pane]);
  },

  unmarkDashPane(pane) {
    // Read-then-unset is not atomic, and cannot be: tmux has no
    // compare-and-swap on an option. The race it loses is a dash starting in
    // the instant between the two calls, whose mark this then clears -- the
    // same false negative as before, but now confined to one window of
    // microseconds instead of every second dash's whole lifetime. Both
    // outcomes are recovered by `gotoDecision`'s own pane liveness check and
    // by restarting the dash.
    if (this.dashPane() === pane) runTmux(["set-option", "-gqu", DASH_PANE_OPTION]);
  },

  dashPane() {
    // `-q` so an unset option is an empty answer rather than an error, and `-v`
    // for the bare value: the `option value` form would have to be re-split.
    const out = runTmux(["show-options", "-gqv", DASH_PANE_OPTION]);
    return out ? asPaneId(out) : null;
  },

  // No `-t`: the point is the client running THIS command, which is the one
  // whose key press invoked it. tmux resolves that from $TMUX, and a targeted
  // read would answer about the target's session instead.
  clientIdentity() {
    return runTmux(["display-message", "-p", CLIENT_IDENTITY_FORMAT]) || null;
  },

  jumpClientMarker() {
    return runTmux(["show-options", "-gqv", JUMP_CLIENT_OPTION]) || null;
  },

  detachClient(client) {
    return runTmux(["detach-client", "-t", client]) !== null;
  },

  clientLocation() {
    const out = runTmux(["display-message", "-p", "#{pane_id} #{window_id}"]);
    const [pane, window] = out?.split(" ") ?? [];
    return pane && window ? { pane: asPaneId(pane), window: asWindowId(window) } : null;
  },

  liveWindows() {
    const out = runTmux(["list-windows", "-a", "-F", "#{window_id}"]);
    return out === null ? null : new Set(out.split("\n").filter(Boolean).map(asWindowId));
  },

  option(name) {
    return runTmux(["show-options", "-gqv", name]) || null;
  },

  setOption(name, value) {
    runTmux(["set-option", "-gq", name, value]);
  },

  showTarget(target) {
    return runTmux(["switch-client", "-t", target]) !== null;
  },

  openDash(session, command) {
    const created = !this.sessionNamed(session);
    const out = created
      ? runTmux([
          "new-session",
          "-d",
          "-s",
          session,
          "-n",
          "dash",
          "-P",
          "-F",
          "#{pane_id}",
          "--",
          ...command,
        ])
      : runTmux([
          "new-window",
          "-d",
          "-t",
          exactPaneTarget(session),
          "-n",
          "dash",
          "-P",
          "-F",
          "#{pane_id}",
          "--",
          ...command,
        ]);
    if (!out || !/^%\d+$/.test(out)) return null;
    // Quitting the dash destroys its session. The default `on` would then
    // detach the terminal; `off` moves it to another session instead.
    if (created)
      runTmux(["set-option", "-t", exactPaneTarget(session), "detach-on-destroy", "off"]);
    return asPaneId(out);
  },

  // `-e` because the pane's colours are the point of the preview: without it
  // tmux discards every attribute and nothing downstream can recover which line
  // was the failing one. What arrives is arbitrary terminal bytes, which is why
  // `src/ansi.ts` exists -- see `glance` for the sanitation that follows.
  capture(pane, lines, server?: TmuxSocket) {
    const args = ["capture-pane", "-p", "-e", "-t", pane];
    if (lines !== undefined) args.push("-S", `-${lines}`);
    return runTmux(args, server);
  },
};

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
