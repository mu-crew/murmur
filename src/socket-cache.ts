import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureDir } from "./dirs.js";
import { stateDir } from "./paths.js";
import { processStartTimes } from "./process-chain.js";

/**
 * Which socket each tmux server listens on, remembered across processes.
 *
 * A hook with no `$TMUX` (Muse's, whose environment is cleared) records the
 * server's pid, and the drain must find that server's socket. Asking each
 * socket in tmux's directory costs a tmux client per socket, up to its timeout
 * for one that accepts and never answers, and every `murmur` process used to
 * pay it again. This file keeps the answers:
 *
 * - `servers`: a server pid's socket, with the server's start time. An entry
 *   counts only while a process with that pid AND that start time lives, so a
 *   recycled pid never inherits a socket. A server's socket path is fixed for
 *   its life, so a matching entry needs no tmux call at all.
 * - `sockets`: what each socket answered when last asked (a server pid, or
 *   nothing), with the file's inode and mtime. A scan skips a socket that is
 *   unchanged and either answered nothing a short while ago, or belongs to
 *   another live server.
 *
 * Advisory and best effort, like every inbox hint: an unreadable file is an
 * empty cache, a failed write is a cache not kept, and nothing here throws.
 */

/** How long a socket that answered nothing is skipped by a scan. */
export const SILENT_SOCKET_TTL_MS = 10 * 60 * 1000;

type ServerEntry = { started: number; socket: string };
type SocketEntry = { ino: number; mtime: number; pid: number | null; at: number };
type CacheFile = {
  v: 1;
  servers: Record<string, ServerEntry>;
  sockets: Record<string, SocketEntry>;
};

export type SocketStat = { ino: number; mtime: number };

export type SocketCache = {
  /** The socket the server `pid` listens on, if recorded for this very process. */
  server(pid: number): string | null;
  /**
   * Whether a scan for `wanted` can skip `socket`: unchanged since it last
   * answered, and then it answered nothing (recently) or another live server.
   */
  skip(
    socket: string,
    stat: SocketStat,
    wanted: number,
    isAlive: (pid: number) => boolean,
  ): boolean;
  /** What `socket` answered just now: a server pid, or null for nothing. */
  record(socket: string, stat: SocketStat | null, pid: number | null): void;
  /** Write the file back if anything changed, dropping dead servers' entries. */
  save(isAlive: (pid: number) => boolean): void;
};

/** The cache file's default place: the state directory, which only readers use. */
export function socketCachePath(): string {
  return join(stateDir(), "tmux-sockets.json");
}

function readCache(path: string): CacheFile {
  const empty: CacheFile = { v: 1, servers: {}, sockets: {} };
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Partial<CacheFile> | null;
    if (data?.v !== 1) return empty;
    const servers: Record<string, ServerEntry> = {};
    for (const [pid, entry] of Object.entries(data.servers ?? {})) {
      if (typeof entry?.started === "number" && typeof entry.socket === "string") {
        servers[pid] = { started: entry.started, socket: entry.socket };
      }
    }
    const sockets: Record<string, SocketEntry> = {};
    for (const [socket, entry] of Object.entries(data.sockets ?? {})) {
      if (
        typeof entry?.ino === "number" &&
        typeof entry.mtime === "number" &&
        typeof entry.at === "number" &&
        (entry.pid === null || typeof entry.pid === "number")
      ) {
        sockets[socket] = { ino: entry.ino, mtime: entry.mtime, pid: entry.pid, at: entry.at };
      }
    }
    return { v: 1, servers, sockets };
  } catch {
    return empty;
  }
}

/**
 * The cache at `path`, read once. `null` is a cache that remembers nothing and
 * writes nothing. `now` and `startTimes` are seams for tests.
 */
export function loadSocketCache(
  path: string | null = socketCachePath(),
  options: {
    now?: () => number;
    startTimes?: (pids: readonly number[]) => ReadonlyMap<number, number>;
  } = {},
): SocketCache {
  const now = options.now ?? Date.now;
  const startTimes = options.startTimes ?? processStartTimes;
  const file: CacheFile = path === null ? { v: 1, servers: {}, sockets: {} } : readCache(path);
  // Start times read so far this process, so a pid costs at most one `ps`.
  const started = new Map<number, number | null>();
  const startOf = (pids: readonly number[]): void => {
    const missing = pids.filter((pid) => !started.has(pid));
    if (missing.length === 0) return;
    const times = startTimes(missing);
    for (const pid of missing) started.set(pid, times.get(pid) ?? null);
  };
  // Servers found this process, timed in one `ps` when the file is written.
  const found = new Map<number, string>();
  let changed = false;

  return {
    server(pid) {
      const fresh = found.get(pid);
      if (fresh !== undefined) return fresh;
      const entry = file.servers[String(pid)];
      if (!entry) return null;
      startOf([pid]);
      return started.get(pid) === entry.started ? entry.socket : null;
    },
    skip(socket, stat, wanted, isAlive) {
      const entry = file.sockets[socket];
      if (!entry || entry.ino !== stat.ino || entry.mtime !== stat.mtime) return false;
      if (entry.pid === null) return now() - entry.at < SILENT_SOCKET_TTL_MS;
      return entry.pid !== wanted && isAlive(entry.pid);
    },
    record(socket, stat, pid) {
      if (pid !== null) found.set(pid, socket);
      if (stat === null) return;
      file.sockets[socket] = { ino: stat.ino, mtime: stat.mtime, pid, at: now() };
      changed = true;
    },
    save(isAlive) {
      if (path === null) return;
      if (found.size > 0) {
        startOf([...found.keys()]);
        for (const [pid, socket] of found) {
          const time = started.get(pid);
          if (time === null || time === undefined) continue;
          const key = String(pid);
          if (file.servers[key]?.started === time && file.servers[key]?.socket === socket) continue;
          file.servers[key] = { started: time, socket };
          changed = true;
        }
      }
      for (const key of Object.keys(file.servers)) {
        if (!isAlive(Number(key))) {
          delete file.servers[key];
          changed = true;
        }
      }
      const at = now();
      for (const [socket, entry] of Object.entries(file.sockets)) {
        const dead = entry.pid !== null && !isAlive(entry.pid);
        if (dead || (entry.pid === null && at - entry.at >= SILENT_SOCKET_TTL_MS)) {
          delete file.sockets[socket];
          changed = true;
        }
      }
      if (!changed) return;
      const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}`;
      try {
        ensureDir(dirname(path));
        writeFileSync(temporary, `${JSON.stringify(file)}\n`);
        renameSync(temporary, path);
        changed = false;
      } catch {
        try {
          unlinkSync(temporary);
        } catch {
          // Never written.
        }
      }
    },
  };
}
