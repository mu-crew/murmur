import { closeSync, existsSync, openSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { ensureDir } from "./dirs.js";
import { asPaneId, asSessionId, asWindowId } from "./ids.js";
import { currentJumpCommand, defaultJumpCommand } from "./jump-command.js";
import { migrateLegacyIdentity, withLegacyStoreCopy } from "./legacy-state.js";
import { dbPath, legacyStateDir, stateDir } from "./paths.js";
import { parseSnapshot } from "./snapshot.js";
import type {
  Driver,
  LocalSync,
  Location,
  PaneIdentity,
  PaneState,
  PeerFetch,
  PeerRecord,
  ServerRead,
  Snapshot,
  SnapshotPane,
  TmuxServer,
} from "./types.js";
import { paneKey, serverValue } from "./types.js";

/**
 * The storage version. Any change to any table bumps it.
 *
 * 13 is murmur 3.0, in its own state directory (`murmur3`): no agent rows, no
 * inbox, only what the multiplexer cannot remember for murmur. Older
 * incompatible files are rebuilt with just the configured peers.
 *
 * 14 adds the nullable `peers.rex_host`, upgraded in place (see `UPGRADES`).
 */
const SCHEMA_USER_VERSION = 14;

/**
 * The oldest schema whose build can read and write a store this build creates,
 * stamped into the file beside `user_version` (the `compat` table). A later
 * build that only adds nullable columns bumps `SCHEMA_USER_VERSION` and keeps
 * this stamp, so a build like this one opens its newer store instead of
 * refusing it: every INSERT here names its columns.
 */
const COMPATIBLE_SINCE = 13;

/**
 * In-place upgrades, keyed by the schema they upgrade FROM. Only additive,
 * nullable columns belong here: a store at a key is upgraded step by step to
 * `SCHEMA_USER_VERSION` and keeps every row, where anything older is rebuilt.
 */
const UPGRADES: Readonly<Record<number, string>> = {
  13: "ALTER TABLE peers ADD COLUMN rex_host TEXT",
};

/** Whether a store at `version` upgrades in place rather than being rebuilt. */
function upgradable(version: number): boolean {
  for (let step = version; step < SCHEMA_USER_VERSION; step += 1) {
    if (UPGRADES[step] === undefined) return false;
  }
  return version < SCHEMA_USER_VERSION;
}

type Database = BetterSqlite3.Database;
type OpenOptions = { fileMustExist?: boolean; readonly?: boolean };

/** The slice of `bun:sqlite` this file uses. */
type BunDatabase = {
  prepare(source: string): { all(): Record<string, unknown>[] };
};
type BunDatabaseConstructor = new (
  path: string,
  options: { readonly?: boolean; readwrite?: boolean; create?: boolean; strict?: boolean },
) => BunDatabase;

/**
 * better-sqlite3 under Node, `bun:sqlite` under Bun.
 *
 * An SDK consumer can run on Bun, and Bun cannot load better-sqlite3's native
 * addon: the load is a `NAPI FATAL ERROR` panic that takes the process down,
 * not an exception a lazy import could swallow. So the driver is chosen at
 * runtime with `require`, never a static import, which would load the addon
 * the moment this module is evaluated.
 *
 * `bun:sqlite` covers everything used below with the same names, except two
 * gaps the Bun branch fills:
 *
 * - No `pragma()`. It is a `PRAGMA` statement, with `{ simple: true }` reading
 *   the first column of the first row, as better-sqlite3 does.
 * - Different constructor options. `fileMustExist` is "read and write, never
 *   create"; `strict: true` binds `@name` parameters from plain object keys, as
 *   better-sqlite3 does.
 *
 * One difference stays: Bun's `get()` returns `null` for no row where
 * better-sqlite3 returns `undefined`. Every caller here tests the result for
 * truthiness, so both read as "no row".
 */
const openDatabase: (path: string, options?: OpenOptions) => Database = (() => {
  const require = createRequire(import.meta.url);
  if (process.versions.bun === undefined) {
    const NodeDatabase = require("better-sqlite3") as typeof BetterSqlite3;
    return (path, options) => new NodeDatabase(path, options);
  }
  const { Database: BunDatabaseClass } = require("bun:sqlite") as {
    Database: BunDatabaseConstructor;
  };
  return (path, options = {}) => {
    const opened = new BunDatabaseClass(path, {
      readonly: options.readonly === true,
      readwrite: options.readonly !== true,
      create: options.readonly !== true && options.fileMustExist !== true,
      strict: true,
    });
    const pragma = (source: string, pragmaOptions?: { simple?: boolean }): unknown => {
      const rows = opened.prepare(`PRAGMA ${source}`).all();
      if (pragmaOptions?.simple !== true) return rows;
      const first = rows[0];
      return first === undefined ? undefined : Object.values(first)[0];
    };
    return Object.assign(opened, { pragma }) as unknown as Database;
  };
})();

/**
 * How long to wait for another process's reset before stealing its lock.
 *
 * A reset is a handful of file operations, so a lock held longer than this is a
 * dead holder rather than a slow one. Matches `busy_timeout`, since both bound
 * "wait for another process to finish writing".
 */
const RESET_LOCK_TIMEOUT_MS = 5_000;

const SCHEMA = `
  -- The last state each live local pane was seen in, and since when. The one
  -- memory the multiplexer does not keep for murmur: a pane that vanishes
  -- between two collects leaves its last state here, which is how a crash of
  -- an unretained pane (remain-on-exit off) is told from a pane that finished.
  CREATE TABLE seen (
    server_kind  TEXT    NOT NULL CHECK (server_kind IN ('default', 'label', 'path', 'rex')),
    server_value TEXT    NOT NULL,
    pane         TEXT    NOT NULL,
    state        TEXT    NOT NULL CHECK (state IN ('crashed', 'error', 'blocked', 'done', 'running', 'waiting', 'idle')),
    since        INTEGER NOT NULL,
    session      TEXT    NOT NULL,
    window       TEXT    NOT NULL,
    session_name TEXT,
    window_name  TEXT,
    agent_name   TEXT,
    workstream   TEXT,
    role         TEXT,
    driver       TEXT    NOT NULL CHECK (driver IN ('human', 'orchestrated')),
    harness      TEXT,
    cli          TEXT,
    pane_title   TEXT,
    PRIMARY KEY (server_kind, server_value, pane)
  ) STRICT;

  -- A pane that vanished while it was working or blocked: murmur's own word,
  -- kept until someone acknowledges it (\`murmur clear\`, the dash) or a new
  -- pane takes the address. Carries the identity it was last seen with, so
  -- the row still says WHICH agent died.
  CREATE TABLE crashed (
    server_kind  TEXT    NOT NULL CHECK (server_kind IN ('default', 'label', 'path', 'rex')),
    server_value TEXT    NOT NULL,
    pane         TEXT    NOT NULL,
    session      TEXT    NOT NULL,
    window       TEXT    NOT NULL,
    session_name TEXT,
    window_name  TEXT,
    agent_name   TEXT,
    workstream   TEXT,
    role         TEXT,
    driver       TEXT    NOT NULL CHECK (driver IN ('human', 'orchestrated')),
    harness      TEXT,
    cli          TEXT,
    pane_title   TEXT,
    last_state   TEXT    NOT NULL,
    requested_at INTEGER NOT NULL,
    PRIMARY KEY (server_kind, server_value, pane)
  ) STRICT;

  -- Which attention events the on-attention hook has already been run for, so
  -- concurrent collects (status bar, dash, side panel) fire each one once. The
  -- key names the event, not the row: host, server, pane, kind and
  -- requested_at, so a re-raised request is a new event.
  CREATE TABLE alerted (
    key          TEXT    NOT NULL PRIMARY KEY,
    alerted_at   INTEGER NOT NULL
  ) STRICT;

  -- One row: the oldest schema that can use this file. See COMPATIBLE_SINCE.
  CREATE TABLE compat (
    compatible_since INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE peers (
    name             TEXT NOT NULL PRIMARY KEY,
    target           TEXT NOT NULL,
    jump_command     TEXT NOT NULL,
    host_id          TEXT,
    display_name     TEXT,
    snapshot         TEXT,
    snapshot_at      INTEGER,
    fetched_at       INTEGER,
    last_attempt_at  INTEGER,
    last_error       TEXT,
    murmur_version   TEXT,
    snapshot_version INTEGER,
    rex_host         TEXT
  ) STRICT;
`;

/**
 * The store, and the only place in murmur that holds a database handle or
 * writes SQL.
 *
 * From 3.0 it holds no agent state at all: a local pane's state is its
 * multiplexer's (OSC 7501), read fresh on every collect. What is left is what
 * only murmur can know -- which panes vanished mid-work, which alerts have
 * fired -- and the peer cache.
 *
 * CLOSED: no `append`, no log read, no partial-row update, no handle.
 */
export interface Store {
  // --- local memory -------------------------------------------------------
  /**
   * Record what one collect saw, in one transaction, and answer what murmur
   * concluded: since when each live pane has been in its state, and which
   * panes vanished while working or blocked (each now carries a `crashed`
   * row). A server read as null is no evidence and changes nothing.
   */
  syncLocal(reads: readonly ServerRead[], now?: number): LocalSync;
  /** Every server a previous collect saw, so a server whose socket vanished is still asked. */
  knownServers(): TmuxServer[];
  /** The crashes murmur recorded, as attention-only snapshot panes. */
  localPanes(): SnapshotPane[];
  /**
   * Record a crash for a pane, as \`syncLocal\` would on a vanished one.
   * Named so a caller reaching for it has to mean it: tests seeding a crashed
   * row are the honest use.
   */
  recordCrash(location: Location, now?: number): void;
  /** Dismiss murmur's own attention for a pane (its \`crashed\` row). Returns rows removed. */
  acknowledgePane(address: PaneIdentity): number;

  // --- alert dedup --------------------------------------------------------
  /**
   * Claim attention events for the on-attention hook, and answer which keys
   * this caller won. Atomic per key, so two processes collecting at once never
   * both fire one event. Also forgets claims older than \`retainMs\` whose
   * event is no longer in \`current\`.
   */
  claimAlerts(
    keys: readonly string[],
    current: readonly string[],
    now: number,
    retainMs: number,
  ): string[];

  // --- peer cache ---------------------------------------------------------
  peers(): PeerRecord[];
  addPeer(name: string, target: string, jumpCommand?: string): void;
  setPeerJumpCommand(name: string, jumpCommand: string): boolean;
  /** The `rex -S` label reaching this peer's Rex server; null clears it. */
  setPeerRexHost(name: string, rexHost: string | null): boolean;
  removePeer(name: string): boolean;
  /**
   * \`target\` is the target the fetch was made against: a write for a peer
   * retargeted since is dropped, so one node's answer never lands on another.
   */
  replacePeerSnapshot(name: string, fetch: PeerFetch, target?: string): void;

  close(): void;
}

/** The states a pane can vanish in that mean its program died mid-work. */
const MID_WORK: readonly PaneState[] = ["running", "waiting", "blocked"];

type SeenDbRow = {
  server_kind: TmuxServer["kind"];
  server_value: string;
  pane: string;
  state: PaneState;
  since: number;
  session: string;
  window: string;
  session_name: string | null;
  window_name: string | null;
  agent_name: string | null;
  workstream: string | null;
  role: string | null;
  driver: Driver;
  harness: string | null;
  cli: string | null;
  pane_title: string | null;
};

type CrashedDbRow = Omit<SeenDbRow, "state" | "since"> & {
  last_state: string;
  requested_at: number;
};

function serverFromRow(row: { server_kind: TmuxServer["kind"]; server_value: string }): TmuxServer {
  if (row.server_kind === "default" || row.server_kind === "rex") return { kind: row.server_kind };
  return { kind: row.server_kind, value: row.server_value };
}

function crashedPane(row: CrashedDbRow): SnapshotPane {
  return {
    server: serverFromRow(row),
    pane: asPaneId(row.pane),
    session: asSessionId(row.session),
    window: asWindowId(row.window),
    session_name: row.session_name,
    window_name: row.window_name,
    // The identity it was last seen with: a crash that cannot say which agent
    // died is half a report.
    agent: {
      activity: "stopped",
      agent_name: row.agent_name,
      workstream: row.workstream,
      role: row.role,
      driver: row.driver,
      cli: row.cli,
      harness: row.harness,
      pane_title: row.pane_title,
      title: null,
      message: null,
      progress: null,
      blocked_kind: null,
      pending: null,
      resume_command: null,
      resume_cwd: null,
      cwd: null,
      updated_at: row.requested_at,
    },
    attention: [
      {
        kind: "crashed",
        message: `pane vanished while ${row.last_state === "running" ? "working" : row.last_state}`,
        source: "murmur",
        driver: row.driver,
        requested_at: row.requested_at,
      },
    ],
  };
}

type PeerDbRow = {
  name: string;
  target: string;
  jump_command: string;
  host_id: string | null;
  display_name: string | null;
  snapshot: string | null;
  snapshot_at: number | null;
  fetched_at: number | null;
  last_attempt_at: number | null;
  last_error: string | null;
  murmur_version: string | null;
  snapshot_version: number | null;
  rex_host: string | null;
};

/**
 * Hold an exclusive lock beside the database while `work` runs, and return its
 * result.
 *
 * Serialises the salvage-and-delete sequence across processes. Best effort in
 * both directions, deliberately: a lock that could make murmur refuse to start
 * would be worse than the race it prevents, so a lock held implausibly long is
 * stolen and any inability to lock falls through to doing the work anyway.
 *
 * `wx` is atomic create-or-fail, which is what makes the file a lock. The wait
 * is a synchronous spin because every caller of `openStore` is synchronous --
 * `Atomics.wait` needs a SharedArrayBuffer and buys nothing here, since the
 * critical section is a few file operations and contention is a once-per-
 * upgrade burst rather than a steady state.
 */
function withResetLock<T>(path: string, work: () => T): T {
  const lock = `${path}.reset-lock`;
  const deadline = Date.now() + RESET_LOCK_TIMEOUT_MS;
  let held = false;
  while (!held) {
    try {
      closeSync(openSync(lock, "wx"));
      held = true;
    } catch {
      // Still held by someone else. Keep trying until the deadline, then treat
      // the holder as dead -- a lock this old means a process died mid-reset,
      // and hanging a status-bar tick forever is worse than stealing it.
      if (Date.now() < deadline) continue;
      try {
        rmSync(lock, { force: true });
      } catch {
        break; // Cannot even remove it; proceed unlocked.
      }
    }
  }
  try {
    return work();
  } finally {
    if (held) {
      try {
        rmSync(lock, { force: true });
      } catch {
        // Left behind; the next opener's timeout steals it.
      }
    }
  }
}

type SalvagedPeer = {
  name: string;
  target: string;
  jump_command?: string;
  rex_host?: string | null;
};

/** The human-authored fields of every peer in `database`, whatever its schema. */
function peerRows(database: Database): SalvagedPeer[] {
  const columns = database.prepare("PRAGMA table_info(peers)").all() as { name: string }[];
  const extra = ["jump_command", "rex_host"]
    .filter((name) => columns.some((column) => column.name === name))
    .map((name) => `, ${name}`)
    .join("");
  return database.prepare(`SELECT name, target${extra} FROM peers`).all() as SalvagedPeer[];
}

/** Human-authored peer fields, and the only state worth salvaging. */
function salvagePeers(path: string): SalvagedPeer[] {
  try {
    const existing = openDatabase(path, { fileMustExist: true });
    try {
      const version = (existing.pragma("user_version", { simple: true }) as number) ?? 0;
      if (usable(existing, version) || upgradable(version)) return [];
      return peerRows(existing);
    } catch {
      // Too old to have the table, or unreadable. Nothing to save.
      return [];
    } finally {
      existing.close();
    }
  } catch {
    // No database yet, or one too broken to open.
    return [];
  }
}

/**
 * The peers of a 2.x murmur's store, for a store this build is creating for
 * the first time (see `src/legacy-state.ts`). Read from a private copy, so the
 * old directory is never written, and only from a schema this build can read:
 * its own or older, or a newer one whose `compat` stamp admits it.
 */
function legacyPeers(from: string | null): SalvagedPeer[] {
  return withLegacyStoreCopy(
    from,
    (copy) => {
      const existing = openDatabase(copy, { fileMustExist: true });
      try {
        const version = (existing.pragma("user_version", { simple: true }) as number) ?? 0;
        if (version > SCHEMA_USER_VERSION && !usable(existing, version)) return [];
        return peerRows(existing);
      } catch {
        // No peers table (too old), or a copy taken mid-write. Nothing to bring.
        return [];
      } finally {
        existing.close();
      }
    },
    [],
  );
}

/**
 * Whether `path` holds a murmur store of any version: false for no file, and
 * for the empty one a first open leaves when it dies before its schema commits
 * (`user_version` 0, no `peers` table). True for a file it cannot read, which
 * the reset path deals with.
 */
function holdsMurmurStore(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const existing = openDatabase(path, { fileMustExist: true });
    try {
      const version = (existing.pragma("user_version", { simple: true }) as number) ?? 0;
      if (version !== 0) return true;
      return (
        existing
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'peers'")
          .get() !== undefined
      );
    } finally {
      existing.close();
    }
  } catch {
    return true;
  }
}

/**
 * A store written by a newer murmur than this one.
 *
 * Refused, never rebuilt: rebuilding downward would wipe a newer build's rows
 * on every open, a status-bar tick included. An older build stays out of the
 * way instead: a CLI verb prints this and exits.
 */
export class StoreTooNewError extends Error {
  constructor(
    readonly path: string,
    readonly found: number,
  ) {
    super(
      `${path} was written by a newer murmur (schema ${found}, this build ${SCHEMA_USER_VERSION}). ` +
        "Upgrade this murmur: `npm i -g @mu-crew/murmur@latest`. " +
        `To downgrade on purpose, delete ${path}.`,
    );
    this.name = "StoreTooNewError";
  }
}

/**
 * Whether this build can use a store at `version`: its own, or a newer one whose
 * `compat` stamp says a build at this schema can still read and write it.
 *
 * A missing or unreadable stamp on a newer file is "no": refusing is the
 * direction that cannot wipe another build's rows.
 */
function usable(database: Database, version: number): boolean {
  if (version === SCHEMA_USER_VERSION) return true;
  if (version < SCHEMA_USER_VERSION) return false;
  try {
    const row = database.prepare("SELECT MAX(compatible_since) AS since FROM compat").get() as
      | { since: number | null }
      | undefined;
    return typeof row?.since === "number" && row.since <= SCHEMA_USER_VERSION;
  } catch {
    return false;
  }
}

/**
 * What the file on disk needs before it can be opened. One read decides, and it
 * runs before salvage or counting, so a too-new store is left exactly as found.
 */
function storeCondition(path: string): "ok" | "reset" | StoreTooNewError {
  let existing: Database;
  try {
    existing = openDatabase(path, { fileMustExist: true });
  } catch {
    // No file yet. Nothing to remove, and the schema is created below.
    return "ok";
  }
  try {
    const version = (existing.pragma("user_version", { simple: true }) as number) ?? 0;
    if (usable(existing, version) || upgradable(version)) return "ok";
    if (version > SCHEMA_USER_VERSION) return new StoreTooNewError(path, version);
    return "reset";
  } catch {
    // Opened but unreadable: not a database, or damaged past the header. This
    // is the case that used to answer `false` and crash every later command.
    return "reset";
  } finally {
    existing.close();
  }
}

/**
 * Open the store (`{ readonly: true }` for a read-only open) and mint no identity.
 *
 * `openStore` deliberately never mints an `identity.json`: identity is created
 * only by `murmur init`, so a read path — a status-bar tick, a dash —
 * cannot bring a node into existence as a side effect. The one exception is
 * migration, not minting: when it creates the store for the first time it
 * copies a 2.x node's existing `identity.json` across (`src/legacy-state.ts`).
 */
export function openStore(options: { readonly?: boolean } = {}): Store {
  const path = dbPath();
  const database =
    options.readonly === true ? openReadonlyDatabase(path) : openWritableDatabase(path);
  return buildStore(database);
}

/**
 * Open an existing store without writing to it: no directory creation, no reset
 * lock, no migration, no journal-mode change. A missing file throws (SQLite's
 * cannot-open error), a too-new store throws `StoreTooNewError`, and a store at
 * an older schema throws too, since only a read-write open may upgrade it.
 * Write methods on the result fail with SQLite's "readonly database" error.
 */
function openReadonlyDatabase(path: string): Database {
  const opened = openDatabase(path, { fileMustExist: true, readonly: true });
  try {
    opened.pragma("busy_timeout = 5000");
    const version = (opened.pragma("user_version", { simple: true }) as number) ?? 0;
    if (usable(opened, version)) return opened;
    if (version > SCHEMA_USER_VERSION) throw new StoreTooNewError(path, version);
    throw new Error(
      `${path} is at schema ${version}, this build needs ${SCHEMA_USER_VERSION}; ` +
        "open it read-write once (any murmur command) to upgrade it.",
    );
  } catch (error) {
    opened.close();
    throw error;
  }
}

function openWritableDatabase(path: string): Database {
  ensureDir(dirname(path));

  // The whole sequence under ONE lock: salvage, delete, rebuild. Deleting the
  // database FILE is the operation SQLite cannot serialise for us, since there
  // is no handle to hold a transaction on across removing the file it lives in.
  //
  // Unlocked, this lost data a person typed, reproducibly: peer rows vanished in
  // 6 of 12 concurrent upgrade runs measured against `dist/`. Each process
  // salvaged, each agreed a reset was needed, and then each deleted the file,
  // `-wal` included, so one `rmSync` destroyed the database another had just
  // rebuilt and took its salvage with it.
  //
  // Delete and rebuild must be in the SAME critical section, which took three
  // attempts to get right: serialising the delete alone still lost the peer
  // about 1 run in 25, because the winner dropped the lock with the file gone
  // and the schema not yet written, and whoever entered that window salvaged
  // nothing from a database that did not exist yet. The invariant is that no
  // other process ever observes the store mid-rebuild.
  //
  // Peers are the only rows worth this trouble: every other fact is re-observed
  // within a tick, while a name and target cannot be re-derived from anything.
  const database = withResetLock(path, () => {
    const condition = storeCondition(path);
    if (condition instanceof StoreTooNewError) throw condition;
    // A store created for the first time starts with a 2.x murmur's peers,
    // read from its directory without touching it, and takes its identity
    // along: the first command after an upgrade may never read identity.
    //
    // "For the first time" is decided by what the file holds, not by whether it
    // exists: the file appears at the first `openDatabase` below, before the
    // schema transaction commits, so an open killed or failed in between would
    // otherwise leave an empty file that hid the 2.x peers for good.
    let salvaged: SalvagedPeer[];
    if (holdsMurmurStore(path)) salvaged = salvagePeers(path);
    else {
      const legacy = legacyStateDir();
      migrateLegacyIdentity(legacy, stateDir());
      salvaged = legacyPeers(legacy);
    }
    if (condition === "reset") {
      // Nothing here is history: crashes and alert claims are re-derived or
      // simply news that has passed, and peers are kept.
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    }

    const opened = openDatabase(path);
    opened.pragma("journal_mode = WAL");
    opened.pragma("busy_timeout = 5000");

    // The common case, answered by a plain read: the schema is current, so there
    // is nothing to create and nothing of ours to checkpoint. Both steps below
    // WAIT on other processes -- `.immediate` for any writer's lock, the
    // TRUNCATE checkpoint for any reader still pinning the WAL -- up to
    // `busy_timeout`. Taken on every open, that wait was the slow tail of
    // opening the picker: measured at ~300ms behind a held write lock and ~230ms
    // behind a reader on a non-empty WAL, against ~70ms otherwise.
    //
    // Rebuilds and in-place upgrades both take the reset lock this process holds.
    if (usable(opened, (opened.pragma("user_version", { simple: true }) as number) ?? 0)) {
      return opened;
    }

    // Transactional and `.immediate` even while holding the file lock, because
    // that lock is best effort by design -- it can be stolen after a timeout,
    // and failing to take it falls through to doing the work anyway -- so this
    // has to stay correct without it.
    //
    // `.immediate` for the same reason `syncLocal` uses it, in the same terms:
    // this reads `user_version` and then writes, so a deferred transaction
    // starts as a READER and must upgrade, which fails the loser with
    // SQLITE_BUSY_SNAPSHOT rather than making it wait. Taking the write lock up
    // front means a second process blocks on `busy_timeout` and then finds the
    // version already current, so it creates nothing. Measured against `dist/`:
    // 23 failures over 20 trials of 8 concurrent opens, against 0 after.
    //
    // The re-read INSIDE the transaction is the other half. Without it the
    // loser would hold the lock and still act on the version it read before
    // waiting for it, which is the original bug with extra steps.
    try {
      opened
        .transaction(() => {
          const version = (opened.pragma("user_version", { simple: true }) as number) ?? 0;
          if (usable(opened, version)) return;
          // The reset lock is best effort and can be stolen, so a newer build may
          // have written the file since the check above. Never build over it.
          if (version > SCHEMA_USER_VERSION) throw new StoreTooNewError(path, version);
          if (upgradable(version)) {
            // Additive: every row stays, the compat stamp included.
            for (let step = version; step < SCHEMA_USER_VERSION; step += 1) {
              opened.exec(UPGRADES[step] ?? "");
            }
            opened.pragma(`user_version = ${SCHEMA_USER_VERSION}`);
            return;
          }
          opened.exec(SCHEMA);
          opened.prepare("INSERT INTO compat (compatible_since) VALUES (?)").run(COMPATIBLE_SINCE);
          opened.pragma(`user_version = ${SCHEMA_USER_VERSION}`);
          // Re-inserted with every OBSERVED column null: a salvaged peer has no
          // snapshot and has never been fetched, and saying otherwise would
          // render a never-reached host as fresh.
          const restore = opened.prepare(
            "INSERT OR IGNORE INTO peers (name, target, jump_command, rex_host) VALUES (?, ?, ?, ?)",
          );
          for (const peer of salvaged) {
            restore.run(
              peer.name,
              peer.target,
              peer.jump_command ?? defaultJumpCommand(peer.target),
              peer.rex_host ?? null,
            );
          }
        })
        .immediate();
    } catch (error) {
      opened.close();
      throw error;
    }

    // Forced out of the WAL before the lock drops, so the rebuilt rows live in
    // the database file itself. Otherwise the salvage sits in `-wal` and the
    // next process to decide on a reset deletes it -- the original bug, one
    // step later.
    opened.pragma("wal_checkpoint(TRUNCATE)");
    return opened;
  });
  return database;
}

function buildStore(database: Database): Store {
  const selectSeen = database.prepare(
    "SELECT * FROM seen WHERE server_kind = ? AND server_value = ?",
  );
  const upsertSeen = database.prepare(`
    INSERT INTO seen (server_kind, server_value, pane, state, since, session, window,
                      session_name, window_name, agent_name, workstream, role, driver,
                      harness, cli, pane_title)
    VALUES (@server_kind, @server_value, @pane, @state, @since, @session, @window,
            @session_name, @window_name, @agent_name, @workstream, @role, @driver,
            @harness, @cli, @pane_title)
    ON CONFLICT (server_kind, server_value, pane) DO UPDATE SET
      state = excluded.state, since = excluded.since, session = excluded.session,
      window = excluded.window, session_name = excluded.session_name,
      window_name = excluded.window_name, agent_name = excluded.agent_name,
      workstream = excluded.workstream, role = excluded.role, driver = excluded.driver,
      harness = excluded.harness, cli = excluded.cli, pane_title = excluded.pane_title
  `);
  const deleteSeen = database.prepare(
    "DELETE FROM seen WHERE server_kind = ? AND server_value = ? AND pane = ?",
  );
  // `requested_at` is kept on a repeat, so age keeps meaning "how long this
  // has gone unmet" and a re-recorded crash is not a new alert.
  const insertCrash = database.prepare(`
    INSERT INTO crashed (server_kind, server_value, pane, session, window, session_name,
                         window_name, agent_name, workstream, role, driver, harness, cli,
                         pane_title, last_state, requested_at)
    VALUES (@server_kind, @server_value, @pane, @session, @window, @session_name,
            @window_name, @agent_name, @workstream, @role, @driver, @harness, @cli,
            @pane_title, @last_state, @requested_at)
    ON CONFLICT (server_kind, server_value, pane) DO NOTHING
  `);
  const deleteCrash = database.prepare(
    "DELETE FROM crashed WHERE server_kind = ? AND server_value = ? AND pane = ?",
  );

  /**
   * \`.immediate\`: this reads the previous sighting and then writes, so a
   * deferred transaction would start as a reader and fail its upgrade with
   * SQLITE_BUSY_SNAPSHOT when two collects race (the status bar and a dash).
   */
  const syncLocal = database.transaction((reads: readonly ServerRead[], now: number): LocalSync => {
    const result: LocalSync = { crashed: [], since: new Map() };
    for (const read of reads) {
      if (read.panes === null) continue;
      const kind = read.server.kind;
      const value = serverValue(read.server);
      const previous = new Map(
        (selectSeen.all(kind, value) as SeenDbRow[]).map((row) => [row.pane, row]),
      );
      for (const pane of read.panes) {
        const before = previous.get(pane.pane);
        previous.delete(pane.pane);
        // The multiplexer's clock when it has one; else carried while the
        // state holds, so an unchanged state keeps its age and a changed one
        // is news at this collect.
        // A crash is news when murmur first sees it: the program's last
        // record (an `error` an hour old, say) says nothing about when the
        // process died, and inheriting its time would age the crash past
        // every alert window before it was ever reported.
        const held = before && before.state === pane.state ? before.since : null;
        const since = pane.state === "crashed" ? (held ?? now) : (pane.state_time ?? held ?? now);
        result.since.set(paneKey(pane), since);
        // A live pane at the address is a new occupant: any crash recorded
        // there describes a process that is gone.
        deleteCrash.run(kind, value, pane.pane);
        upsertSeen.run({
          server_kind: kind,
          server_value: value,
          pane: pane.pane,
          state: pane.state,
          since,
          session: pane.session,
          window: pane.window,
          session_name: pane.session_name,
          window_name: pane.window_name,
          agent_name: pane.agent_name,
          workstream: pane.workstream,
          role: pane.role,
          driver: pane.driver,
          harness: pane.harness,
          cli: pane.cli,
          pane_title: pane.pane_title,
        });
      }
      // Gone since the last collect. Mid-work is a crash murmur must remember
      // (the multiplexer has nothing left to say about the pane); at rest it
      // simply finished.
      // A pane still on the server cleared its record (or stopped being
      // listed); only one the server no longer holds vanished.
      for (const gone of previous.values()) {
        deleteSeen.run(kind, value, gone.pane);
        if (read.live?.has(gone.pane)) continue;
        if (!MID_WORK.includes(gone.state)) continue;
        // mu owns its crew's lifecycles: it closes workers and delegates while
        // they still report working, and reports a worker that died itself.
        // Only an orchestrator, which nobody above it watches, crashes here.
        if (gone.driver === "orchestrated" && gone.role !== "orchestrator") continue;
        insertCrash.run({ ...gone, last_state: gone.state, requested_at: now });
        result.crashed.push(asPaneId(gone.pane));
      }
    }
    return result;
  });

  function peerRecord(row: PeerDbRow): PeerRecord {
    let snapshot: Snapshot | null = null;
    if (row.snapshot !== null) {
      try {
        // VALIDATED on the way out, not merely parsed. A read path must not
        // throw, and a stored document that no longer holds up reads as "no
        // snapshot" and is left in place rather than deleted -- but the check
        // has to be structural, not syntactic.
        //
        // `JSON.parse(...) as Snapshot` caught only malformed TEXT, so a
        // syntactically valid document of the wrong shape sailed through: a
        // column set to `{"foo":1}` yielded a non-null snapshot with no `panes`,
        // and the first reader to iterate it threw `snapshot.panes is not
        // iterable` -- a crash in a surface, from data the store handed it. The
        // cast was the whole problem: it asserted a shape nothing had checked.
        //
        // Reusing `parseSnapshot` means the way in and the way out agree by
        // construction, which is the only version of this that cannot drift.
        snapshot = parseSnapshot(row.snapshot);
      } catch {
        snapshot = null;
      }
    }
    return {
      name: row.name,
      target: row.target,
      jump_command: row.jump_command,
      host_id: row.host_id,
      display_name: row.display_name,
      snapshot,
      snapshot_at: row.snapshot_at,
      fetched_at: row.fetched_at,
      last_attempt_at: row.last_attempt_at,
      last_error: row.last_error,
      murmur_version: row.murmur_version,
      snapshot_version: row.snapshot_version,
      rex_host: row.rex_host,
    };
  }

  return {
    syncLocal(reads, now = Date.now()) {
      return syncLocal.immediate(reads, now);
    },

    knownServers() {
      const rows = database
        .prepare("SELECT DISTINCT server_kind, server_value FROM seen ORDER BY 1, 2")
        .all() as { server_kind: TmuxServer["kind"]; server_value: string }[];
      return rows.map(serverFromRow);
    },

    localPanes() {
      const rows = database
        .prepare("SELECT * FROM crashed ORDER BY server_kind, server_value, pane")
        .all() as CrashedDbRow[];
      return rows.map(crashedPane);
    },

    recordCrash(location, now = Date.now()) {
      insertCrash.run({
        server_kind: location.server.kind,
        server_value: serverValue(location.server),
        pane: location.pane,
        session: location.session,
        window: location.window,
        session_name: location.session_name,
        window_name: location.window_name,
        agent_name: null,
        workstream: null,
        role: null,
        driver: "human",
        harness: null,
        cli: null,
        pane_title: null,
        last_state: "running",
        requested_at: now,
      });
    },

    acknowledgePane(address) {
      return deleteCrash.run(address.server.kind, serverValue(address.server), address.pane)
        .changes;
    },

    claimAlerts(keys, current, now, retainMs) {
      const insert = database.prepare(
        "INSERT OR IGNORE INTO alerted (key, alerted_at) VALUES (?, ?)",
      );
      return database
        .transaction(() => {
          const won = keys.filter((key) => insert.run(key, now).changes === 1);
          const live = new Set(current);
          const old = database
            .prepare("SELECT key FROM alerted WHERE alerted_at < ?")
            .all(now - retainMs) as { key: string }[];
          const forget = database.prepare("DELETE FROM alerted WHERE key = ?");
          for (const { key } of old) if (!live.has(key)) forget.run(key);
          return won;
        })
        .immediate();
    },

    peers() {
      return (database.prepare("SELECT * FROM peers ORDER BY name").all() as PeerDbRow[]).map(
        peerRecord,
      );
    },

    addPeer(name, target, jumpCommand) {
      // Correcting a target keeps a custom jump command but drops the cache: the
      // new target is unverified, and rows cached from the old node would stay
      // actionable through it. The next successful fetch refills it.
      // A default command follows a corrected target because it was derived from it.
      const existing = database
        .prepare("SELECT target, jump_command FROM peers WHERE name = ?")
        .get(name) as Pick<PeerDbRow, "target" | "jump_command"> | undefined;
      const command =
        jumpCommand ??
        (existing
          ? currentJumpCommand(existing.jump_command, existing.target) ===
            defaultJumpCommand(existing.target)
            ? defaultJumpCommand(target)
            : existing.jump_command
          : defaultJumpCommand(target));
      database
        .prepare(
          `INSERT INTO peers (name, target, jump_command) VALUES (?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET
             target = excluded.target, jump_command = excluded.jump_command`,
        )
        .run(name, target, command);
      if (existing && existing.target !== target) {
        database
          .prepare(
            `UPDATE peers
                SET snapshot = NULL, snapshot_at = NULL, fetched_at = NULL, host_id = NULL,
                    display_name = NULL, murmur_version = NULL, snapshot_version = NULL,
                    last_attempt_at = NULL, last_error = NULL
              WHERE name = ?`,
          )
          .run(name);
      }
    },

    setPeerJumpCommand(name, jumpCommand) {
      return (
        database.prepare("UPDATE peers SET jump_command = ? WHERE name = ?").run(jumpCommand, name)
          .changes > 0
      );
    },

    setPeerRexHost(name, rexHost) {
      return (
        database.prepare("UPDATE peers SET rex_host = ? WHERE name = ?").run(rexHost, name)
          .changes > 0
      );
    },

    removePeer(name) {
      return database.prepare("DELETE FROM peers WHERE name = ?").run(name).changes > 0;
    },

    replacePeerSnapshot(name, fetch, target) {
      // Matches any target when the caller did not name one.
      const pinned = target ?? null;
      if (!fetch.ok) {
        // Failure touches neither snapshot, snapshot_at nor fetched_at, so the
        // last-known document stands and the peer ages into `stale` on its own.
        database
          .prepare(
            "UPDATE peers SET last_attempt_at = ?, last_error = ? WHERE name = ? AND (? IS NULL OR target = ?)",
          )
          .run(fetch.at, fetch.error, name, pinned, pinned);
        return;
      }
      // Two clocks, and conflating them is how a freshly fetched three-hour-old
      // fact reads as new. `snapshot_at` is the PEER's clock (when it built the
      // document); `fetched_at` is OURS (when we reached it), and freshness is
      // computed from `fetched_at` only.
      database
        .prepare(
          `UPDATE peers
              SET snapshot = ?, snapshot_at = ?, fetched_at = ?, last_attempt_at = ?,
                  last_error = NULL, host_id = ?, display_name = ?,
                  murmur_version = ?, snapshot_version = ?
            WHERE name = ? AND (? IS NULL OR target = ?)`,
        )
        .run(
          JSON.stringify(fetch.snapshot),
          fetch.snapshot.generated_at,
          fetch.at,
          fetch.at,
          fetch.snapshot.host_id,
          fetch.snapshot.display_name,
          fetch.snapshot.murmur_version,
          fetch.snapshot.murmur_snapshot,
          name,
          pinned,
          pinned,
        );
    },

    close() {
      database.close();
    },
  };
}
