import { randomUUID } from "node:crypto";
import { closeSync, openSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { ensureDir } from "./dirs.js";
import type { NodeIdentity } from "./identity.js";
import { asPaneId, asSessionId, asWindowId } from "./ids.js";
import type { InboxEvent } from "./inbox-event.js";
import { currentJumpCommand, defaultJumpCommand } from "./jump-command.js";
import { pidAlive } from "./mux.js";
import { dbPath } from "./paths.js";
import { ancestry, outerHarness, readProcessTable, tmuxServerPid } from "./process-chain.js";
import { settledState } from "./settle.js";
import { parseSnapshot, parseUsage } from "./snapshot.js";
import { GENERATION_ENDS, type GenerationEnd, stepTurn } from "./turn.js";
import type {
  ActivityUpdate,
  AgentClaim,
  AgentRelease,
  AgentRuntime,
  AgentSource,
  AncestorCheck,
  AttentionKind,
  AttentionRequest,
  ClaimResult,
  HarnessState,
  InboxDelivery,
  IngestOptions,
  IngestSummary,
  LiveCheck,
  LocalPane,
  LocalWorld,
  Location,
  NestCheck,
  PaneIdentity,
  PeerFetch,
  PeerRecord,
  ReconcileSummary,
  RuntimeUpdate,
  Snapshot,
  SnapshotAgent,
  SnapshotAttention,
  TmuxServer,
} from "./types.js";
import { ATTENTION_PRIORITY, DEFAULT_DRIVER, EFFORTS, SNAPSHOT_VERSION } from "./types.js";
import { MURMUR_VERSION } from "./version.js";

/**
 * The storage version. Any change to any table bumps it.
 *
 * ONE version strategy for an OLDER file: it salvages the peer names and
 * targets a human typed, deletes the file, and recreates the schema. No ALTER
 * TABLE anywhere in this build.
 */
const SCHEMA_USER_VERSION = 11;

/**
 * The oldest schema whose build can read and write a store this build creates,
 * stamped into the file beside `user_version` (the `compat` table).
 *
 * What it buys is the next release, not this one. A later build that only adds
 * nullable columns bumps `SCHEMA_USER_VERSION` and keeps this stamp, so a build
 * like this one opens its newer store instead of refusing it -- every INSERT
 * here names its columns, and a column it does not know is left to its
 * default. The pi extension and the CLI are separate installs, so that is the
 * difference between an upgrade order that matters and one that does not.
 *
 * A store from before the stamp existed (schema 9 and older) is reset, once.
 * Schema 11 added `last_text_run` and `generation_run`, both nullable, and
 * kept the stamp: a schema-10 build still opens it.
 */
const COMPATIBLE_SINCE = 10;

/**
 * The effort vocabulary as a SQL value list, generated from the one tuple.
 *
 * SQL is a string and cannot import, so the schema would otherwise be a second
 * hand-written spelling of a closed protocol vocabulary -- the shape that has
 * already cost this repo once, when `SNAPSHOT_VERSION` was four literals and the
 * copy in `peer.ts` made `peer list` call every upgraded peer incompatible.
 *
 * Interpolating into DDL is safe here and only here: `EFFORTS` is a
 * compile-time `as const` tuple of identifiers this file owns, never input. The
 * quote escaping is belt-and-braces against a future member with an apostrophe,
 * which would otherwise end the literal and change the statement's meaning.
 */
const EFFORT_SQL_LIST = EFFORTS.map((effort) => `'${effort.replaceAll("'", "''")}'`).join(", ");

/** The generation-end vocabulary as a SQL value list, from the one tuple, like EFFORTS. */
const GENERATION_END_SQL_LIST = GENERATION_ENDS.map((end) => `'${end}'`).join(", ");

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
 * pi can run on Bun (a single-file Bun build of pi loads this file through the
 * extension). Bun cannot load better-sqlite3's native addon: the load is a
 * `NAPI FATAL ERROR` panic that takes pi down before its first prompt, not an
 * exception the extension's lazy import could swallow. So the driver is chosen
 * at runtime with `require`, never a static import, which would load the addon
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
 * The columns `setRuntime` may write, as an allowlist.
 *
 * The SET clause is built from this and intersected with the caller's keys, so
 * the statement text is assembled from constants only and a caller cannot name a
 * column -- the reason this is a literal list rather than `Object.keys(update)`.
 */
const RUNTIME_COLUMNS = [
  "model",
  "provider",
  "effort",
  "provider_effort",
  "context_pct",
  "context_tokens",
  "context_window",
  "usage",
  "pending",
] as const satisfies readonly (keyof AgentRuntime)[];

/**
 * How long to wait for another process's reset before stealing its lock.
 *
 * A reset is a handful of file operations, so a lock held longer than this is a
 * dead holder rather than a slow one. Matches `busy_timeout`, since both bound
 * "wait for another process to finish writing".
 */
const RESET_LOCK_TIMEOUT_MS = 5_000;

const SCHEMA = `
  CREATE TABLE agents (
    agent_id     TEXT    NOT NULL PRIMARY KEY,
    server_kind  TEXT    NOT NULL CHECK (server_kind IN ('default', 'label', 'path')),
    server_value TEXT    NOT NULL,
    pane         TEXT    NOT NULL,
    owner_pid    INTEGER NOT NULL CHECK (owner_pid > 0),
    activity     TEXT    NOT NULL CHECK (activity IN ('running', 'stopped')),
    session      TEXT    NOT NULL,
    window       TEXT    NOT NULL,
    session_name TEXT,
    window_name  TEXT,
    agent_name   TEXT,
    pi_session   TEXT,
    workstream   TEXT,
    role         TEXT,
    cli          TEXT    NOT NULL,
    driver       TEXT    NOT NULL CHECK (driver IN ('human', 'orchestrated')),
    -- What the agent is running with, as it reports it. Nullable because a bare
    -- shell or a notify-only harness knows none of it. The effort column is
    -- CHECK-ed for the same reason driver is: the set is closed, so no sort or
    -- render path needs a fallback branch for a word nothing defines.
    model        TEXT,
    provider     TEXT,
    context_tokens  INTEGER CHECK (context_tokens IS NULL OR context_tokens >= 0),
    context_window  INTEGER CHECK (context_window IS NULL OR context_window >= 0),
    provider_effort TEXT,
    -- The usage bundle as one JSON document, because it is nullable as a UNIT
    -- and no query looks inside it. Twelve more columns would buy nothing that
    -- is read and cost every writer twelve placeholders; if a surface ever
    -- needs to sort on cost, that is the point to promote a column.
    -- Validated by parseUsage on the way in and out, so the opacity is at rest
    -- only -- nothing trusts this text without parsing it.
    usage        TEXT,
    effort       TEXT    CHECK (effort IS NULL OR effort IN (${EFFORT_SQL_LIST})),
    context_pct  REAL    CHECK (context_pct IS NULL OR (context_pct >= 0 AND context_pct <= 100)),
    pending      INTEGER CHECK (pending IS NULL OR pending >= 0),
    -- Who reports this row: pi's extension in-process, or the inbox drain for
    -- a hook harness. Local only, like everything below: \`toAgent\` picks its
    -- fields explicitly, so none of it reaches a snapshot.
    source       TEXT    NOT NULL DEFAULT 'pi' CHECK (source IN ('pi', 'inbox')),
    harness      TEXT,
    session_id   TEXT,
    -- Prompts submitted this session: mu's send acknowledgement. Null for pi,
    -- which does not count them.
    run_count    INTEGER CHECK (run_count IS NULL OR run_count >= 0),
    -- The last turn's assistant text, capped at 64 KB of UTF-8.
    last_text    TEXT    CHECK (last_text IS NULL OR length(CAST(last_text AS BLOB)) <= 65536),
    -- The run (run_count) whose turn wrote last_text, so a reader can tell
    -- this turn's text from one an earlier turn left. Schema 11: a build at
    -- schema 10 opens this store and leaves the column alone.
    last_text_run  INTEGER CHECK (last_text_run IS NULL OR last_text_run >= 0),
    -- 0 while the activity is mu's word (an interrupt it sent, \`idle?\`) and
    -- no harness event has confirmed it.
    confirmed    INTEGER NOT NULL DEFAULT 1 CHECK (confirmed IN (0, 1)),
    -- The last ended turn's generation and how it ended, for a harness that
    -- names its turns (cursor-agent): its late text and its echo stops pair
    -- with the turn they belong to. See src/turn.ts.
    generation_id  TEXT,
    generation_end TEXT CHECK (generation_end IS NULL OR generation_end IN (${GENERATION_END_SQL_LIST})),
    generation_run INTEGER CHECK (generation_run IS NULL OR generation_run >= 0),
    claimed_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    UNIQUE (server_kind, server_value, pane)
  ) STRICT;

  CREATE TABLE attention (
    server_kind  TEXT    NOT NULL CHECK (server_kind IN ('default', 'label', 'path')),
    server_value TEXT    NOT NULL,
    pane         TEXT    NOT NULL,
    kind         TEXT    NOT NULL CHECK (kind IN ('done', 'blocked', 'error', 'crashed')),
    message      TEXT    NOT NULL,
    source       TEXT    NOT NULL,
    driver       TEXT    NOT NULL CHECK (driver IN ('human', 'orchestrated')),
    session      TEXT    NOT NULL,
    window       TEXT    NOT NULL,
    session_name TEXT,
    window_name  TEXT,
    requested_at INTEGER NOT NULL,
    PRIMARY KEY (server_kind, server_value, pane, kind)
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
    snapshot_version INTEGER
  ) STRICT;
`;

/**
 * The store, and the only place in murmur that holds a database handle or
 * writes SQL.
 *
 * This interface is CLOSED: no `append`, no log read, no partial-row update,
 * and no local read other than `localPanes` and the inbox's `harnessState`.
 * Each of those shapes lets a writer say something it has no standing to say,
 * and each cost a shipped bug. Attention methods take no agent identity, which
 * is what makes "a notifier cannot corrupt an agent row" structural.
 *
 * It reopens for exactly ONE ingest, the inbox (`ingestInbox`): keyed on pane,
 * applied under the write lock, and deleted once applied. There is no replay
 * and no history; the store decides what each event means, and the caller only
 * delivers it.
 */
export interface Store {
  // --- agent lifecycle: owner-only, pid-gated -----------------------------
  claimAgent(claim: AgentClaim): ClaimResult;
  setActivity(update: ActivityUpdate): boolean;
  /**
   * Record what the agent is running with. Owner-gated, partial.
   *
   * Separate from `setActivity` because these are different claims by the same
   * owner: activity is what the process is doing, runtime is what it is doing it
   * with. One call that carried both would have to be given every field on every
   * event, and three of pi's four report sites know only one of them.
   */
  setRuntime(update: RuntimeUpdate): boolean;
  releaseAgent(release: AgentRelease): boolean;

  // --- attention: pane-addressed, no agent authority ----------------------
  requestAttention(request: AttentionRequest): void;
  /**
   * Record a crash for a pane, as reconciliation would, with `driver = human`.
   *
   * `crashed` is not in `AttentionRequest` because it is reconciliation's word:
   * it asserts an owning process died without saying so, which only the node
   * that probed that pid may conclude. This is the same statement reconciliation
   * uses (which writes the dead agent's own driver; this seam has no agent to
   * read, and an agent row on the pane decides the pane's driver anyway), named
   * so that a caller reaching for it has to mean it -- tests seeding
   * a crashed row are the honest use, and anything else in production would be
   * manufacturing a fact it cannot observe.
   */
  recordCrash(location: Location, now?: number): void;
  acknowledgePane(location: PaneIdentity): number;

  // --- local truth --------------------------------------------------------
  /** The one local read. Joins agents and attention by server and pane. */
  localPanes(): LocalPane[];
  reconcileLocal(world: LocalWorld): ReconcileSummary;
  buildLocalSnapshot(identity: NodeIdentity, worlds: LocalWorld | readonly LocalWorld[]): Snapshot;

  // --- alert dedup --------------------------------------------------------
  /**
   * Claim attention events for the on-attention hook, and answer which keys
   * this caller won. Atomic per key, so two processes collecting at once never
   * both fire one event.
   *
   * Also forgets claims older than `retainMs` whose event is no longer in
   * `current`. The age gate keeps a reader that read before a newer event
   * landed from deleting another process's fresh claim and re-firing it.
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
  removePeer(name: string): boolean;
  replacePeerSnapshot(name: string, fetch: PeerFetch): void;

  // --- the inbox: the one ingest -----------------------------------------
  /**
   * Apply hook events to the panes they name, in the order `read` returns
   * them, inside ONE immediate transaction. `read` runs under that lock, so two
   * drains never apply one event twice: the second waits, then finds the file
   * gone.
   *
   * The owner gate uses the pid the hook recorded, not the caller's. A `pi`
   * row ignores every inbox event, and an unclaimed pane is never claimed while
   * a pi runs in its process tree.
   */
  ingestInbox(read: () => readonly InboxDelivery[], options?: IngestOptions): IngestSummary;
  /** One local pane's harness-side state, for `murmur pane --json`. Never in a snapshot. */
  harnessState(pane: PaneIdentity): HarnessState | null;

  close(): void;
}

type AgentDbRow = {
  agent_id: string;
  server_kind: TmuxServer["kind"];
  server_value: string;
  pane: string;
  owner_pid: number;
  activity: string;
  session: string;
  window: string;
  session_name: string | null;
  window_name: string | null;
  agent_name: string | null;
  pi_session: string | null;
  workstream: string | null;
  role: string | null;
  cli: string;
  driver: string;
  model: string | null;
  provider: string | null;
  effort: string | null;
  context_pct: number | null;
  context_tokens: number | null;
  context_window: number | null;
  provider_effort: string | null;
  usage: string | null;
  pending: number | null;
  source: AgentSource;
  harness: string | null;
  session_id: string | null;
  run_count: number | null;
  last_text: string | null;
  last_text_run: number | null;
  confirmed: number;
  generation_id: string | null;
  generation_end: GenerationEnd | null;
  generation_run: number | null;
  claimed_at: number;
  updated_at: number;
};

type AttentionDbRow = {
  server_kind: TmuxServer["kind"];
  server_value: string;
  pane: string;
  kind: string;
  message: string;
  source: string;
  driver: string;
  session: string;
  window: string;
  session_name: string | null;
  window_name: string | null;
  requested_at: number;
};

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

/** Human-authored peer fields, and the only state worth salvaging. */
function salvagePeers(path: string): { name: string; target: string; jump_command?: string }[] {
  try {
    const existing = openDatabase(path, { fileMustExist: true });
    try {
      const version = (existing.pragma("user_version", { simple: true }) as number) ?? 0;
      if (usable(existing, version)) return [];
      const columns = existing.prepare("PRAGMA table_info(peers)").all() as { name: string }[];
      const jump = columns.some((column) => column.name === "jump_command") ? ", jump_command" : "";
      return existing.prepare(`SELECT name, target${jump} FROM peers`).all() as {
        name: string;
        target: string;
        jump_command?: string;
      }[];
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
 * Whether the file at `path` must be thrown away and recreated.
 *
 * Three outcomes collapse into two answers, and getting that wrong was a bug:
 * a file that opens and matches needs nothing, a file that opens and disagrees
 * needs a reset, and a file murmur CANNOT READ needs one just as much.
 *
 * The last case is the subtle one. better-sqlite3's constructor does not touch
 * the file, so a corrupt `state.db` constructs fine and the first `pragma` is
 * what throws. That throw used to land in a catch that returned false -- "no
 * reset needed" for precisely the file that needed one -- and every command
 * that opened the store then died on the same pragma with a raw SqliteError,
 * including the status bar on every tick and every focus hook. The only
 * recovery was deleting the file by hand.
 *
 * Resetting is the right answer because nothing here is history: the store
 * holds current state only, every fact in it is re-derived by the next collect
 * or the next claim, so discarding an unusable file costs nothing. That is the
 * same argument the version-mismatch path already makes.
 *
 * A missing file is the one case that is NOT a reset: there is nothing to
 * delete, and `openStore` creates the schema anyway.
 */
/**
 * What a rebuild is about to discard, for the warning above.
 *
 * Separate from `salvagePeers` because it asks the opposite question: that reads
 * what survives, this reads what does not. Returns null when the database cannot
 * be read at all, which is the case where there is nothing to warn about anyway.
 */
function countDiscarded(path: string): { agents: number; attention: number } | null {
  let existing: Database;
  try {
    existing = openDatabase(path, { fileMustExist: true, readonly: true });
  } catch {
    return null;
  }
  try {
    const count = (table: string): number =>
      (existing.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    return { agents: count("agents"), attention: count("attention") };
  } catch {
    // A pre-rewrite or damaged file may have neither table. Nothing to say.
    return null;
  } finally {
    existing.close();
  }
}

/**
 * A store written by a newer murmur than this one.
 *
 * Refused, never rebuilt. The pi extension and the CLI are separate installs
 * (`pi install` and `npm i -g`) and can run different versions; rebuilding
 * downward made each side wipe the other's agent and attention rows on every
 * open, a status-bar tick included. An older build stays out of the way
 * instead: the extension goes silent, a CLI verb prints this and exits.
 */
export class StoreTooNewError extends Error {
  constructor(
    readonly path: string,
    readonly found: number,
  ) {
    super(
      `${path} was written by a newer murmur (schema ${found}, this build ${SCHEMA_USER_VERSION}). ` +
        "Upgrade this murmur: `npm i -g @mu-crew/murmur@latest` for the CLI, " +
        "`pi update npm:@mu-crew/murmur` for the pi extension. " +
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
    if (usable(existing, version)) return "ok";
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

function serverFromRow(row: AgentDbRow | AttentionDbRow): TmuxServer {
  return row.server_kind === "default"
    ? { kind: "default" }
    : { kind: row.server_kind, value: row.server_value };
}

function serverKey(server: TmuxServer, pane: string): string {
  return `${server.kind}\0${"value" in server ? server.value : ""}\0${pane}`;
}

function toAttention(row: AttentionDbRow): SnapshotAttention {
  return {
    kind: row.kind as AttentionKind,
    message: row.message,
    source: row.source,
    driver: row.driver as SnapshotAttention["driver"],
    requested_at: row.requested_at,
  };
}

/**
 * The usage column, parsed, or null.
 *
 * Total by construction: anything unparseable becomes null, because a missing
 * usage bundle is a state every reader already handles and a throw here would
 * fail a whole local read over optional baggage.
 */
function parseStoredUsage(text: string | null): SnapshotAgent["usage"] {
  if (text === null) return null;
  try {
    return parseUsage(JSON.parse(text));
  } catch {
    return null;
  }
}

function toAgent(row: AgentDbRow): SnapshotAgent {
  return {
    agent_id: row.agent_id,
    activity: row.activity as SnapshotAgent["activity"],
    agent_name: row.agent_name,
    pi_session: row.pi_session,
    workstream: row.workstream,
    role: row.role,
    cli: row.cli,
    driver: row.driver as SnapshotAgent["driver"],
    model: row.model,
    provider: row.provider,
    effort: row.effort as SnapshotAgent["effort"],
    context_pct: row.context_pct,
    context_tokens: row.context_tokens,
    context_window: row.context_window,
    provider_effort: row.provider_effort,
    // Re-validated, not cast. The column is opaque text at rest, so the only
    // thing that makes it trustworthy on the way out is parsing it again -- and
    // a row written by an older build, or edited by hand, must degrade to null
    // rather than hand a render path a shape it never checked.
    usage: parseStoredUsage(row.usage),
    pending: row.pending,
    claimed_at: row.claimed_at,
    updated_at: row.updated_at,
  };
}

/**
 * Rank per kind, as a total Record rather than a Map.
 *
 * A Record keyed by the union is EXHAUSTIVE AT COMPILE TIME: adding a kind to
 * `AttentionKind` without ranking it here fails typecheck, and the lookup
 * returns `number` rather than `number | undefined`. The Map version needed a
 * `?? ATTENTION_PRIORITY.length` to typecheck, which put a fallback branch in a
 * sort path -- and the reason this column is CHECK-constrained in SQL, and
 * validated by `parseSnapshot` on the way in, is precisely so that no sort,
 * count or render path needs one. A sweep confirmed the branch was unreachable
 * by changing it to -1000 and watching 68 assertions stay green.
 *
 * Derived from `ATTENTION_PRIORITY` so the order lives in one place, beside the
 * type, with the two kept consistent by a test.
 */
const RANK: Record<AttentionKind, number> = {
  crashed: ATTENTION_PRIORITY.indexOf("crashed"),
  error: ATTENTION_PRIORITY.indexOf("error"),
  blocked: ATTENTION_PRIORITY.indexOf("blocked"),
  done: ATTENTION_PRIORITY.indexOf("done"),
};

function attentionOrder(left: SnapshotAttention, right: SnapshotAttention): number {
  return RANK[left.kind] - RANK[right.kind];
}

/**
 * Whether a pid is an ancestor of `pid`, read from the process table once, on
 * first use. Fails closed: when the table cannot be read, every pid reads as an
 * ancestor, so pi refuses rather than displacing a possibly-live parent.
 */
function processAncestry(pid: number): AncestorCheck {
  let ancestors: Set<number> | null | undefined;
  return (candidate) => {
    if (ancestors === undefined) {
      const table = readProcessTable();
      ancestors = table ? ancestry(table, pid) : null;
    }
    return ancestors === null || ancestors.has(candidate);
  };
}

/**
 * The live non-pi harness a pi claiming as `pid` runs inside, read from the
 * process table up to the tmux server `$TMUX` names. Only for a claim this
 * process makes about itself: `$TMUX` is this process's, and says nothing about
 * another pid's server. Fails open (not nested) when it cannot tell, which is
 * how every pi claim behaved before the check, so a pi that is not nested
 * claims as it always did.
 */
function processNesting(pid: number): NestCheck {
  return () => {
    const serverPid = tmuxServerPid(process.env.TMUX);
    if (pid !== process.pid || serverPid === null) return null;
    const table = readProcessTable();
    return table ? outerHarness(table, pid, serverPid) : null;
  };
}

/**
 * Open the store. Takes no arguments and mints no identity.
 *
 * `openStore` deliberately does NOT read or create `identity.json`: identity is
 * created only by `murmur init`, so a read path — a status-bar tick, a focus
 * hook — cannot bring a node into existence as a side effect.
 */
export function openStore(): Store {
  const path = dbPath();
  ensureDir(dirname(path));

  // Salvage, decide and delete under ONE lock, because deleting the database
  // FILE is the operation SQLite cannot serialise for us: there is no handle to
  // hold a transaction on across removing the file it lives in.
  //
  // Unlocked, this lost data a person typed, reproducibly -- peer rows vanished
  // in 6 of 12 concurrent upgrade runs measured against `dist/`, and still 4 of
  // 12 once the schema step alone was serialised. Each process salvaged, each
  // agreed a reset was needed, and then each deleted the file, `-wal` included,
  // so one `rmSync` destroyed the database another had just rebuilt and took
  // its salvage with it.
  //
  // Peers are the only rows worth this trouble: every other fact is re-observed
  // within a tick, while a name and target cannot be re-derived from anything.
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
    const salvaged = salvagePeers(path);
    if (condition === "reset") {
      // SAY WHAT IS BEING THROWN AWAY, on stderr, once.
      //
      // The rebuild is documented and correct -- ARCHITECTURE.md accepts that a
      // store from a different `user_version` is rebuilt with only peers
      // salvaged -- but it was silent, and silence is what made a documented
      // upgrade look like data loss. Measured: a schema bump on a machine whose
      // murmur is a symlinked dev checkout wiped every agent row while `doctor`
      // stayed clean, `user_version` matched, and all peers survived. The picker
      // simply went empty, and a live agent cannot re-claim until its extension
      // reloads, so the rows do not come back on their own.
      //
      // Counted before the delete, since after it there is nothing to count.
      // Best effort in the same spirit as the lock: an unreadable database
      // reports nothing rather than failing the open.
      const discarded = countDiscarded(path);
      if (discarded !== null && discarded.agents > 0) {
        process.stderr.write(
          `murmur: rebuilding ${path} for a new schema version; ` +
            `${discarded.agents} agent row(s) and ${discarded.attention} attention row(s) are discarded, ` +
            `${salvaged.length} peer(s) kept. Running agents reappear when each reloads (\`/new\` in the pane).\n`,
        );
      }
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
    // `murmur pick`: measured at ~300ms behind a held write lock and ~230ms
    // behind a reader on a non-empty WAL, against ~70ms otherwise.
    //
    // Safe because a version change only ever comes from a rebuild, and a
    // rebuild happens under the reset lock this process holds right now.
    if (usable(opened, (opened.pragma("user_version", { simple: true }) as number) ?? 0)) {
      return opened;
    }

    // Transactional and `.immediate` even while holding the file lock, because
    // that lock is best effort by design -- it can be stolen after a timeout,
    // and failing to take it falls through to doing the work anyway -- so this
    // has to stay correct without it.
    //
    // `.immediate` for the same reason `claimAgent` uses it, in the same terms:
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
          opened.exec(SCHEMA);
          opened.prepare("INSERT INTO compat (compatible_since) VALUES (?)").run(COMPATIBLE_SINCE);
          opened.pragma(`user_version = ${SCHEMA_USER_VERSION}`);
          // Re-inserted with every OBSERVED column null: a salvaged peer has no
          // snapshot and has never been fetched, and saying otherwise would
          // render a never-reached host as fresh.
          const restore = opened.prepare(
            "INSERT OR IGNORE INTO peers (name, target, jump_command) VALUES (?, ?, ?)",
          );
          for (const peer of salvaged) {
            restore.run(
              peer.name,
              peer.target,
              peer.jump_command ?? defaultJumpCommand(peer.target),
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

  const selectAgentByPane = database.prepare(
    "SELECT * FROM agents WHERE server_kind = ? AND server_value = ? AND pane = ?",
  );
  const insertAgent = database.prepare(`
    INSERT INTO agents (agent_id, server_kind, server_value, pane, owner_pid, activity,
                        session, window, session_name, window_name, agent_name, pi_session,
                        workstream, role, cli, driver, source, harness, claimed_at, updated_at)
    VALUES (@agent_id, @server_kind, @server_value, @pane, @owner_pid, @activity,
            @session, @window, @session_name, @window_name, @agent_name, @pi_session,
            @workstream, @role, @cli, @driver, 'pi', 'pi', @claimed_at, @updated_at)
  `);
  const insertInboxAgent = database.prepare(`
    INSERT INTO agents (agent_id, server_kind, server_value, pane, owner_pid, activity,
                        session, window, session_name, window_name, agent_name, pi_session,
                        workstream, role, cli, driver, source, harness, session_id,
                        run_count, claimed_at, updated_at)
    VALUES (@agent_id, @server_kind, @server_value, @pane, @owner_pid, 'stopped',
            @session, @window, @session_name, @window_name, @agent_name, NULL,
            @workstream, @role, @cli, @driver, 'inbox', @harness, @session_id,
            0, @claimed_at, @updated_at)
  `);
  const retainAgent = database.prepare(`
    UPDATE agents
       SET session = @session, window = @window, session_name = @session_name,
           window_name = @window_name, agent_name = @agent_name,
           pi_session = @pi_session, workstream = @workstream, role = @role,
           cli = @cli, driver = @driver, updated_at = @updated_at
     WHERE agent_id = @agent_id
  `);
  const deleteAgentByPane = database.prepare(
    "DELETE FROM agents WHERE server_kind = ? AND server_value = ? AND pane = ?",
  );
  const deleteAttentionForPane = database.prepare(
    "DELETE FROM attention WHERE server_kind = ? AND server_value = ? AND pane = ?",
  );
  const deleteAttentionKind = database.prepare(
    "DELETE FROM attention WHERE server_kind = ? AND server_value = ? AND pane = ? AND kind = ?",
  );
  // The inbox's row update: every column an event can move, written whole from
  // the row the transaction just read, keyed on the owner the event named.
  const updateInboxAgent = database.prepare(`
    UPDATE agents
       SET activity = @activity, session = @session, window = @window,
           session_name = @session_name, window_name = @window_name,
           session_id = @session_id, run_count = @run_count, last_text = @last_text,
           last_text_run = @last_text_run, confirmed = @confirmed,
           generation_id = @generation_id, generation_end = @generation_end,
           generation_run = @generation_run, updated_at = @updated_at
     WHERE agent_id = @agent_id AND owner_pid = @owner_pid AND source = 'inbox'
  `);
  const updateActivity = database.prepare(`
    UPDATE agents
       SET activity = @activity, session = @session, window = @window,
           session_name = @session_name, window_name = @window_name,
           updated_at = @updated_at
     WHERE agent_id = @agent_id AND owner_pid = @owner_pid
       AND server_kind = @server_kind AND server_value = @server_value AND pane = @pane
  `);
  const deleteAgentOwned = database.prepare(
    `DELETE FROM agents
      WHERE agent_id = ? AND owner_pid = ? AND server_kind = ? AND server_value = ? AND pane = ?`,
  );
  const upsertAttention = database.prepare(`
    INSERT INTO attention (server_kind, server_value, pane, kind, message, source, driver,
                           session, window, session_name, window_name, requested_at)
    VALUES (@server_kind, @server_value, @pane, @kind, @message, @source, @driver,
            @session, @window, @session_name, @window_name, @requested_at)
    ON CONFLICT (server_kind, server_value, pane, kind) DO UPDATE SET
      message = excluded.message,
      source = excluded.source,
      -- Human wins per ROW, as paneDriver makes it win per pane. requested_at
      -- is kept on a repeat, so letting a crew repeat (a sibling's
      -- notify --pane) overwrite the driver would hide a human request that
      -- is still unmet, keeping its age.
      driver = CASE WHEN attention.driver = 'human' THEN 'human' ELSE excluded.driver END,
      session = excluded.session,
      window = excluded.window,
      session_name = excluded.session_name,
      window_name = excluded.window_name
  `);
  const selectAgents = database.prepare("SELECT * FROM agents");
  const selectAttention = database.prepare("SELECT * FROM attention");
  /**
   * One prepared statement per SET shape, cached.
   *
   * There are only a handful of real shapes -- one per pi report site -- so this
   * settles after the first few turns instead of re-planning identical SQL
   * forever. The assignment list is built from a FIXED column allowlist in
   * `setRuntime`, never from caller keys, so no input reaches the statement text.
   */
  const runtimeStatements = new Map<string, ReturnType<typeof database.prepare>>();
  const runtimeStatement = (assignments: string) => {
    const cached = runtimeStatements.get(assignments);
    if (cached) return cached;
    const prepared = database.prepare(
      `UPDATE agents SET ${assignments}, updated_at = @updated_at
         WHERE agent_id = @agent_id AND owner_pid = @owner_pid`,
    );
    runtimeStatements.set(assignments, prepared);
    return prepared;
  };

  const setActivityByPane = database.prepare(
    `UPDATE agents SET activity = ?, updated_at = ?
      WHERE server_kind = ? AND server_value = ? AND pane = ?`,
  );

  /**
   * `.immediate`, not deferred, and this is load-bearing.
   *
   * This reads the incumbent row and then writes, so a deferred transaction
   * starts as a READER and must upgrade. Two at once fail the loser with
   * SQLITE_BUSY_SNAPSHOT, which no busy_timeout can fix -- waiting cannot make a
   * stale snapshot fresh. Measured at 5 of 8 concurrent writers failing.
   */
  const claimAgent = database.transaction((claim: AgentClaim): ClaimResult => {
    const now = claim.now ?? Date.now();
    const isAlive = claim.isAlive ?? pidAlive;
    const { location, meta, owner_pid } = claim;
    const serverValue = "value" in location.server ? location.server.value : "";
    const incumbent = selectAgentByPane.get(location.server.kind, serverValue, location.pane) as
      | AgentDbRow
      | undefined;

    const values = {
      server_kind: location.server.kind,
      server_value: serverValue,
      pane: location.pane,
      owner_pid,
      session: location.session,
      window: location.window,
      session_name: location.session_name,
      window_name: location.window_name,
      agent_name: meta.agent_name,
      pi_session: meta.pi_session,
      workstream: meta.workstream,
      role: meta.role,
      cli: meta.cli,
      driver: meta.driver,
      updated_at: now,
    };

    // pi inside a live hook harness is that harness's nested agent, refused
    // whether or not the harness has a row yet: until a reader drains, its
    // events wait in the inbox and the pane looks unclaimed. Asked lazily, and
    // only on a path that would claim.
    const nestedUnder = claim.nestedUnder ?? processNesting(owner_pid);

    if (!incumbent) {
      const outer = nestedUnder();
      if (outer !== null) return { outcome: "refused", held_by_pid: outer };
      const agentId = randomUUID();
      insertAgent.run({ ...values, agent_id: agentId, activity: "stopped", claimed_at: now });
      return { outcome: "claimed", agent_id: agentId };
    }

    // Our own claim, seen again. This is what makes pi's `/reload` a no-op: pi
    // re-runs the extension factory in the same process, and a check that could
    // not recognise its own claim would silence the real agent. `activity` and
    // `agent_id` are deliberately untouched.
    if (incumbent.owner_pid === owner_pid) {
      retainAgent.run({ ...values, agent_id: incumbent.agent_id });
      return { outcome: "retained", agent_id: incumbent.agent_id };
    }

    // An inbox-sourced incumbent: a hook harness's claim, or a stray one made
    // while pi's own row was gone (its `/new` release window, a store reset).
    // pi takes the pane back unless that owner is alive AND pi's ancestor --
    // pi nested under a live claude, refused exactly as a nested pi is below.
    //
    // The incumbent's attention is KEPT. The same-pane replace further down
    // deletes it because it described a process that is gone; here a human may
    // not yet have seen what the hook harness raised, and a stray claim's
    // attention is still about this pane.
    if (incumbent.source === "inbox") {
      const isAncestor = claim.isAncestor ?? processAncestry(owner_pid);
      if (isAlive(incumbent.owner_pid) && isAncestor(incumbent.owner_pid)) {
        return { outcome: "refused", held_by_pid: incumbent.owner_pid };
      }
      const outer = nestedUnder();
      if (outer !== null) return { outcome: "refused", held_by_pid: outer };
      deleteAgentByPane.run(location.server.kind, serverValue, location.pane);
      const agentId = randomUUID();
      insertAgent.run({ ...values, agent_id: agentId, activity: "stopped", claimed_at: now });
      return { outcome: "replaced", agent_id: agentId, previous_agent_id: incumbent.agent_id };
    }

    // A different LIVE process in one pane: the nested-agent case, and the only
    // answer for it. Fails closed — `pidAlive` reports death only on ESRCH, so
    // an unanswerable probe (EPERM) reads as alive and refuses. An unknown must
    // never let a second writer displace a possibly-live owner.
    if (isAlive(incumbent.owner_pid)) {
      return { outcome: "refused", held_by_pid: incumbent.owner_pid };
    }

    const outer = nestedUnder();
    if (outer !== null) return { outcome: "refused", held_by_pid: outer };

    // The previous occupant is gone. Its attention described a process that no
    // longer exists, and a human looking at the pane now sees a different agent.
    deleteAgentByPane.run(location.server.kind, serverValue, location.pane);
    deleteAttentionForPane.run(location.server.kind, serverValue, location.pane);
    const agentId = randomUUID();
    insertAgent.run({ ...values, agent_id: agentId, activity: "stopped", claimed_at: now });
    return { outcome: "replaced", agent_id: agentId, previous_agent_id: incumbent.agent_id };
  }).immediate;

  /**
   * One transaction, because the `stopped` write and its `crashed` attention row
   * must land together or not at all.
   *
   * A no-op when tmux could not answer: `panes === null` is absence of evidence,
   * not evidence of death, and conflating the two once deleted ten live agents.
   *
   * A missing pane whose owner pid is still alive keeps its row. tmux can say
   * "no panes" and be wrong: a `murmur status` run with a test rig's
   * `TMUX_TMPDIR` asked about a socket that did not exist, read that as an empty
   * default server, and deleted every agent on the machine. A live owner is
   * evidence the agent exists that no tmux answer can outweigh; when its pane
   * really closed, the owner dies with it and the next reconcile reaps the row.
   */
  const reconcileLocal = database.transaction((world: LocalWorld): ReconcileSummary => {
    const summary: ReconcileSummary = { crashed: [], removed: [], attention_removed: [] };
    if (world.panes === null) return summary;
    const live = world.panes;
    const worldServerValue = "value" in world.server ? world.server.value : "";
    const isAlive = world.isAlive ?? pidAlive;
    const now = world.now ?? Date.now();

    // Which panes already carry a crash we recorded. Read once, before any
    // write, so the loop below sees the state reconciliation started from.
    const alreadyCrashed = new Set(
      (selectAttention.all() as AttentionDbRow[])
        .filter((row) => row.kind === "crashed")
        .map((row) => serverKey(serverFromRow(row), row.pane)),
    );

    for (const row of selectAgents.all() as AgentDbRow[]) {
      if (row.server_kind !== world.server.kind || row.server_value !== worldServerValue) continue;
      const pane = asPaneId(row.pane);
      if (!live.has(pane)) {
        if (isAlive(row.owner_pid)) continue;
        deleteAgentByPane.run(row.server_kind, row.server_value, row.pane);
        deleteAttentionForPane.run(row.server_kind, row.server_value, row.pane);
        summary.removed.push(pane);
        continue;
      }
      if (isAlive(row.owner_pid)) continue;

      // The asymmetry below is the point. A dead RUNNING owner is an unreported
      // crash and must leave a durable trace. A dead STOPPED owner finished
      // normally, so its row is noise — but any `done` it raised is a fact a
      // human has not yet seen, so the attention stays.
      if (row.activity === "running") {
        setActivityByPane.run("stopped", now, row.server_kind, row.server_value, row.pane);
        upsertAttention.run({
          server_kind: row.server_kind,
          server_value: row.server_value,
          pane: row.pane,
          kind: "crashed",
          message: "",
          source: "murmur",
          // The dead agent's own driver: a crew worker that crashed is still
          // crew, and NEEDS_HUMAN is what surfaces it anyway.
          driver: row.driver,
          session: row.session,
          window: row.window,
          session_name: row.session_name,
          window_name: row.window_name,
          requested_at: now,
        });
        summary.crashed.push(pane);
      } else if (!alreadyCrashed.has(serverKey(serverFromRow(row), row.pane))) {
        deleteAgentByPane.run(row.server_kind, row.server_value, row.pane);
        summary.removed.push(pane);
      }
      // A pane already recorded as crashed keeps its agent row, the one place
      // this departs from a literal reading of the contract's table (which says
      // a live pane with a dead STOPPED owner loses its row). Taken literally,
      // the second reconcile deletes the row the first just marked `stopped`, so
      // the crashed pane loses agent_name, workstream, role and cli one tick
      // after the crash -- contradicting the contract's own idempotence rule and
      // stripping exactly the fields that say WHICH agent died.
      //
      // The table's real distinction is between an owner that finished normally,
      // whose row is noise, and one that died mid-run. The `crashed` row is the
      // record of which case this was, so it is the right thing to key on.
    }

    // Reaps attention for a pane that never had an agent row — an
    // attention-only codex pane whose window was closed. Nothing else would.
    for (const row of selectAttention.all() as AttentionDbRow[]) {
      if (row.server_kind !== world.server.kind || row.server_value !== worldServerValue) continue;
      const pane = asPaneId(row.pane);
      if (live.has(pane)) continue;
      deleteAttentionForPane.run(row.server_kind, row.server_value, row.pane);
      if (!summary.attention_removed.includes(pane)) summary.attention_removed.push(pane);
    }

    return summary;
  }).immediate;

  /**
   * Both tables read at ONE point in time, or a pane can appear with an agent
   * and without the attention that was there when the agent was read.
   */
  const readLocalPanes = database.transaction((): LocalPane[] => {
    const agents = selectAgents.all() as AgentDbRow[];
    const attention = selectAttention.all() as AttentionDbRow[];
    const panes = new Map<string, LocalPane>();

    const locate = (row: AgentDbRow | AttentionDbRow): LocalPane => {
      const server = serverFromRow(row);
      const key = serverKey(server, row.pane);
      const existing = panes.get(key);
      if (existing) return existing;
      const created: LocalPane = {
        server,
        pane: asPaneId(row.pane),
        session: asSessionId(row.session),
        window: asWindowId(row.window),
        session_name: row.session_name,
        window_name: row.window_name,
        agent: null,
        attention: [],
      };
      panes.set(key, created);
      return created;
    };

    for (const row of agents) locate(row).agent = toAgent(row);
    for (const row of attention) locate(row).attention.push(toAttention(row));

    for (const pane of panes.values()) pane.attention.sort(attentionOrder);
    return [...panes.values()].sort((left, right) =>
      serverKey(left.server, left.pane).localeCompare(serverKey(right.server, right.pane)),
    );
  });

  /**
   * Apply one inbox event to its pane. Returns whether it was applied, and
   * runs as a savepoint inside `ingestInbox`, so an event that fails half way
   * leaves nothing behind.
   *
   * The order is the ownership rules, then the vocabulary:
   *
   * 1. A `pi` row ignores the inbox while its pi lives.
   * 2. A pane with no row, or whose owner is dead (a dead pi's included), is
   *    claimed on the event, whatever its kind -- so a hook installed
   *    mid-session recovers -- except a `session_end`, and except while a pi
   *    runs in the pane's tree outside the event's own harness.
   * 3. A different live owner is refused: the store's nested-agent defence,
   *    with the pid the hook recorded standing in for the writer's own.
   * 4. An event from another session is ignored, unless it starts one.
   */
  const applyInboxEvent = database.transaction(
    (delivery: InboxDelivery, event: InboxEvent, isAlive: LiveCheck): boolean => {
      const { location } = delivery;
      const serverValue = "value" in location.server ? location.server.value : "";
      const key = [location.server.kind, serverValue, location.pane] as const;
      let row = selectAgentByPane.get(...key) as AgentDbRow | undefined;
      // A dead pi's row is replaced below like any dead owner's, as pi's own
      // claim replaces it: a crashed pi must not leave its pane deaf to the
      // harness started there next.
      if (row?.source === "pi" && isAlive(row.owner_pid)) return false;

      if (!row || row.owner_pid !== event.owner_pid) {
        if (event.event === "session_end") return false;
        if (row && isAlive(row.owner_pid)) return false;
        if (delivery.piRuns()) return false;
        if (row) {
          // The previous owner is gone, as in `claimAgent`'s same-pane replace.
          deleteAgentByPane.run(...key);
          deleteAttentionForPane.run(...key);
        }
        insertInboxAgent.run({
          agent_id: randomUUID(),
          server_kind: location.server.kind,
          server_value: serverValue,
          pane: location.pane,
          owner_pid: event.owner_pid,
          session: location.session,
          window: location.window,
          session_name: location.session_name,
          window_name: location.window_name,
          agent_name: event.agent.agent_name,
          workstream: event.agent.workstream,
          role: event.agent.role,
          cli: event.agent.cli ?? event.harness,
          driver: event.agent.driver,
          harness: event.harness,
          session_id: event.session_id,
          claimed_at: event.at,
          updated_at: event.at,
        });
        row = selectAgentByPane.get(...key) as AgentDbRow;
      } else if (
        event.event !== "session_start" &&
        event.session_id !== null &&
        row.session_id !== null &&
        event.session_id !== row.session_id
      ) {
        return false;
      }

      // The vocabulary's own transitions are shared with the remote fold.
      const step = stepTurn(
        {
          activity: row.activity === "running" ? "running" : "stopped",
          session_id: row.session_id,
          run_count: row.run_count ?? 0,
          last_text: row.last_text,
          last_text_run: row.last_text_run,
          confirmed: row.confirmed === 1,
          generation_id: row.generation_id,
          generation_end: row.generation_end,
          generation_run: row.generation_run,
        },
        event,
      );
      if (step.kind === "ignore") return false;
      for (const kind of step.clear) deleteAttentionKind.run(...key, kind);
      if (step.release) {
        // Released like pi's `session_shutdown`: the row goes, its attention
        // stays, so a `done` outlives the process that raised it.
        deleteAgentByPane.run(...key);
        return true;
      }
      const attention = (kind: "blocked" | "done" | "error", message: string): void => {
        upsertAttention.run({
          server_kind: location.server.kind,
          server_value: serverValue,
          pane: location.pane,
          kind,
          message,
          source: event.harness,
          driver: row.driver,
          session: location.session,
          window: location.window,
          session_name: location.session_name,
          window_name: location.window_name,
          requested_at: event.at,
        });
      };
      if (step.raise?.kind === "settled") {
        const settled = settledState(delivery.focused, row.driver === "orchestrated");
        if (settled !== null) attention(settled, "");
      } else if (step.raise) {
        attention(step.raise.kind, step.raise.message);
      }
      if (!step.next) return true;
      updateInboxAgent.run({
        agent_id: row.agent_id,
        owner_pid: row.owner_pid,
        activity: step.next.activity,
        session: location.session,
        window: location.window,
        session_name: location.session_name,
        window_name: location.window_name,
        session_id: step.next.session_id,
        run_count: step.next.run_count,
        last_text: step.next.last_text,
        last_text_run: step.next.last_text_run,
        confirmed: step.next.confirmed ? 1 : 0,
        generation_id: step.next.generation_id,
        generation_end: step.next.generation_end,
        generation_run: step.next.generation_run,
        updated_at: event.at,
      });
      return true;
    },
  );

  /**
   * IMMEDIATE, like `claimAgent`: it reads rows and then writes them, and
   * `read` lists the inbox under the same lock, which is what makes a drain the
   * only one applying a given file.
   */
  const ingestInbox = database.transaction(
    (read: () => readonly InboxDelivery[], options: IngestOptions): IngestSummary => {
      const isAlive = options.isAlive ?? pidAlive;
      const summary: IngestSummary = { applied: 0, ignored: 0, malformed: 0, changed: [] };
      const changed = new Map<string, InboxDelivery["location"]>();
      for (const delivery of read()) {
        let outcome: "applied" | "ignored" | "malformed" = "malformed";
        if (delivery.event) {
          try {
            outcome = applyInboxEvent(delivery, delivery.event, isAlive) ? "applied" : "ignored";
          } catch {
            // A value the schema refuses. Rolled back to its savepoint and
            // dropped: one bad file must not wedge the pane's inbox.
            outcome = "malformed";
          }
        }
        summary[outcome] += 1;
        if (outcome === "applied") {
          changed.set(
            serverKey(delivery.location.server, delivery.location.pane),
            delivery.location,
          );
        }
        try {
          delivery.consume();
        } catch {
          // Already gone, or undeletable: the next drain sees it again, and an
          // applied event from it is refused by nothing. Best effort.
        }
      }
      summary.changed = [...changed.values()];
      return summary;
    },
  );

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
    };
  }

  return {
    claimAgent,
    reconcileLocal,

    ingestInbox(read, options = {}) {
      return ingestInbox.immediate(read, options);
    },

    harnessState(pane) {
      const row = selectAgentByPane.get(
        pane.server.kind,
        "value" in pane.server ? pane.server.value : "",
        pane.pane,
      ) as AgentDbRow | undefined;
      if (!row) return null;
      return {
        source: row.source,
        harness: row.harness,
        session_id: row.session_id,
        run_count: row.run_count,
        last_text: row.last_text,
        last_text_run: row.last_text_run,
        confirmed: row.confirmed === 1,
      };
    },

    setRuntime(update) {
      // Built from the keys actually PRESENT, so an explicit null is written and
      // an absent key is left alone. COALESCE would have been shorter and cannot
      // express the first case -- which is the one pi hits after every
      // compaction, when the context percent legitimately becomes unknown.
      const columns = RUNTIME_COLUMNS.filter((column) => column in update);
      // Reachable, not defensive: an older pi offers none of the members, so the
      // producer's `runtimeFromContext` returns {} and passes it straight here. A
      // SET clause built from zero columns is a syntax error.
      if (columns.length === 0) return false;
      const assignments = columns.map((column) => `${column} = @${column}`).join(", ");
      const values: Record<string, string | number | null> = {
        agent_id: update.agent_id,
        owner_pid: update.owner_pid,
        updated_at: update.now ?? Date.now(),
      };
      for (const column of columns) {
        const value = update[column];
        // The bundle is one JSON column: it is nullable as a unit and no query
        // looks inside it. Serialised here rather than by the caller, so no
        // producer has to know the storage shape.
        values[column] =
          column === "usage" && value != null ? JSON.stringify(value) : (value as never);
      }
      // Prepared per shape and cached: there are a handful of real combinations
      // (one per event), so this settles after the first few turns rather than
      // re-planning identical SQL forever.
      return runtimeStatement(assignments).run(values).changes === 1;
    },

    setActivity(update) {
      // Both key components are required, so a write from a REPLACED owner
      // matches nothing and returns false. That is not an error and must not be
      // retried: it means this process is no longer the owner of record, and the
      // correct response is silence.
      return (
        updateActivity.run({
          activity: update.activity,
          session: update.location.session,
          window: update.location.window,
          session_name: update.location.session_name,
          window_name: update.location.window_name,
          updated_at: update.now ?? Date.now(),
          agent_id: update.agent_id,
          owner_pid: update.owner_pid,
          server_kind: update.location.server.kind,
          server_value: "value" in update.location.server ? update.location.server.value : "",
          pane: update.location.pane,
        }).changes === 1
      );
    },

    releaseAgent(release) {
      // Attention is deliberately NOT deleted: a `done` raised at settle must
      // survive the agent exiting, or completion becomes invisible the moment
      // the process quits.
      return (
        deleteAgentOwned.run(
          release.agent_id,
          release.owner_pid,
          release.location.server.kind,
          "value" in release.location.server ? release.location.server.value : "",
          release.location.pane,
        ).changes === 1
      );
    },

    recordCrash(location, now = Date.now()) {
      upsertAttention.run({
        server_kind: location.server.kind,
        server_value: "value" in location.server ? location.server.value : "",
        pane: location.pane,
        kind: "crashed",
        message: "",
        source: "murmur",
        driver: DEFAULT_DRIVER,
        session: location.session,
        window: location.window,
        session_name: location.session_name,
        window_name: location.window_name,
        requested_at: now,
      });
    },

    requestAttention(request) {
      // `requested_at` is absent from the DO UPDATE list on purpose. Age means
      // "how long this has gone unmet", so a repeat must not reset the clock —
      // which also makes crash attention idempotent for free. Touches no
      // `agents` row, ever; there is no column here that could.
      upsertAttention.run({
        server_kind: request.location.server.kind,
        server_value: "value" in request.location.server ? request.location.server.value : "",
        pane: request.location.pane,
        kind: request.kind,
        message: request.message,
        source: request.source,
        driver: request.driver,
        session: request.location.session,
        window: request.location.window,
        session_name: request.location.session_name,
        window_name: request.location.window_name,
        requested_at: request.now ?? Date.now(),
      });
    },

    acknowledgePane(location) {
      return deleteAttentionForPane.run(
        location.server.kind,
        "value" in location.server ? location.server.value : "",
        location.pane,
      ).changes;
    },

    localPanes() {
      return readLocalPanes();
    },

    buildLocalSnapshot(identity, worlds) {
      // Reconcile first, which is what makes "a snapshot is authoritative"
      // true: absence from a successful snapshot means absence, so it must
      // never be produced from unreconciled rows. Two transactions rather than
      // one — a write transaction held open across the read would serialise
      // every focus hook on the machine behind an export.
      const allWorlds = Array.isArray(worlds) ? worlds : [worlds];
      for (const world of allWorlds) reconcileLocal(world);
      return {
        murmur_snapshot: SNAPSHOT_VERSION,
        host_id: identity.host_id,
        display_name: identity.display_name,
        murmur_version: MURMUR_VERSION,
        generated_at: allWorlds[0]?.now ?? Date.now(),
        // Rule 3: a pane with no agent and no attention must not be published.
        // `readLocalPanes` builds a pane entry only from a row, so it cannot
        // produce an empty one.
        panes: readLocalPanes(),
      };
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
      // Correcting a target must not discard the cache or a custom jump command.
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
    },

    setPeerJumpCommand(name, jumpCommand) {
      return (
        database.prepare("UPDATE peers SET jump_command = ? WHERE name = ?").run(jumpCommand, name)
          .changes > 0
      );
    },

    removePeer(name) {
      return database.prepare("DELETE FROM peers WHERE name = ?").run(name).changes > 0;
    },

    replacePeerSnapshot(name, fetch) {
      if (!fetch.ok) {
        // Failure touches neither snapshot, snapshot_at nor fetched_at, so the
        // last-known document stands and the peer ages into `stale` on its own.
        database
          .prepare("UPDATE peers SET last_attempt_at = ?, last_error = ? WHERE name = ?")
          .run(fetch.at, fetch.error, name);
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
            WHERE name = ?`,
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
        );
    },

    close() {
      database.close();
    },
  };
}
