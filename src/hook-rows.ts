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

/**
 * cursor-agent. Its own event names, camelCased, and one `stop` for every way
 * a turn ends, told apart by `status`: `completed` is a stop, `aborted` an
 * interrupt the user made (Escape), `error` a failure.
 *
 * Every payload names its turn with `generation_id`, carried on the event,
 * because two of cursor-agent's rules pair events of one turn and only the
 * store sees both:
 *
 * - The text arrives in its own event, `afterAgentResponse`, which can land
 *   AFTER the turn's `stop` (hooks run concurrently). It is written as a
 *   `turn_stopped` carrying the text; the store ends a generation's turn once,
 *   on whichever comes first, and a later one only fills in the text.
 * - An aborted turn is followed by an `error` stop for the same generation,
 *   which is the abort's echo, not a failure: the store drops it.
 *
 * No permission hook exists, so a cursor-agent pane is never `blocked`. A
 * session's end says `completed` whatever ended it; none keeps the claim.
 *
 * Never copied: `user_email`, nor anything of the environment's
 * (`CURSOR_USER_EMAIL`, `CURSOR_ASKPASS_SECRET`). Like every row, this one
 * reads only the fields it maps.
 */
const cursorAgent: HookRow = (payload) => {
  const generation = { generation_id: text(payload.generation_id) };
  switch (payload.hook_event_name) {
    case "sessionStart":
      return mapping("session_start", payload, generation);
    case "beforeSubmitPrompt":
      return mapping("prompt_submitted", payload, generation);
    case "afterAgentResponse": {
      const said = text(payload.text);
      return said === null
        ? null
        : mapping("turn_stopped", payload, { ...generation, text: capLastText(said) });
    }
    case "stop":
      switch (payload.status) {
        case "completed":
          return mapping("turn_stopped", payload, generation);
        case "aborted":
          return mapping("interrupted", payload, generation);
        case "error":
          return mapping("turn_failed", payload, {
            ...generation,
            message: text(payload.error_message) ?? text(payload.error) ?? "error",
          });
        default:
          return null;
      }
    case "sessionEnd":
      return mapping("session_end", payload, { ...generation, reason: text(payload.reason) });
    default:
      return null;
  }
};

/**
 * Muse Code. Claude Code's event names and payload fields, so claude's
 * mappings, from either of its two hook routes: a Claude-format plugin, or
 * Muse-format entries under `hooks` in its settings, the only route that
 * delivers `Interrupt` (with `turn_id`, like codex's).
 *
 * Its hooks run with a cleared environment (no `$TMUX`, none of mu's variables), which is
 * why placement walks the process chain and identity reads mu's anchor.
 *
 * `transcript_path` is null on every Muse payload, so codex's title-session
 * rule must not apply here. `SubagentStop` is a subagent's turn (Muse fires one
 * for its built-in reminder subagents after most turns), not the pane's.
 * `StopFailure` is mapped in claude's shape, unrecorded for Muse.
 *
 * `Interrupt` must be declared async, so it can land after the `Stop` of the
 * turn it names, even after the next prompt (Muse sent one after a `Stop` on
 * quitting). `turn_id` is carried as the generation on `Stop` and `Interrupt`,
 * so the store ignores an interrupt of a turn that already stopped instead of
 * idling the turn running now. A `Stop` that a Stop hook's block continued
 * names the same turn again, and only refreshes its text. `StopFailure` carries
 * none: cursor-agent's rule that an interrupt after a failure is the failure's
 * echo must not clear a Muse error.
 */
const muse: HookRow = (payload) => {
  const generation = { generation_id: text(payload.turn_id) };
  switch (payload.hook_event_name) {
    case "SessionStart":
      return mapping("session_start", payload, { source: text(payload.source) });
    case "UserPromptSubmit":
      return mapping("prompt_submitted", payload, generation);
    case "PermissionRequest":
      return mapping("permission_requested", payload, { message: permissionMessage(payload) });
    case "Stop":
      return { ...stopped(payload), ...generation };
    case "StopFailure":
      return mapping("turn_failed", payload, { message: failureMessage(payload) });
    case "Interrupt":
      return mapping("interrupted", payload, generation);
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
  "cursor-agent": cursorAgent,
  muse,
});

export function hasHookRow(name: string): name is Harness {
  return Object.hasOwn(HOOK_ROWS, name);
}

/** One payload through its harness's row: the event to write, or null to write nothing. */
export function mapHookPayload(harness: Harness, payload: HookPayload): HookMapping | null {
  const row = HOOK_ROWS[harness];
  return row ? row(payload) : null;
}
