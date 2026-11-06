import {
  closeSync,
  fstatSync,
  linkSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { ensureDir } from "./dirs.js";
import { type Harness, isHarness } from "./harnesses.js";
import {
  type InboxAgent,
  type InboxEventName,
  parseAgent,
  parseRemoteEvent,
  type RemoteEvent,
} from "./inbox-event.js";
import { REMOTE_TMP, remoteDir, remoteKeyName } from "./inbox-file.js";
import { pidAlive, tmuxAgentState } from "./mux.js";
import { settledState } from "./settle.js";
import { GENERATION_ENDS, initialTurn, stepTurn, type TurnState } from "./turn.js";
import type { LiveCheck } from "./types.js";
import { renderState } from "./view.js";

/**
 * The remote area's read side: `murmur pane --remote <key>` (D11).
 *
 * A worker mu started on another node, for a pane on the origin node, has its
 * hooks write to `remote/<key>/` here instead of the inbox (`src/hook.ts`). Its
 * events never reach this node's store or snapshot. mu reads them on demand by
 * running `murmur pane --remote <key> --json` here through the host profile's
 * `exec`: the read applies the waiting events, in name order, to the key's state
 * in `remote/<key>.json` (replaced by rename), deletes them, and prints the
 * state together with the events it applied, which mu relays to the origin
 * pane's inbox with `murmur hook mu`.
 *
 * The transitions are the inbox's own (`src/turn.ts`). The ownership rules are
 * the store's, for a key rather than a pane: the first harness event claims the
 * key, a different live owner is refused, another session's events are
 * ignored, and mu's events (no owner) apply to whoever holds the claim.
 */

const REMOTE_STATE_VERSION = 1;

export type RemoteAttention = { kind: "blocked" | "error" | "done"; message: string; at: number };

/** A key's state, as kept in `remote/<key>.json`. */
export type RemoteState = {
  v: typeof REMOTE_STATE_VERSION;
  key: string;
  /** Whether a live claim holds the key. A released key keeps its last turn, for mu to collect. */
  claimed: boolean;
  harness: Harness | null;
  owner_pid: number | null;
  agent: InboxAgent | null;
  turn: TurnState;
  attention: RemoteAttention[];
  claimed_at: number | null;
  updated_at: number | null;
};

/** One applied event, as mu relays it: the vocabulary's fields, nothing about placement. */
export type RemoteEventReport = {
  event: InboxEventName;
  harness: Harness | null;
  at: number;
  by: RemoteEvent["by"];
  session_id: string | null;
  source: string | null;
  reason: string | null;
  message: string | null;
  text: string | null;
  generation_id: string | null;
};

export type RemoteReport = {
  remote: string;
  /** The pane option's word, as `murmur pane` reports it; null when nothing ever claimed the key. */
  state: string | null;
  agent: {
    agent_name: string | null;
    workstream: string | null;
    role: string | null;
    cli: string | null;
    driver: string;
    activity: TurnState["activity"];
    harness: Harness | null;
    session_id: string | null;
    run_count: number;
    last_text: string | null;
    /** The run whose turn wrote `last_text`, as `murmur pane` reports it. */
    last_text_run: number | null;
    confirmed: boolean;
    claimed: boolean;
    claimed_at: number | null;
    updated_at: number | null;
  } | null;
  attention: RemoteAttention[];
  /** The events this read applied, oldest first. Each is applied once; the next read will not list it. */
  events: RemoteEventReport[];
};

export function emptyRemoteState(key: string): RemoteState {
  return {
    v: REMOTE_STATE_VERSION,
    key,
    claimed: false,
    harness: null,
    owner_pid: null,
    agent: null,
    turn: initialTurn(null),
    attention: [],
    claimed_at: null,
    updated_at: null,
  };
}

function nullableText(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function nullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function nullableRun(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0);
}

function parseTurn(value: unknown): TurnState | null {
  if (typeof value !== "object" || value === null) return null;
  const turn = value as Record<string, unknown>;
  if (turn.activity !== "running" && turn.activity !== "stopped") return null;
  if (!nullableText(turn.session_id) || !nullableText(turn.last_text)) return null;
  if (typeof turn.run_count !== "number" || !Number.isInteger(turn.run_count)) return null;
  if (typeof turn.confirmed !== "boolean" || !nullableText(turn.generation_id)) return null;
  const end = turn.generation_end;
  if (end !== null && !(GENERATION_ENDS as readonly unknown[]).includes(end)) return null;
  // Absent from a state an earlier build stored: unknown, not a refusal.
  const textRun = turn.last_text_run ?? null;
  const generationRun = turn.generation_run ?? null;
  if (!nullableRun(textRun) || !nullableRun(generationRun)) return null;
  return {
    activity: turn.activity,
    session_id: turn.session_id,
    run_count: turn.run_count,
    last_text: turn.last_text,
    last_text_run: textRun,
    confirmed: turn.confirmed,
    generation_id: turn.generation_id,
    generation_end: end as TurnState["generation_end"],
    generation_run: generationRun,
  };
}

function parseAttention(value: unknown): RemoteAttention[] | null {
  if (!Array.isArray(value)) return null;
  const entries: RemoteAttention[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const { kind, message, at } = entry as Record<string, unknown>;
    if (kind !== "blocked" && kind !== "error" && kind !== "done") return null;
    if (typeof message !== "string" || typeof at !== "number") return null;
    entries.push({ kind, message, at });
  }
  return entries;
}

/** A stored state for `key`, validated, or null. A file that does not hold up reads as no state. */
export function parseRemoteState(raw: string, key: string): RemoteState | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (record.v !== REMOTE_STATE_VERSION || record.key !== key) return null;
  if (typeof record.claimed !== "boolean") return null;
  const harness = record.harness;
  if (harness !== null && !isHarness(harness)) return null;
  if (!nullableNumber(record.owner_pid)) return null;
  if (!nullableNumber(record.claimed_at) || !nullableNumber(record.updated_at)) return null;
  const agent = record.agent === null ? null : parseAgent(record.agent);
  if (record.agent !== null && agent === null) return null;
  const turn = parseTurn(record.turn);
  const attention = parseAttention(record.attention);
  if (!turn || !attention) return null;
  return {
    v: REMOTE_STATE_VERSION,
    key,
    claimed: record.claimed,
    harness,
    owner_pid: record.owner_pid,
    agent,
    turn,
    attention,
    claimed_at: record.claimed_at,
    updated_at: record.updated_at,
  };
}

/**
 * One event applied to a key's state: the new state, or null when the event is
 * refused. Pure but for `isAlive`.
 */
export function applyRemoteEvent(
  state: RemoteState,
  event: RemoteEvent,
  isAlive: LiveCheck,
): RemoteState | null {
  let current = state;
  if (event.owner_pid === null) {
    // mu's: it applies to the claim, and cannot make one.
    if (!current.claimed) return null;
    if (event.harness !== null && current.harness !== null && event.harness !== current.harness) {
      return null;
    }
  } else if (!current.claimed || current.owner_pid !== event.owner_pid) {
    if (event.event === "session_end") return null;
    if (current.claimed && current.owner_pid !== null && isAlive(current.owner_pid)) return null;
    // Claimed afresh. The previous owner is gone, and with it its attention,
    // as the store's same-pane replace drops it.
    current = {
      ...emptyRemoteState(current.key),
      claimed: true,
      harness: event.harness,
      owner_pid: event.owner_pid,
      agent: event.agent,
      turn: initialTurn(event.session_id),
      claimed_at: event.at,
    };
  } else if (
    event.event !== "session_start" &&
    event.session_id !== null &&
    current.turn.session_id !== null &&
    event.session_id !== current.turn.session_id
  ) {
    return null;
  }

  const step = stepTurn(current.turn, event);
  if (step.kind === "ignore") return null;
  let attention = current.attention.filter((entry) => !step.clear.includes(entry.kind));
  const raise = (kind: RemoteAttention["kind"], message: string): void => {
    attention = [
      ...attention.filter((entry) => entry.kind !== kind),
      { kind, message, at: event.at },
    ];
  };
  if (step.raise?.kind === "settled") {
    // Nobody looks at a remote pane from here; the origin node decides focus
    // when mu relays the turn.
    const settled = settledState(false, current.agent?.driver === "orchestrated");
    if (settled !== null) raise(settled, "");
  } else if (step.raise) {
    raise(step.raise.kind, step.raise.message);
  }
  return {
    ...current,
    // A released key keeps its last turn: mu may collect a worker's final text
    // after the worker exits.
    claimed: step.release ? false : current.claimed,
    turn: step.next ?? current.turn,
    attention,
    updated_at: event.at,
  };
}

/** The word `murmur pane` would print for this state. */
function stateWord(state: RemoteState): string | null {
  // As for a pane: a released key with nothing to say has no state.
  if (!state.claimed && state.attention.length === 0) return null;
  const rendered = renderState({
    activity: state.claimed ? state.turn.activity : null,
    attention: state.attention,
  });
  if (rendered === "idle" && state.claimed && !state.turn.confirmed) return "idle?";
  return tmuxAgentState(rendered);
}

export function remoteReport(state: RemoteState, events: RemoteEventReport[]): RemoteReport {
  const agent = state.agent;
  return {
    remote: state.key,
    state: stateWord(state),
    agent:
      state.claimed_at === null
        ? null
        : {
            agent_name: agent?.agent_name ?? null,
            workstream: agent?.workstream ?? null,
            role: agent?.role ?? null,
            cli: agent?.cli ?? state.harness,
            driver: agent?.driver ?? "human",
            activity: state.turn.activity,
            harness: state.harness,
            session_id: state.turn.session_id,
            run_count: state.turn.run_count,
            last_text: state.turn.last_text,
            last_text_run: state.turn.last_text_run,
            confirmed: state.turn.confirmed,
            claimed: state.claimed,
            claimed_at: state.claimed_at,
            updated_at: state.updated_at,
          },
    attention: state.attention,
    events,
  };
}

/** How long a lock whose holder cannot be read (written but not yet filled) is waited on. */
const LOCK_UNNAMED_MS = 3000;
/** A read takes milliseconds: a lock this old is stale whoever it names (a reused pid). */
const LOCK_MAX_AGE_MS = 60_000;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The lock file's identity and holder, or null when there is none. */
function lockSeen(path: string): { ino: number; mtime: number; pid: number | null } | null {
  try {
    const stat = statSync(path);
    const said = readFileSync(path, "utf8").trim();
    const pid = /^\d+$/.test(said) ? Number(said) : null;
    return { ino: stat.ino, mtime: stat.mtimeMs, pid };
  } catch {
    return null;
  }
}

/**
 * Take a stale lock away, unless another waiter took it first. It is renamed
 * aside, atomically, so of two waiters that judged it stale only one moves it;
 * if what moved is not the file judged stale (the other waiter's fresh lock),
 * it goes back.
 */
function takeStaleLock(
  path: string,
  tmp: string,
  stale: { ino: number; pid: number | null },
): void {
  ensureDir(tmp);
  const aside = join(tmp, `lock-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    renameSync(path, aside);
  } catch {
    return; // Gone: another waiter took it.
  }
  try {
    const moved = lockSeen(aside);
    if (moved && (moved.ino !== stale.ino || moved.pid !== stale.pid)) linkSync(aside, path);
  } catch {
    // Its place was taken meanwhile; the next attempt sees who holds it.
  } finally {
    rmSync(aside, { force: true });
  }
}

/**
 * Hold `path` as a lock while `work` runs. Two reads of one key at once (mu's
 * wait beside its send gate) would otherwise both apply the same files, and mu
 * would relay each event twice. The lock names its holder's pid, and is taken
 * over only from a dead holder (a reader killed with its ssh), or when it is
 * older than any read could be. A live holder is waited for.
 */
function withLock<T>(path: string, tmp: string, isAlive: LiveCheck, work: () => T): T {
  let held: number | null = null;
  for (;;) {
    let fd: number;
    try {
      fd = openSync(path, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") break;
      const seen = lockSeen(path);
      if (seen === null) continue; // Released meanwhile.
      const age = Date.now() - seen.mtime;
      const stale =
        age > LOCK_MAX_AGE_MS ||
        (seen.pid === null
          ? age > LOCK_UNNAMED_MS
          : seen.pid !== process.pid && !isAlive(seen.pid));
      if (stale) takeStaleLock(path, tmp, seen);
      else sleep(10);
      continue;
    }
    try {
      writeSync(fd, String(process.pid));
      held = fstatSync(fd).ino;
    } finally {
      closeSync(fd);
    }
    break;
  }
  try {
    return work();
  } finally {
    // Only our own: a lock taken from us as stale is its new holder's.
    if (held !== null && lockSeen(path)?.ino === held) rmSync(path, { force: true });
  }
}

/** A writer that died between write and link leaves its file in the tmp directory. */
const TEMPORARY_MAX_AGE_MS = 60 * 60 * 1000;

function sweepTemporaries(tmp: string, now: number): void {
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

function report(event: RemoteEvent): RemoteEventReport {
  return {
    event: event.event,
    harness: event.harness,
    at: event.at,
    by: event.by,
    session_id: event.session_id,
    source: event.source,
    reason: event.reason,
    message: event.message,
    text: event.text,
    generation_id: event.generation_id,
  };
}

export type DrainRemoteOptions = { dir?: string; isAlive?: LiveCheck; now?: number };

/**
 * Apply the key's waiting events to its state, store the state, delete the
 * events, and report. The reason, as a string, when the key cannot name a file.
 */
export function drainRemote(key: string, options: DrainRemoteOptions = {}): RemoteReport | string {
  const name = remoteKeyName(key);
  if (name === null) return `not a usable remote key: ${JSON.stringify(key)}`;
  const dir = options.dir ?? remoteDir();
  const isAlive = options.isAlive ?? pidAlive;
  ensureDir(dir);
  sweepTemporaries(join(dir, REMOTE_TMP), options.now ?? Date.now());
  const statePath = join(dir, `${name}.json`);
  return withLock(join(dir, `${name}.lock`), join(dir, REMOTE_TMP), isAlive, () => {
    let state = emptyRemoteState(key);
    try {
      state = parseRemoteState(readFileSync(statePath, "utf8"), key) ?? state;
    } catch {
      // No state yet.
    }
    const eventDir = join(dir, name);
    let files: string[] = [];
    try {
      files = readdirSync(eventDir)
        .filter((file) => file.endsWith(".json"))
        .sort();
    } catch {
      files = [];
    }
    const applied: RemoteEventReport[] = [];
    let before = state;
    for (const file of files) {
      const path = join(eventDir, file);
      let event: RemoteEvent | null = null;
      try {
        event = parseRemoteEvent(readFileSync(path, "utf8"));
      } catch {
        event = null;
      }
      // An event naming another key than its directory is not this key's.
      const next =
        event && event.remote_key === key ? applyRemoteEvent(state, event, isAlive) : null;
      if (event && next) {
        state = next;
        applied.push(report(event));
      }
      // Stored before its file goes: a crash in between re-applies that one
      // event on the next read, and never loses it.
      if (state !== before) {
        storeState(dir, statePath, state);
        before = state;
      }
      try {
        unlinkSync(path);
      } catch {
        // Gone already.
      }
    }
    try {
      rmdirSync(eventDir);
    } catch {
      // Not empty (a hook just wrote), or never made.
    }
    return remoteReport(state, applied);
  });
}

/** The state file, replaced by rename so a reader never sees half of one. */
function storeState(dir: string, path: string, state: RemoteState): void {
  const tmp = join(dir, REMOTE_TMP);
  ensureDir(tmp);
  const written = join(tmp, `state-${process.pid}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(written, JSON.stringify(state));
  renameSync(written, path);
}
