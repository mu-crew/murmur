import { type Harness, isHarness } from "./harnesses.js";
import { type Driver, EFFORTS, type Effort, type TmuxServer } from "./types.js";

/**
 * The canonical inbox event: what `murmur hook <harness>` writes for one hook
 * payload, and what the drain applies to the store.
 *
 * Pure, so the store and the drain share one validator. A harness's own
 * payload never reaches the store: each hook row maps it to one of these, and
 * this file decides whether the result is well formed.
 */

/** The event vocabulary. ARCHITECTURE.md § The inbox gives each one's effect. */
export const INBOX_EVENTS = [
  "session_start",
  "prompt_submitted",
  "continued",
  "permission_requested",
  "interrupted",
  "turn_stopped",
  "turn_failed",
  "session_end",
  /**
   * A runtime report (`murmur report`): the `runtime` patch and nothing else.
   * Never a turn, never a claim; an older drain drops it as malformed.
   */
  "runtime_reported",
] as const;

export type InboxEventName = (typeof INBOX_EVENTS)[number];

/** The file format's own version, so a later shape can be told apart. */
export const INBOX_EVENT_VERSION = 1;

/** `last_text` is capped at 64 KB, in UTF-8 bytes, like pi's ctl last text. */
export const LAST_TEXT_MAX_BYTES = 64 * 1024;

export type InboxAgent = {
  agent_name: string | null;
  workstream: string | null;
  role: string | null;
  /** The cli key the agent was started as; defaults to the harness. */
  cli: string | null;
  driver: Driver;
};

/**
 * What a hook payload says its harness runs with: best effort, every key
 * optional, and an absent key never erases what the row already holds.
 * `effort` is a level murmur knows; any other level travels as
 * `provider_effort`, free text.
 */
export type InboxRuntime = {
  model?: string;
  provider?: string;
  effort?: Effort;
  provider_effort?: string;
  /** `murmur report` only: a hook payload names none of these. */
  context_pct?: number;
  context_tokens?: number;
  context_window?: number;
};

export type InboxEvent = {
  v: typeof INBOX_EVENT_VERSION;
  event: InboxEventName;
  harness: Harness;
  /** When the hook ran, in milliseconds since the epoch. */
  at: number;
  /** The tmux server and the pane root the hook's process chain reached. */
  server_pid: number;
  root_pid: number;
  /** The harness process the chain found: the pid the owner gate checks. */
  owner_pid: number;
  /** `$TMUX` and `$TMUX_PANE` when the hook had them, as a cross-check. */
  tmux: string | null;
  tmux_pane: string | null;
  /**
   * The server's socket as its argv names it (`serverSocketFromArgs`), so a
   * drain finds the server of a hook that had no `$TMUX` without asking every
   * socket. A hint: the drain checks the pid behind it. Absent from older
   * hooks' events.
   */
  server_socket?: TmuxServer | null;
  session_id: string | null;
  /** `session_start`'s source: `startup`, `resume`, `clear` or `compact`. */
  source: string | null;
  /** `session_end`'s reason. `clear` keeps the claim. */
  reason: string | null;
  /** The tool a `permission_requested` waits on, or a `turn_failed` message. */
  message: string | null;
  /** `turn_stopped`'s last assistant text. */
  text: string | null;
  generation_id: string | null;
  /** Who wrote it. An `interrupted` from mu is unconfirmed until the harness speaks. */
  by: "harness" | "mu";
  agent: InboxAgent;
  /** Runtime the payload reported, hook events only. Absent from older hooks' events. */
  runtime?: InboxRuntime;
};

/**
 * A payload's runtime fields, each kept only when well formed: a bad field is
 * dropped and the event is not. Empty when nothing is usable.
 */
export function parseRuntime(value: unknown): InboxRuntime {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const runtime: InboxRuntime = {};
  const word = (field: unknown): string | null =>
    typeof field === "string" && field.trim() !== "" ? field : null;
  const model = word(record.model);
  if (model !== null) runtime.model = model;
  const provider = word(record.provider);
  if (provider !== null) runtime.provider = provider;
  const effort = word(record.effort);
  if (effort !== null) {
    const known = EFFORTS.find((level) => level === effort);
    if (known) runtime.effort = known;
    else runtime.provider_effort = effort;
  }
  const applied = word(record.provider_effort);
  if (applied !== null) runtime.provider_effort = applied;
  const pct = record.context_pct;
  if (typeof pct === "number" && Number.isFinite(pct) && pct >= 0 && pct <= 100) {
    runtime.context_pct = pct;
  }
  for (const key of ["context_tokens", "context_window"] as const) {
    const count = record[key];
    if (typeof count === "number" && Number.isSafeInteger(count) && count > 0) {
      runtime[key] = count;
    }
  }
  return runtime;
}

function isEventName(value: unknown): value is InboxEventName {
  return typeof value === "string" && (INBOX_EVENTS as readonly string[]).includes(value);
}

function isPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function optionalText(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : undefined;
}

/**
 * An event bound for the remote area rather than a pane's inbox: a worker whose
 * pane is on another node (D11). It names its origin's key instead of a server
 * and pane root. mu's own remote events (`murmur hook mu --remote`) name no
 * owner and may name no harness: they apply to whoever holds the key.
 */
export type RemoteEvent = Omit<
  InboxEvent,
  "harness" | "server_pid" | "root_pid" | "owner_pid" | "server_socket" | "runtime"
> & {
  remote_key: string;
  harness: Harness | null;
  owner_pid: number | null;
};

type EventBody = Omit<
  InboxEvent,
  "v" | "harness" | "server_pid" | "root_pid" | "owner_pid" | "server_socket" | "runtime"
>;

/** The fields every event shares, validated, or null. */
function parseBody(record: Record<string, unknown>): EventBody | null {
  if (!isEventName(record.event)) return null;
  if (typeof record.at !== "number" || !Number.isFinite(record.at) || record.at < 0) return null;
  const texts = {
    tmux: optionalText(record.tmux),
    tmux_pane: optionalText(record.tmux_pane),
    session_id: optionalText(record.session_id),
    source: optionalText(record.source),
    reason: optionalText(record.reason),
    message: optionalText(record.message),
    text: optionalText(record.text),
    generation_id: optionalText(record.generation_id),
  };
  for (const value of Object.values(texts)) if (value === undefined) return null;
  const by = record.by ?? "harness";
  if (by !== "harness" && by !== "mu") return null;
  const agent = parseAgent(record.agent);
  if (!agent) return null;
  return {
    event: record.event,
    at: Math.floor(record.at),
    tmux: texts.tmux ?? null,
    tmux_pane: texts.tmux_pane ?? null,
    session_id: texts.session_id ?? null,
    source: texts.source ?? null,
    reason: texts.reason ?? null,
    message: texts.message ?? null,
    text: texts.text ?? null,
    generation_id: texts.generation_id ?? null,
    by,
    agent,
  };
}

function parseRecord(raw: string): Record<string, unknown> | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  return record.v === INBOX_EVENT_VERSION ? record : null;
}

/**
 * One event, validated, or null.
 *
 * Total: a malformed file is dropped by the drain, never applied in part. Keys
 * this build does not know are ignored, so a newer hook's extra fields do not
 * cost the whole event.
 */
export function parseInboxEvent(raw: string): InboxEvent | null {
  const record = parseRecord(raw);
  if (!record || !isHarness(record.harness)) return null;
  if (!isPid(record.server_pid) || !isPid(record.root_pid) || !isPid(record.owner_pid)) {
    return null;
  }
  const body = parseBody(record);
  if (!body) return null;
  const runtime = parseRuntime(record.runtime);
  return {
    v: INBOX_EVENT_VERSION,
    ...body,
    ...(Object.keys(runtime).length > 0 ? { runtime } : {}),
    harness: record.harness,
    server_pid: record.server_pid,
    root_pid: record.root_pid,
    owner_pid: record.owner_pid,
    server_socket: parseServerSocket(record.server_socket),
  };
}

/**
 * An event's `server_socket`, or null. Only a hint, so a malformed one reads
 * as none rather than costing the event.
 */
export function parseServerSocket(value: unknown): TmuxServer | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind === "default") return { kind: "default" };
  if ((record.kind !== "label" && record.kind !== "path") || typeof record.value !== "string") {
    return null;
  }
  // A label is a name in the reader's socket directory, never a path out of it.
  if (record.value === "") return null;
  if (record.kind === "path" ? !record.value.startsWith("/") : record.value.includes("/")) {
    return null;
  }
  return { kind: record.kind, value: record.value };
}

/** One remote-area event, validated, or null. Total, like `parseInboxEvent`. */
export function parseRemoteEvent(raw: string): RemoteEvent | null {
  const record = parseRecord(raw);
  if (!record) return null;
  if (typeof record.remote_key !== "string" || record.remote_key === "") return null;
  const harness = record.harness ?? null;
  if (harness !== null && !isHarness(harness)) return null;
  const owner = record.owner_pid ?? null;
  if (owner !== null && !isPid(owner)) return null;
  const body = parseBody(record);
  if (!body) return null;
  return {
    v: INBOX_EVENT_VERSION,
    ...body,
    remote_key: record.remote_key,
    harness,
    owner_pid: owner,
  };
}

/** An event's `agent`, validated, or null; absent reads as the human's own agent. */
export function parseAgent(value: unknown): InboxAgent | null {
  if (value === undefined || value === null) {
    return { agent_name: null, workstream: null, role: null, cli: null, driver: "human" };
  }
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const fields = {
    agent_name: optionalText(record.agent_name),
    workstream: optionalText(record.workstream),
    role: optionalText(record.role),
    cli: optionalText(record.cli),
  };
  for (const field of Object.values(fields)) if (field === undefined) return null;
  const driver = record.driver ?? "human";
  if (driver !== "human" && driver !== "orchestrated") return null;
  return {
    agent_name: fields.agent_name ?? null,
    workstream: fields.workstream ?? null,
    role: fields.role ?? null,
    cli: fields.cli ?? null,
    driver,
  };
}

/** `text` cut to at most `LAST_TEXT_MAX_BYTES` of UTF-8, never inside a character. */
export function capLastText(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= LAST_TEXT_MAX_BYTES) return text;
  let end = LAST_TEXT_MAX_BYTES;
  // Back up over continuation bytes (10xxxxxx) to a character boundary.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}
