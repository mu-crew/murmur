import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { publishAgentStates } from "./agent-state.js";
import { asPaneId, asSessionId, asWindowId } from "./ids.js";
import { type InboxEvent, parseInboxEvent } from "./inbox-event.js";
import { inboxDir } from "./inbox-file.js";
import {
  chosenWindowName,
  conventionalTmuxDirectory,
  deriveTmuxServer,
  type Mux,
  pidAlive,
  tmux,
  tmuxArgs,
} from "./mux.js";
import { type ProcessTable, readProcessTable, treeRuns } from "./process-chain.js";
import { loadSocketCache, type SocketCache, type SocketStat } from "./socket-cache.js";
import type { Store } from "./store.js";
import type { InboxDelivery, IngestSummary, LiveCheck, Location, TmuxServer } from "./types.js";

// The write side lives in its own module, so a writer loads none of the drain.
export { INBOX_PANE_CAP, inboxDir, inboxKey, writeInboxEvent } from "./inbox-file.js";

/**
 * The pane inbox: hook events as files, drained into the store by readers.
 *
 * A hook (`murmur hook <harness>`) opens no database, takes no lock and calls no
 * tmux. It writes one event to `inbox/tmp/` and links it into
 * `inbox/<pane key>/<ns timestamp>-<pid>.json`, so a reader never sees a partial
 * event whatever its size. Readers -- `status`, `pane`, the dash, `export` --
 * drain: under the store's write lock they apply each pane's events in name
 * order and delete them. Nothing is retained; an applied event is gone.
 *
 * Single writer still holds: this node's inbox only ever names panes of its
 * own tmux servers, because the hook placed the event by walking its own
 * process chain to one of them.
 */

/** One pane of a tmux server, keyed by its root process. */
export type InboxPane = { location: Location; focused: boolean };

/**
 * What a hook recorded about its tmux server, beyond the pid: `$TMUX` when it
 * had one, and the socket the server's argv names. Both are hints the host
 * checks against the pid.
 */
export type ServerHints = { tmux: string | null; socket: TmuxServer | null };

/**
 * What the drain asks of tmux and the process table. A seam so tests need
 * neither, and so the real one can cache within a drain.
 */
export interface InboxHost {
  isAlive: LiveCheck;
  /**
   * The tmux server whose pid is `serverPid`, mapped the way the collector maps
   * one (`deriveTmuxServer` over its socket path), or null when no server
   * answers to it.
   */
  serverFor(serverPid: number, hints: ServerHints): TmuxServer | null;
  /** That server's panes by pane pid. Null when tmux could not answer. */
  panes(server: TmuxServer): ReadonlyMap<number, InboxPane> | null;
  /**
   * Whether a pi runs at or below `rootPid`, outside the subtree of `except`
   * (the event's own harness): a pi that harness started is its nested agent,
   * not the pane's owner.
   */
  piRunsUnder(rootPid: number, except: number): boolean;
  /** Called once when the drain is done with the host: the real one saves its socket cache. */
  done?(): void;
}

function runTmux(server: TmuxServer | undefined, args: string[]): string | null {
  try {
    return execFileSync("tmux", tmuxArgs(server, args), {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * What a full drain spends, in all, asking sockets which server answers on
 * them. A socket that accepts and never answers (a stopped or wedged server)
 * holds a tmux client until it is killed, and the drain runs on a status-bar
 * tick: past this, an inbox whose server is still unfound waits for the next
 * drain rather than holding up this one. 1.5 s, so that a whole `murmur
 * status`, process start included, stays near 2 s.
 */
export const SOCKET_PROBE_BUDGET_MS = 1500;

/**
 * Starts one `tmux list-sessions` per socket at once, all writing to one pipe
 * (each line tagged with its socket's index, so a socket path is never put in
 * a tmux format), and SIGKILLs whichever is still running when the budget
 * ends. Each client's exit status follows as `<index> exit <status>`: a client
 * tmux could not connect exits 1 at once, a killed one 137. The killer's own
 * output goes to /dev/null, so the pipe closes as soon as the last client
 * exits; it is stopped, with its `sleep`, once they all have.
 */
const PROBE_SCRIPT = `budget=$1; shift
i=0; pids=
for s do
  tmux -S "$s" list-sessions -F "$i #{pid}" </dev/null 2>/dev/null &
  pids="$pids $!"; i=$((i + 1))
done
( trap 'kill $nap 2>/dev/null; exit 0' TERM
  sleep "$budget" & nap=$!
  wait $nap && kill -9 $pids ) </dev/null >/dev/null 2>&1 &
killer=$!
i=0
for p in $pids; do wait "$p"; echo "$i exit $?"; i=$((i + 1)); done
kill $killer 2>/dev/null
exit 0`;

/**
 * Which server pid answers on each socket, asked of them all in parallel
 * within `budgetMs`. A socket with no server (nothing listening, or no such
 * file) maps to null. A socket whose probe was killed at the budget, or never
 * reported, is left out: unknown, which is not the same as silent, since a
 * live server under load can be slow. Never throws.
 */
export function probeSockets(
  sockets: readonly string[],
  budgetMs: number,
): Map<string, number | null> {
  const answers = new Map<string, number | null>();
  if (sockets.length === 0) return answers;
  const seconds = (Math.max(budgetMs, 1) / 1000).toFixed(3);
  let out = "";
  try {
    // The outer timeout is a backstop for a shell that never gets to wait.
    const result = spawnSync("/bin/sh", ["-c", PROBE_SCRIPT, "sh", seconds, ...sockets], {
      encoding: "utf8",
      timeout: budgetMs + 1000,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
    });
    out = typeof result.stdout === "string" ? result.stdout : "";
  } catch {
    out = "";
  }
  const exits = new Map<string, number>();
  for (const line of out.split("\n")) {
    const match = /^(\d+) (exit )?(\d+)$/.exec(line.trim());
    if (!match) continue;
    const socket = sockets[Number(match[1])];
    const value = Number(match[3]);
    if (socket === undefined) continue;
    if (match[2]) exits.set(socket, value);
    // A server's first session names it; its other sessions say the same.
    else if (value > 0 && !answers.has(socket)) answers.set(socket, value);
  }
  // A client that exited by itself without a pid found no server (or a server
  // with no sessions to name it by); one killed by a signal learnt nothing.
  for (const [socket, status] of exits) {
    if (!answers.has(socket) && status < 128) answers.set(socket, null);
  }
  return answers;
}

function socketStat(socket: string): SocketStat | null {
  try {
    const stat = statSync(socket);
    return { ino: stat.ino, mtime: stat.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * The server a reader runs inside or was pointed at: `$TMUX`'s socket. The
 * drain asks it first, since a hook's pane is most often on the reader's own
 * server.
 */
export function ownServers(env: NodeJS.ProcessEnv = process.env): TmuxServer[] {
  const socket = env.TMUX?.split(",")[0];
  return socket ? [{ kind: "path", value: socket }] : [];
}

export type TmuxInboxHostOptions = {
  /**
   * Where a server named by label, and a server with no hint at all, is looked
   * for: tmux's own directory unless a test points it at a private one.
   */
  socketDirectory?: string;
  /** The reader's own servers (`-L`/`-S`, else `$TMUX`), asked before any scan. */
  own?: readonly TmuxServer[];
  /** Servers already known by pid, which need no lookup at all. */
  known?: ReadonlyMap<number, TmuxServer>;
  /** The pid-to-socket cache that outlives this process; null for none. */
  cache?: SocketCache | null;
  /** What the whole drain may spend probing sockets; `SOCKET_PROBE_BUDGET_MS` by default. */
  probeBudgetMs?: number;
  /**
   * Asks sockets which server pid answers on each: `probeSockets`, unless a
   * test replaces it. A socket left out of the answer is unknown.
   */
  probe?: (sockets: readonly string[], budgetMs: number) => ReadonlyMap<string, number | null>;
};

/** Less budget than this left is no budget: not worth starting a probe for. */
const MIN_PROBE_MS = 50;

/**
 * The share of what is left of a drain's budget that one lookup's hints may
 * spend, so a hinted socket that never answers cannot starve the directory
 * scan that comes after it.
 */
const HINT_SHARE = 0.5;

/**
 * The real host: tmux and `ps`, each asked at most once per server per drain.
 *
 * A server pid is located, cheapest first, by: a server already known; the
 * socket cache, when the pid's start time still matches; the socket the hook's
 * `$TMUX` named; the socket its server's argv named; the reader's own servers;
 * and only then by asking each socket in tmux's directory that the cache does
 * not rule out. Every candidate is checked by asking it for its pid, and every
 * answer goes into the cache. Candidates are asked in parallel, and all the
 * asking in one drain shares `SOCKET_PROBE_BUDGET_MS`, of which a lookup's
 * hints get at most half of what is left: a server not found by then is null
 * this drain, and its inbox waits for the next. A probe killed at the budget
 * is not an answer: it is neither cached nor asked again this drain, and the
 * next drain asks it afresh.
 */
export function tmuxInboxHost(options: TmuxInboxHostOptions = {}): InboxHost {
  const servers = new Map<number, TmuxServer | null>(options.known ?? []);
  const panes = new Map<string, ReadonlyMap<number, InboxPane> | null>();
  let table: ProcessTable | null | undefined;
  const piUnder = new Map<string, boolean>();
  const cache = options.cache === undefined ? loadSocketCache() : options.cache;
  let directory: string | null | undefined;
  const socketDirectory = (): string | null => {
    if (directory !== undefined) return directory;
    try {
      directory = options.socketDirectory ?? conventionalTmuxDirectory();
    } catch {
      directory = null;
    }
    return directory;
  };
  const socketOf = (server: TmuxServer): string | null => {
    if (server.kind === "path") return server.value;
    const dir = socketDirectory();
    return dir === null ? null : join(dir, server.kind === "label" ? server.value : "default");
  };
  const own = options.own ?? ownServers();
  const probe = options.probe ?? probeSockets;
  const probeBudgetMs = options.probeBudgetMs ?? SOCKET_PROBE_BUDGET_MS;
  // What each socket answered this drain, the sockets asked that did not
  // answer in time, and when the drain's probe budget runs out, from the
  // first probe on.
  const answers = new Map<string, number | null>();
  const unanswered = new Set<string>();
  let deadline: number | undefined;
  const asked = (socket: string): boolean => answers.has(socket) || unanswered.has(socket);
  // Asks every candidate not yet asked this drain, in parallel, in `share` of
  // what is left of the drain's budget. Out of budget, the rest stay unasked;
  // like a probe killed at the budget, they are neither cached nor taken for
  // silent.
  const ask = (candidates: readonly (string | null)[], share = 1): void => {
    const fresh = [...new Set(candidates)].filter(
      (socket): socket is string => socket !== null && !asked(socket),
    );
    if (fresh.length === 0) return;
    deadline ??= Date.now() + probeBudgetMs;
    const left = deadline - Date.now();
    if (left < MIN_PROBE_MS) return;
    const result = probe(fresh, Math.max(MIN_PROBE_MS, Math.floor(left * share)));
    for (const socket of fresh) {
      const pid = result.get(socket);
      if (pid === undefined) {
        unanswered.add(socket);
        continue;
      }
      answers.set(socket, pid);
      cache?.record(socket, socketStat(socket), pid);
    }
  };
  /** The socket some probe this drain heard `serverPid` answer on. */
  const heard = (serverPid: number): string | null =>
    [...answers].find(([, pid]) => pid === serverPid)?.[0] ?? null;
  const locate = (serverPid: number, hints: ServerHints): string | null => {
    // `$TMUX` names the socket outright; the pid behind it is still
    // confirmed, since a restarted server can reuse the path.
    ask(
      [
        hints.tmux?.split(",")[0] || null,
        hints.socket ? socketOf(hints.socket) : null,
        ...own.map(socketOf),
      ],
      HINT_SHARE,
    );
    const hinted = heard(serverPid);
    if (hinted !== null) return hinted;
    // No hint answered (an older hook's event, a server on a socket of its
    // own): ask each socket in tmux's own directory the cache does not rule
    // out, all at once.
    const dir = socketDirectory();
    let entries: string[] = [];
    try {
      entries = dir ? readdirSync(dir).sort() : [];
    } catch {
      entries = [];
    }
    const candidates: string[] = [];
    for (const entry of entries) {
      const socket = join(dir as string, entry);
      if (asked(socket)) continue;
      const stat = socketStat(socket);
      if (stat && cache?.skip(socket, stat, serverPid, pidAlive)) continue;
      candidates.push(socket);
    }
    ask(candidates);
    return heard(serverPid);
  };
  return {
    isAlive: pidAlive,
    serverFor(serverPid, hints) {
      const known = servers.get(serverPid);
      if (known !== undefined) return known;
      let found: string | null = cache?.server(serverPid) ?? null;
      if (found === null) found = locate(serverPid, hints);
      let server: TmuxServer | null = null;
      if (found !== null) {
        try {
          server = deriveTmuxServer(found);
        } catch {
          server = { kind: "path", value: found };
        }
      }
      servers.set(serverPid, server);
      return server;
    },
    panes(server) {
      const key = `${server.kind}\0${"value" in server ? server.value : ""}`;
      const known = panes.get(key);
      if (known !== undefined) return known;
      const out = runTmux(server, [
        "list-panes",
        "-a",
        "-F",
        "#{pane_pid}\t#{pane_id}\t#{session_id}\t#{window_id}\t#{session_name}\t#{window_name}\t#{?automatic-rename,1,0}\t#{&&:#{pane_active},#{&&:#{window_active},#{session_attached}}}",
      ]);
      let result: Map<number, InboxPane> | null = null;
      if (out !== null) {
        result = new Map();
        for (const line of out.split("\n")) {
          const [pid, pane, session, window, sessionName, windowName, autoRename, active] =
            line.split("\t");
          if (!pid || !pane || !session || !window) continue;
          result.set(Number(pid), {
            location: {
              server,
              pane: asPaneId(pane),
              session: asSessionId(session),
              window: asWindowId(window),
              session_name: sessionName || null,
              window_name: chosenWindowName(windowName, autoRename),
            },
            focused: active === "1",
          });
        }
      }
      panes.set(key, result);
      return result;
    },
    piRunsUnder(rootPid, except) {
      const key = `${rootPid}:${except}`;
      const known = piUnder.get(key);
      if (known !== undefined) return known;
      if (table === undefined) table = readProcessTable();
      // Fails closed: with no process table there is no evidence the pane is
      // free of a pi, and claiming over one is the outcome this check prevents.
      const runs = table === null ? true : treeRuns(table, rootPid, "pi", except);
      piUnder.set(key, runs);
      return runs;
    },
    done() {
      cache?.save(pidAlive);
    },
  };
}

export type DrainOptions = {
  host?: InboxHost;
  mux?: Mux;
  dir?: string;
  /**
   * Drain only these pane inboxes (`inboxKey`), leaving every other one for a
   * later reader: `murmur pane` drains the pane it was asked about and no
   * other, so it never waits on another inbox's server.
   */
  keys?: readonly string[];
};

export type DrainSummary = IngestSummary & {
  /** Inbox directories deleted because their server or pane is gone. */
  removed: number;
};

const EMPTY: DrainSummary = { applied: 0, ignored: 0, malformed: 0, changed: [], removed: 0 };

function eventFiles(paneDir: string): string[] {
  try {
    return readdirSync(paneDir)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
}

function readEvent(path: string): InboxEvent | null {
  try {
    return parseInboxEvent(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}

/** A writer that died between write and link leaves its file in tmp/. */
const TEMPORARY_MAX_AGE_MS = 60 * 60 * 1000;

function sweepTemporaries(tmp: string, now = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(tmp);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(tmp, name);
    try {
      if (now - statSync(path).mtimeMs > TEMPORARY_MAX_AGE_MS) unlinkSync(path);
    } catch {
      // Linked and removed by its writer meanwhile.
    }
  }
}

/**
 * Remove a drained inbox if it is still empty. Non-recursive, so an event
 * linked in since the drain listed it keeps the directory, and a hook that
 * finds it gone recreates it (`writeInboxEvent`'s ENOENT retry).
 */
function removeIfEmpty(path: string): void {
  try {
    rmdirSync(path);
  } catch {
    // Not empty (a hook just wrote), or gone already.
  }
}

/**
 * How long an inbox whose server pid is alive but answers on no socket the
 * drain can find is kept: a server started on a socket of its own, with a hook
 * that had no `$TMUX`, or a recycled pid. Its events can never be applied.
 */
const UNLOCATED_MAX_AGE_MS = 60 * 60 * 1000;

function olderThan(path: string, age: number, now = Date.now()): boolean {
  try {
    return now - statSync(path).mtimeMs > age;
  } catch {
    return false;
  }
}

function removeDir(path: string): boolean {
  try {
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Drain every pane's inbox into the store, then publish the pane options of
 * every pane that changed.
 *
 * Three steps, and only the middle one holds the store's lock:
 *
 * 1. Locate. Each inbox's first event names its server and pane root; the
 *    host maps those to a pane. A dead server's inbox is deleted, and so is one
 *    whose root no longer roots a pane (`reconcileLocal` owns pane-id reuse).
 *    One whose server cannot be found yet is left for a later drain, until
 *    its oldest event is an hour old.
 * 2. Apply, inside `ingestInbox`'s transaction: list each located inbox in
 *    name order, hand every file to the store, delete it once handled. The
 *    emptied directory goes too.
 * 3. Publish `@murmur_pane_state` and the rest for the changed panes.
 *
 * Total: a drain never fails its caller, which is a status-bar tick.
 */
export function drainInbox(store: Store, options: DrainOptions = {}): DrainSummary {
  const dir = options.dir ?? inboxDir();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return EMPTY;
  }
  if (options.keys) {
    const keys = new Set(options.keys);
    entries = entries.filter((entry) => keys.has(entry));
    if (entries.length === 0) return EMPTY;
  }
  const host = options.host ?? tmuxInboxHost();
  try {
    return drainWith(store, host, dir, entries, options);
  } finally {
    try {
      host.done?.();
    } catch {
      // A cache not saved is a cache rebuilt by the next drain.
    }
  }
}

function drainWith(
  store: Store,
  host: InboxHost,
  dir: string,
  entries: readonly string[],
  options: DrainOptions,
): DrainSummary {
  sweepTemporaries(join(dir, "tmp"));
  let removed = 0;
  const located: { paneDir: string; server_pid: number; root_pid: number; pane: InboxPane }[] = [];

  for (const entry of entries) {
    if (entry === "tmp") continue;
    const paneDir = join(dir, entry);
    const files = eventFiles(paneDir);
    let first: InboxEvent | null = null;
    let firstFile: string | null = null;
    for (const file of files) {
      first = readEvent(join(paneDir, file));
      if (first) {
        firstFile = file;
        break;
      }
    }
    if (!first || firstFile === null) {
      // Nothing locatable. Files appear whole (linked from tmp/), so these are
      // malformed rather than half written, and can go -- and so can the
      // directory, which nothing could map to a pane again: its key is a hash.
      for (const file of files) unlinkQuietly(join(paneDir, file));
      removeIfEmpty(paneDir);
      continue;
    }
    if (!host.isAlive(first.server_pid)) {
      if (removeDir(paneDir)) removed += 1;
      continue;
    }
    const server = host.serverFor(first.server_pid, {
      tmux: first.tmux,
      socket: first.server_socket ?? null,
    });
    if (!server) {
      // Left for a later drain, but not forever: an inbox no drain can locate
      // would otherwise grow to the cap and be searched for on every drain.
      if (olderThan(join(paneDir, firstFile), UNLOCATED_MAX_AGE_MS) && removeDir(paneDir)) {
        removed += 1;
      }
      continue;
    }
    const panes = host.panes(server);
    if (!panes) continue;
    const pane = panes.get(first.root_pid);
    if (!pane) {
      if (removeDir(paneDir)) removed += 1;
      continue;
    }
    located.push({ paneDir, server_pid: first.server_pid, root_pid: first.root_pid, pane });
  }
  if (located.length === 0) return { ...EMPTY, removed };

  let summary: IngestSummary;
  try {
    summary = store.ingestInbox(
      () =>
        located.flatMap(({ paneDir, server_pid, root_pid, pane }) =>
          eventFiles(paneDir).map((file): InboxDelivery => {
            const path = join(paneDir, file);
            const parsed = readEvent(path);
            // An event naming another pane than its directory is not this pane's.
            const event =
              parsed && parsed.server_pid === server_pid && parsed.root_pid === root_pid
                ? parsed
                : null;
            return {
              location: pane.location,
              focused: pane.focused,
              event,
              // pi's own store-free mode writes events as harness `pi`: that
              // pi is the pane's one writer, never a pi to stand aside for.
              piRuns: () =>
                event?.harness === "pi" ? false : host.piRunsUnder(root_pid, event?.owner_pid ?? 0),
              consume: () => unlinkSync(path),
            };
          }),
        ),
      { isAlive: host.isAlive },
    );
  } catch {
    return { ...EMPTY, removed };
  }
  // A drained inbox goes: its key is a one-way hash, so an empty directory
  // could never be checked against its server or pane again.
  for (const { paneDir } of located) removeIfEmpty(paneDir);

  publishChanged(store, options.mux ?? tmux, summary.changed);
  return { ...summary, removed };
}

function publishChanged(store: Store, mux: Mux, changed: readonly Location[]): void {
  const windows = new Map<string, { window: Location["window"]; server: TmuxServer }>();
  for (const location of changed) {
    const server = location.server;
    windows.set(`${server.kind}\0${"value" in server ? server.value : ""}\0${location.window}`, {
      window: location.window,
      server,
    });
  }
  for (const { window, server } of windows.values()) {
    try {
      publishAgentStates(window, mux, store, server);
    } catch {
      // Presentation is best effort; the store already holds the truth.
    }
  }
}

/** How many events wait in each pane inbox, for `doctor`. */
export function inboxBacklog(dir = inboxDir()): { key: string; waiting: number }[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry !== "tmp")
    .map((key) => ({ key, waiting: eventFiles(join(dir, key)).length }));
}
