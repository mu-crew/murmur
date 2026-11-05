import { anchorLookup } from "../src/anchors.js";
import { type EventFields, type HookContext, type HookWrite, selfHookEvent } from "../src/hook.js";
import { capLastText } from "../src/inbox-event.js";
import { writeInboxEvent, writeRemoteEvent } from "../src/inbox-file.js";
import { type ProcessTable, readProcessTable } from "../src/process-chain.js";
import { type RuntimeMessage, turnError } from "./decide.js";

/**
 * pi's store-free mode (D15): with `MU_PI_CHANNEL=hooks`, mu drives this pi
 * through the `hooks` channel like any other harness, and this extension
 * reports the way their hooks do -- one event file per event, into the pane's
 * inbox -- instead of claiming the pane in murmur's store.
 *
 * It exists for a pi build that breaks the store or its native module (a Bun
 * build of pi once did). So nothing here imports the store: the event writer
 * and the process-chain walk are plain files and `ps`. It never claims, never
 * publishes pane options (the drain does), and never asks tmux anything, so the
 * pane has exactly one writer, the inbox.
 *
 * pi's events map onto the vocabulary as mu's harness table says:
 *
 *   (loaded)          session_start (`resume`: claims the pane, keeps its turn)
 *   session_start     session_start (`startup`; `clear` after `/new`, `resume` after `/reload`)
 *   input             prompt_submitted
 *   agent_start       continued: a run pi started itself (a retry, a queued follow-up)
 *   ui_prompt_start   permission_requested
 *   agent_settled     turn_stopped with the last assistant text, or turn_failed
 *   session_shutdown  session_end (kept for `/new`, `/reload`, `/resume`, `/fork`; released on quit)
 */

/** Whether this pi runs on mu's `hooks` channel. Read when the extension loads, never at module scope. */
export function inboxMode(env: NodeJS.ProcessEnv): boolean {
  return env.MU_PI_CHANNEL === "hooks";
}

/** The pi events this mode listens to. */
export type InboxModeEvent =
  | "session_start"
  | "session_shutdown"
  | "input"
  | "agent_start"
  | "message_end"
  | "ui_prompt_start"
  | "agent_settled";

/** The slice of pi's API this mode uses. Every payload is read defensively. */
export type InboxModeApi = {
  on(event: InboxModeEvent, handler: (event: unknown, ctx: unknown) => void): void;
};

export type InboxModeDeps = {
  /** Where the walk starts, the table and the environment: this process, read once. */
  context(): HookContext | null;
  write(write: HookWrite): boolean;
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** pi's session id from a handler's ctx, when this pi offers one; else its session file's name. */
export function sessionIdOf(ctx: unknown): string | null {
  try {
    const manager = record(record(ctx).sessionManager);
    const getId = manager.getSessionId;
    const id = typeof getId === "function" ? text(getId.call(manager)) : null;
    if (id) return id;
    const getFile = manager.getSessionFile;
    const file = typeof getFile === "function" ? text(getFile.call(manager)) : null;
    return file ? (file.split("/").pop() ?? file).replace(/\.jsonl$/, "") : null;
  } catch {
    return null;
  }
}

/** An assistant message's text parts, joined. Null when it said nothing. */
export function messageText(message: unknown): string | null {
  const { role, content } = record(message);
  if (role !== "assistant") return null;
  if (typeof content === "string") return text(content);
  if (!Array.isArray(content)) return null;
  const parts = content.flatMap((part) => {
    const { type, text: said } = record(part);
    return type === "text" && typeof said === "string" ? [said] : [];
  });
  return text(parts.join(""));
}

function fields(event: EventFields["event"], over: Partial<EventFields> = {}): EventFields {
  return {
    event,
    session_id: null,
    source: null,
    reason: null,
    message: null,
    text: null,
    generation_id: null,
    ...over,
  };
}

/** The live dependencies: this process, `ps` once (the chain to the tmux server does not move), and the event files. */
export function liveDeps(env: NodeJS.ProcessEnv = process.env): InboxModeDeps {
  let table: ProcessTable | null | undefined;
  return {
    context() {
      if (table === undefined) table = readProcessTable();
      if (!table) return null;
      return { table, self: process.pid, env, anchor: anchorLookup(), now: Date.now() };
    },
    write: (write) =>
      write.area === "inbox" ? writeInboxEvent(write.event) : writeRemoteEvent(write.event),
  };
}

/** Register the inbox-writing handlers. Every one is silent on failure: nothing here may reach pi. */
export function installInboxMode(pi: InboxModeApi, deps: InboxModeDeps = liveDeps()): void {
  let session: string | null = null;
  /** The last assistant message's text and failure, read at `message_end`, written at settle. */
  let lastText: string | null = null;
  let lastError: string | null = null;

  const report = (event: EventFields): void => {
    try {
      const context = deps.context();
      if (!context) return;
      const placed = selfHookEvent(
        "pi",
        { ...event, session_id: event.session_id ?? session },
        context,
      );
      if (placed) deps.write(placed);
    } catch {
      // Best effort, like every hook: a lost event costs a state, never the turn.
    }
  };

  // Claim NOW, as the in-process mode claims at load: a pi that loads its
  // extensions after its first session_start would otherwise leave mu waiting
  // for one until the first prompt. As `resume`, which claims and shows idle
  // but resets nothing: pi loads a fresh instance of this extension on every
  // runtime replacement (`/reload`, `/new`, `/resume`, `/fork`), before that
  // runtime's own session_start, so a `startup` here would zero the turn a
  // `/reload` keeps. pi's own session_start still resets when it should.
  report(fields("session_start", { source: "resume" }));

  pi.on("session_start", (event, ctx) => {
    const reason = text(record(event).reason);
    session = sessionIdOf(ctx);
    report(
      fields("session_start", {
        source: reason === "new" ? "clear" : reason === "reload" ? "resume" : "startup",
      }),
    );
  });

  pi.on("input", () => {
    lastText = null;
    lastError = null;
    report(fields("prompt_submitted"));
  });

  pi.on("agent_start", () => report(fields("continued")));

  pi.on("message_end", (event) => {
    const message = record(event).message;
    if (record(message).role !== "assistant") return;
    lastError = turnError(message as RuntimeMessage);
    const said = messageText(message);
    if (said !== null) lastText = said;
  });

  pi.on("ui_prompt_start", (event) => {
    const { title, kind } = record(event);
    report(fields("permission_requested", { message: text(title) ?? text(kind) ?? "" }));
  });

  pi.on("agent_settled", () => {
    const error = lastError;
    const said = lastText;
    lastError = null;
    lastText = null;
    report(
      error !== null
        ? fields("turn_failed", { message: error })
        : fields("turn_stopped", { text: said === null ? null : capLastText(said) }),
    );
  });

  pi.on("session_shutdown", (event) => {
    const reason = text(record(event).reason);
    // The process carries on into another session for all but a quit: the
    // claim stays, as claude's `/clear` keeps it.
    const kept = reason !== null && reason !== "quit";
    report(fields("session_end", { reason: kept ? "clear" : (reason ?? "quit") }));
  });
}
