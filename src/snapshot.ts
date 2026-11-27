import { isAbsolute } from "node:path";
import { asPaneId, asSessionId, asWindowId } from "./ids.js";
import type {
  Activity,
  AttentionKind,
  Driver,
  Snapshot,
  SnapshotAgent,
  SnapshotAttention,
  SnapshotPane,
  TmuxServer,
} from "./types.js";
import {
  ATTENTION_PRIORITY,
  BLOCKED_KINDS,
  paneKey,
  SNAPSHOT_VERSION,
  serverValue,
} from "./types.js";

/**
 * A peer answered, and what it said is not a snapshot.
 *
 * A distinct type because the collector must be able to tell this from an
 * unreachable host: a node that serves a bad document is REACHABLE BUT BROKEN,
 * and an operator needs to see that rather than "asleep, probably".
 */
export class SnapshotInvalidError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    // An EMPTY path means the failure is about the document as a whole, not
    // about a field in it, so there is nothing to prefix. Joining regardless
    // produced `bubba: : not JSON (...)` in `peer list` and in the one line
    // `murmur collect` prints -- measured against a real second node, and for
    // the most common remote misconfiguration there is (murmur missing, so the
    // "document" is a shell error). `path` itself stays "", because that is what
    // it means and a caller must not have to know a sentinel.
    super(path === "" ? detail : `${path}: ${detail}`);
    this.name = "SnapshotInvalidError";
  }
}

function fail(path: string, detail: string): never {
  throw new SnapshotInvalidError(path, detail);
}

/**
 * Exactly these keys, no more and no fewer.
 *
 * Unknown keys are rejected rather than carried, and nothing is coerced or
 * defaulted: validation happens BEFORE storage, so no unknown value can reach a
 * sort, a count or a render path.
 */
function object(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) if (!(key in record)) fail(path, `missing key ${key}`);
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) fail(path, `unknown key ${key}`);
  }
  return record;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value === "") fail(path, "expected a non-empty string");
  return value;
}

function textOrNull(value: unknown, path: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") fail(path, "expected a string or null");
  return value;
}

function anyText(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "expected a string");
  return value;
}

/** A percentage, 0..100, or null. Nothing is clamped. */
function percentOrNull(value: unknown, path: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
    fail(path, "expected an integer in 0..100 or null");
  }
  return value;
}

/** A count of things, or null when the owner does not report it. */
function countOrNull(value: unknown, path: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(path, "expected a non-negative integer or null");
  }
  return value;
}

function timestamp(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(path, "expected a non-negative integer");
  }
  return value;
}

function member<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(path, `expected one of ${allowed.join(", ")}`);
  }
  return value as T;
}

const ACTIVITIES: readonly Activity[] = ["running", "stopped"];
const DRIVERS: readonly Driver[] = ["human", "orchestrated"];
const KINDS: readonly AttentionKind[] = ATTENTION_PRIORITY;

const TOP_KEYS = [
  "murmur_snapshot",
  "host_id",
  "display_name",
  "murmur_version",
  "generated_at",
  "panes",
] as const;
const PANE_KEYS = [
  "server",
  "pane",
  "session",
  "window",
  "session_name",
  "window_name",
  "agent",
  "attention",
] as const;
const AGENT_KEYS = [
  "activity",
  "agent_name",
  "workstream",
  "role",
  "driver",
  "cli",
  "harness",
  "pane_title",
  "title",
  "message",
  "progress",
  "blocked_kind",
  "pending",
  "resume_command",
  "resume_cwd",
  "cwd",
  "updated_at",
] as const;
const ATTENTION_KEYS = ["kind", "message", "source", "driver", "requested_at"] as const;
const SERVER_KINDS = ["default", "label", "path", "rex"] as const;

function parseAgent(value: unknown, path: string): SnapshotAgent | null {
  if (value === null) return null;
  const row = object(value, path, AGENT_KEYS);
  return {
    activity: member(row.activity, `${path}.activity`, ACTIVITIES),
    agent_name: textOrNull(row.agent_name, `${path}.agent_name`),
    workstream: textOrNull(row.workstream, `${path}.workstream`),
    role: textOrNull(row.role, `${path}.role`),
    driver: member(row.driver, `${path}.driver`, DRIVERS),
    cli: textOrNull(row.cli, `${path}.cli`),
    harness: textOrNull(row.harness, `${path}.harness`),
    pane_title: textOrNull(row.pane_title, `${path}.pane_title`),
    title: textOrNull(row.title, `${path}.title`),
    message: textOrNull(row.message, `${path}.message`),
    progress: percentOrNull(row.progress, `${path}.progress`),
    // Null-tolerant `member`: the set is closed, but not saying is allowed.
    blocked_kind:
      row.blocked_kind === null
        ? null
        : member(row.blocked_kind, `${path}.blocked_kind`, BLOCKED_KINDS),
    pending: countOrNull(row.pending, `${path}.pending`),
    resume_command: textOrNull(row.resume_command, `${path}.resume_command`),
    resume_cwd: textOrNull(row.resume_cwd, `${path}.resume_cwd`),
    cwd: textOrNull(row.cwd, `${path}.cwd`),
    updated_at: timestamp(row.updated_at, `${path}.updated_at`),
  };
}

function parseAttention(value: unknown, path: string): SnapshotAttention[] {
  if (!Array.isArray(value)) fail(path, "expected an array");
  const seen = new Set<AttentionKind>();
  return value.map((entry, index) => {
    const at = `${path}[${index}]`;
    const row = object(entry, at, ATTENTION_KEYS);
    const kind = member(row.kind, `${at}.kind`, KINDS);
    if (seen.has(kind)) fail(`${at}.kind`, `duplicate kind ${kind} for this pane`);
    seen.add(kind);
    return {
      kind,
      message: anyText(row.message, `${at}.message`),
      source: anyText(row.source, `${at}.source`),
      driver: member(row.driver, `${at}.driver`, DRIVERS),
      requested_at: timestamp(row.requested_at, `${at}.requested_at`),
    };
  });
}

function parseServer(value: unknown, path: string): TmuxServer {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  const kind = member((value as Record<string, unknown>).kind, `${path}.kind`, SERVER_KINDS);
  if (kind === "default" || kind === "rex") {
    object(value, path, ["kind"]);
    return { kind };
  }
  const row = object(value, path, ["kind", "value"]);
  const serverValue = text(row.value, `${path}.value`);
  if (kind === "path" && !isAbsolute(serverValue)) {
    fail(`${path}.value`, "expected an absolute path");
  }
  return { kind, value: serverValue };
}

function parsePane(value: unknown, path: string): SnapshotPane {
  const row = object(value, path, PANE_KEYS);
  const agent = parseAgent(row.agent, `${path}.agent`);
  const attention = parseAttention(row.attention, `${path}.attention`);
  // Rule 3 of the document schema: a pane with neither is not a pane worth
  // publishing, so a document carrying one is malformed rather than merely
  // noisy.
  if (agent === null && attention.length === 0) {
    fail(path, "a pane with no agent and no attention must not be emitted");
  }
  const server = parseServer(row.server, `${path}.server`);
  const pane = text(row.pane, `${path}.pane`);
  // A tmux pane id is `%N`, nothing else. A peer's `jump_command` substitutes
  // `{pane}` into a shell command unquoted, so a pane id is never free text.
  if (server.kind !== "rex" && !/^%\d+$/.test(pane)) {
    fail(`${path}.pane`, "expected a tmux pane id (%N)");
  }
  return {
    server,
    pane: asPaneId(pane),
    session: asSessionId(text(row.session, `${path}.session`)),
    window: asWindowId(text(row.window, `${path}.window`)),
    session_name: textOrNull(row.session_name, `${path}.session_name`),
    window_name: textOrNull(row.window_name, `${path}.window_name`),
    agent,
    attention,
  };
}

/**
 * Parse and totally validate one snapshot document.
 *
 * `murmur_snapshot` must be exactly `SNAPSHOT_VERSION`. A higher value is rejected, and so is a
 * LOWER one: compatibility is offered in neither direction, because a reader
 * that accepted an older document would be guessing at the fields that version
 * added -- which is precisely the state a human is acting on. A version mismatch
 * is an operator-visible pairing problem, and saying so is the honest report.
 */
export function parseSnapshot(input: string): Snapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    fail("", `not JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const top = object(parsed, "", TOP_KEYS);
  if (top.murmur_snapshot !== SNAPSHOT_VERSION) {
    fail(
      "murmur_snapshot",
      `expected ${SNAPSHOT_VERSION}, got ${JSON.stringify(top.murmur_snapshot)}`,
    );
  }
  if (!Array.isArray(top.panes)) fail("panes", "expected an array");

  const panes = top.panes.map((entry, index) => parsePane(entry, `panes[${index}]`));
  const seen = new Set<string>();
  for (const pane of panes) {
    const address = paneKey(pane);
    if (seen.has(address)) {
      const value = serverValue(pane.server);
      fail("panes", `duplicate pane ${pane.server.kind}${value ? `:${value}` : ""}:${pane.pane}`);
    }
    seen.add(address);
  }

  return {
    murmur_snapshot: SNAPSHOT_VERSION,
    host_id: text(top.host_id, "host_id"),
    display_name: text(top.display_name, "display_name"),
    murmur_version: text(top.murmur_version, "murmur_version"),
    generated_at: timestamp(top.generated_at, "generated_at"),
    panes,
  };
}
