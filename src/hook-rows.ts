import type { Harness } from "./harnesses.js";
import { capLastText, type InboxEventName } from "./inbox-event.js";

/**
 * Each hook harness's row: how one of its hook payloads maps onto the inbox
 * vocabulary, and which payloads it drops.
 *
 * Pure, and keyed on the payload alone, so every rule is pinned by the payloads
 * recorded from the real harnesses (test/fixtures/u0-*.jsonl). Placing the
 * event in a pane is the process chain's job (`src/process-chain.ts`), not a
 * row's: a row only says what happened.
 *
 * A row reads only the fields it maps. Prompts, tool inputs and transcript
 * paths are never copied, and nothing here reads a transcript: the last
 * assistant text travels in the payload (`last_assistant_message`), which is the
 * turn that just ended. A transcript read at hook time can still hold the
 * previous turn.
 */

export type HookPayload = Record<string, unknown>;

/** What a row makes of one payload: the vocabulary's fields, nothing about placement. */
export type HookMapping = {
  event: InboxEventName;
  session_id: string | null;
  source: string | null;
  reason: string | null;
  message: string | null;
  text: string | null;
  generation_id: string | null;
};

type HookRow = (payload: HookPayload) => HookMapping | null;

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function mapping(
  event: InboxEventName,
  payload: HookPayload,
  over: Partial<HookMapping> = {},
): HookMapping {
  return {
    event,
    session_id: text(payload.session_id),
    source: null,
    reason: null,
    message: null,
    text: null,
    generation_id: null,
    ...over,
  };
}

/** `turn_stopped`, with the payload's own last assistant text, capped at 64 KB. */
function stopped(payload: HookPayload): HookMapping {
  const last = text(payload.last_assistant_message);
  return mapping("turn_stopped", payload, { text: last === null ? null : capLastText(last) });
}

/**
 * The tool a permission prompt waits on. `PermissionRequest` names it outright;
 * a claude `Notification` says it in prose ("Claude needs your permission to
 * use Bash").
 */
function permissionMessage(payload: HookPayload): string {
  const tool = text(payload.tool_name);
  if (tool) return tool;
  const said = text(payload.message) ?? "";
  return /permission to use (.+?)\.?$/.exec(said)?.[1] ?? said;
}

/**
 * Whether a claude `Notification` is a permission prompt. Its other kinds (the
 * idle reminder "Claude is waiting for your input", auth notices) are not an
 * agent waiting on a decision, and map to nothing.
 */
function isPermissionNotification(payload: HookPayload): boolean {
  const kind = text(payload.notification_type);
  if (kind !== null) return kind === "permission_prompt";
  return /\bpermission\b/i.test(text(payload.message) ?? "");
}

/** `StopFailure`'s reason: its error kind, then the details when it has them. */
function failureMessage(payload: HookPayload): string | null {
  const parts = [payload.error, payload.error_details, payload.message]
    .map(text)
    .filter((part): part is string => part !== null && part !== "");
  return parts.length > 0 ? parts.join(": ") : null;
}

/**
 * Claude Code. One command for every event: the payload's `hook_event_name`
 * says which. `SubagentStop` is a subagent's turn, not the pane's, and maps to
 * nothing, like every event not listed. claude has no interrupt hook; mu
 * writes that one (`murmur hook mu`).
 *
 * Its other drop rule, chains that never reach tmux (the detached children
 * that fire `SessionEnd` from under init), is the process chain's: the row
 * cannot see it.
 */
const claude: HookRow = (payload) => {
  switch (payload.hook_event_name) {
    case "SessionStart":
      return mapping("session_start", payload, { source: text(payload.source) });
    case "UserPromptSubmit":
      return mapping("prompt_submitted", payload);
    case "PermissionRequest":
      return mapping("permission_requested", payload, { message: permissionMessage(payload) });
    case "Notification":
      return isPermissionNotification(payload)
        ? mapping("permission_requested", payload, { message: permissionMessage(payload) })
        : null;
    case "Stop":
      return stopped(payload);
    case "StopFailure":
      return mapping("turn_failed", payload, { message: failureMessage(payload) });
    case "SessionEnd":
      return mapping("session_end", payload, { reason: text(payload.reason) });
    default:
      return null;
  }
};

/**
 * codex. Its hook payloads use claude's event and field names, plus
 * `Interrupt` (with `turn_id`) when the user stops a turn.
 *
 * Dropped whole: any payload whose `transcript_path` is null. codex runs a
 * hidden title-generation session beside the real one that fires the full
 * event set, from the same process, with no transcript. Its `SessionStart`
 * would otherwise reset the pane on every first prompt, and its `Stop` would
 * replace the turn's text with a JSON title.
 *
 * No failure event: no codex hook was seen to report a failed turn, so
 * `turn_failed` is never written for codex.
 */
const codex: HookRow = (payload) => {
  if ("transcript_path" in payload && payload.transcript_path === null) return null;
  switch (payload.hook_event_name) {
    case "SessionStart":
      return mapping("session_start", payload, { source: text(payload.source) });
    case "UserPromptSubmit":
      return mapping("prompt_submitted", payload);
    case "PermissionRequest":
      return mapping("permission_requested", payload, { message: permissionMessage(payload) });
    case "Stop":
      return stopped(payload);
    case "Interrupt":
      return mapping("interrupted", payload);
    case "SessionEnd":
      return mapping("session_end", payload, { reason: text(payload.reason) });
    default:
      return null;
  }
};

/** The harnesses `murmur hook <harness>` has a row for. */
export const HOOK_ROWS: Readonly<Partial<Record<Harness, HookRow>>> = Object.freeze({
  claude,
  codex,
});

export function hasHookRow(name: string): name is Harness {
  return Object.hasOwn(HOOK_ROWS, name);
}

/** One payload through its harness's row: the event to write, or null to write nothing. */
export function mapHookPayload(harness: Harness, payload: HookPayload): HookMapping | null {
  const row = HOOK_ROWS[harness];
  return row ? row(payload) : null;
}
