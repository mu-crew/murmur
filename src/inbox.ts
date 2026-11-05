import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { publishAgentStates } from "./agent-state.js";
import { ensureDir } from "./dirs.js";
import { asPaneId, asSessionId, asWindowId } from "./ids.js";
import { type InboxEvent, parseInboxEvent } from "./inbox-event.js";
import {
  chosenWindowName,
  conventionalTmuxDirectory,
  deriveTmuxServer,
  type Mux,
  pidAlive,
  tmux,
  tmuxArgs,
} from "./mux.js";
import { stateDir } from "./paths.js";
import { type ProcessTable, readProcessTable, treeRuns } from "./process-chain.js";
import type { Store } from "./store.js";
import type { InboxDelivery, IngestSummary, LiveCheck, Location, TmuxServer } from "./types.js";

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

/** Past this many waiting files a pane's hook stops writing. `doctor` reports it. */
export const INBOX_PANE_CAP = 10_000;

export function inboxDir(): string {
  return join(stateDir(), "inbox");
}

/**
 * The directory name for one pane: a hash of the tmux server pid and the pane
 * root pid. Both are what the hook can see; the drain maps them to a pane.
 */
export function inboxKey(serverPid: number, rootPid: number): string {
  return createHash("sha256").update(`${serverPid}:${rootPid}`).digest("hex").slice(0, 32);
}

/** Wall-clock nanoseconds, zero-padded so name order is time order. */
function nanoseconds(): bigint {
  return BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));
}

function eventName(ns: bigint, pid: number): string {
  return `${ns.toString().padStart(20, "0")}-${String(pid).padStart(10, "0")}.json`;
}

/**
 * Write one event into its pane's inbox. Never throws, prints nothing, and
 * answers whether the event landed.
 *
 * Written whole under `tmp/`, then LINKED into place: `link` is atomic like
 * `rename`, and unlike it refuses to replace a file, so two events with one name
 * (the same pid in the same nanosecond) cannot overwrite each other -- the
 * second steps its timestamp and tries again.
 */
export function writeInboxEvent(
  event: InboxEvent,
  dir = inboxDir(),
  cap = INBOX_PANE_CAP,
): boolean {
  let temporary: string | null = null;
  try {
    const paneDir = join(dir, inboxKey(event.server_pid, event.root_pid));
    const tmp = join(dir, "tmp");
    ensureDir(tmp);
    makeDir(paneDir);
    let waiting = 0;
    try {
      waiting = readdirSync(paneDir).length;
    } catch {
      waiting = 0;
    }
    if (waiting >= cap) return false;
    let ns = nanoseconds();
    const written = join(
      tmp,
      `${eventName(ns, process.pid)}.${Math.random().toString(36).slice(2)}`,
    );
    temporary = written;
    writeFileSync(written, JSON.stringify(event), { flag: "wx" });
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const target = join(paneDir, eventName(ns, process.pid));
      try {
        linkSync(written, target);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST") {
          ns += 1n;
          continue;
        }
        if (!directoryGone(code)) {
          // A filesystem without hard links: rename is still atomic.
          try {
            renameSync(written, target);
            temporary = null;
            return true;
          } catch (renameError) {
            if (!directoryGone((renameError as NodeJS.ErrnoException).code)) throw renameError;
          }
        }
        // A drain removed the pane's directory since the mkdir: it emptied it,
        // or its server died. Recreated, so the event is not lost to a race.
        makeDir(paneDir);
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    if (temporary !== null) {
      try {
        unlinkSync(temporary);
      } catch {
        // Gone already, or renamed into place.
      }
    }
  }
}

/**
 * Whether a link or rename failed because the target directory was removed
 * under it: ENOENT, or EINVAL, which macOS returns for a directory unlinked
 * between the lookup and the link.
 */
function directoryGone(code: string | undefined): boolean {
  return code === "ENOENT" || code === "EINVAL";
}

/** `mkdir` that treats "already there" as success, under a parent that exists. */
function makeDir(path: string): void {
  try {
    mkdirSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

/** One pane of a tmux server, keyed by its root process. */
export type InboxPane = { location: Location; focused: boolean };

/**
 * What the drain asks of tmux and the process table. A seam so tests need
 * neither, and so the real one can cache within a drain.
 */
export interface InboxHost {
  isAlive: LiveCheck;
  /**
   * The tmux server whose pid is `serverPid`, mapped the way the collector maps
   * one (`deriveTmuxServer` over its socket path), or null when no server
   * answers to it. `tmuxEnv` is the `$TMUX` the hook saw, when it had one.
   */
  serverFor(serverPid: number, tmuxEnv: string | null): TmuxServer | null;
  /** That server's panes by pane pid. Null when tmux could not answer. */
  panes(server: TmuxServer): ReadonlyMap<number, InboxPane> | null;
  /**
   * Whether a pi runs at or below `rootPid`, outside the subtree of `except`
   * (the event's own harness): a pi that harness started is its nested agent,
   * not the pane's owner.
   */
  piRunsUnder(rootPid: number, except: number): boolean;
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

function serverPidAt(socket: string): number | null {
  const out = runTmux({ kind: "path", value: socket }, ["list-sessions", "-F", "#{pid}"]);
  const pid = Number(out?.split("\n")[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * The real host: tmux and `ps`, each asked at most once per server per drain.
 *
 * `socketDirectory` is where a server with no `$TMUX` hint is looked for:
 * tmux's own directory unless a test points it at a private one.
 */
export function tmuxInboxHost(options: { socketDirectory?: string } = {}): InboxHost {
  const servers = new Map<number, TmuxServer | null>();
  const panes = new Map<string, ReadonlyMap<number, InboxPane> | null>();
  let table: ProcessTable | null | undefined;
  const piUnder = new Map<string, boolean>();
  return {
    isAlive: pidAlive,
    serverFor(serverPid, tmuxEnv) {
      const known = servers.get(serverPid);
      if (known !== undefined) return known;
      let found: TmuxServer | null = null;
      // `$TMUX` names the socket outright; confirm the pid behind it, since a
      // restarted server can reuse the path.
      const hinted = tmuxEnv?.split(",")[0];
      if (hinted && serverPidAt(hinted) === serverPid) {
        found = deriveTmuxServer(hinted);
      } else {
        // No `$TMUX` (a harness that clears its hooks' environment): ask each
        // socket in tmux's own directory which server it is.
        let directory: string | null = options.socketDirectory ?? null;
        try {
          directory ??= conventionalTmuxDirectory();
        } catch {
          directory = null;
        }
        let entries: string[] = [];
        try {
          entries = directory ? readdirSync(directory) : [];
        } catch {
          entries = [];
        }
        for (const entry of entries) {
          const socket = join(directory as string, entry);
          if (serverPidAt(socket) === serverPid) {
            found = deriveTmuxServer(socket);
            break;
          }
        }
      }
      servers.set(serverPid, found);
      return found;
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
  };
}

export type DrainOptions = {
  host?: InboxHost;
  mux?: Mux;
  dir?: string;
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
  const host = options.host ?? tmuxInboxHost();
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
    const server = host.serverFor(first.server_pid, first.tmux);
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
              piRuns: () => host.piRunsUnder(root_pid, event?.owner_pid ?? 0),
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
