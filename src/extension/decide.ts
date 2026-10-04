import { type AgentRuntime, type Driver, EFFORTS } from "../types.js";

/**
 * pi's three events, in the order verified at runtime against pi 0.84.3 (not
 * read off the .d.ts):
 *
 *   agent_start    a run begins          -> activity: running
 *   agent_end      that run's loop ended -> activity: stopped
 *   agent_settled  nothing will follow   -> may raise attention
 *
 * start/end always pair and can repeat within one settle, because pi re-enters
 * the loop for a retry, a compaction, or a queued message (observed: start,
 * end, start, end, settled). settled arrives once, last. Per-turn events are
 * `turn_start`/`turn_end`, not these.
 *
 * Activity and attention are independent: start/end only write activity,
 * settled only raises attention, and nothing reconciles the two.
 *
 * Only an unfocused human pane gets attention on settle. A focused pane has
 * nothing to request -- the user is looking at it. An orchestrated one is mu's
 * to consume, and raising attention there would put every finishing worker in
 * the status bar and unhide its picker row.
 *
 * Nor does a settle with background work outstanding. An agent that fans out
 * mu delegates ends its turn to wait for them, and each answer arrives as a
 * follow-up that re-runs it -- so the settle after the LAST answer is the real
 * `done`, and the earlier ones would be a false "look here".
 */

/**
 * Whether `agent_settled` raises attention. Null means say nothing.
 *
 * An owner can report that it finished (`done`) or that its last turn failed
 * (`error`); only an external notifier can report `blocked`.
 *
 * `error` overrides the crew and pending gates, because nobody else will say
 * it: a supervisor sees a stopped worker, not a provider failure, and a parent
 * whose own run failed is not about to be re-run by its delegates. A focused
 * pane still says nothing -- the error is on the screen being looked at.
 */
export function settledState(
  focused: boolean,
  muManaged: boolean,
  pending = 0,
  errored = false,
): "done" | "error" | null {
  if (focused) return null;
  if (errored) return "error";
  if (muManaged || pending > 0) return null;
  return "done";
}

/**
 * The failure a settled run ended on, or null when its last assistant message
 * did not fail.
 *
 * `aborted` is not a failure: a human pressed escape and is looking at the pane.
 * pi retries a failed request itself, and a retry that succeeds is a later
 * assistant message, so only the LAST one decides.
 */
export function turnError(message: RuntimeMessage | undefined): string | null {
  if (message?.role !== "assistant" || message.stopReason !== "error") return null;
  return message.errorMessage?.trim() || "error";
}

/**
 * The in-process channel other extensions report outstanding background work
 * on, as `{ source: string, count: number }`. Per source, so two producers do
 * not overwrite each other; the agent's `pending` is the sum. mu's `mu_delegate`
 * is the first producer. Named here, not imported from mu: murmur depends on no
 * producer, and a producer depends on nothing but this string.
 */
export const PENDING_CHANNEL = "murmur:pending";

/**
 * Fold one `murmur:pending` report into the per-source counts, and return the
 * new total, or null when the payload is not a report.
 *
 * Validated, because the payload crosses an extension boundary as `unknown`:
 * a bad count must be dropped here, not reach a CHECK-constrained column and
 * cost the whole runtime write.
 */
export function foldPending(counts: Map<string, number>, data: unknown): number | null {
  if (typeof data !== "object" || data === null) return null;
  const { source, count } = data as { source?: unknown; count?: unknown };
  if (typeof source !== "string" || !source) return null;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return null;
  if (count === 0) counts.delete(source);
  else counts.set(source, count);
  let total = 0;
  for (const n of counts.values()) total += n;
  return total;
}

export function driverFromEnv(env: NodeJS.ProcessEnv): Driver {
  return env.MU_MANAGED_AGENT === "1" || env.MU_AGENT_NAME ? "orchestrated" : "human";
}

/**
 * pi's thinking levels, as murmur's `Effort` values.
 *
 * From murmur's own `EFFORTS` tuple rather than an import from pi: murmur must
 * not depend on pi to build, which is the same reason `ExtensionAPI` is declared
 * instead of imported. The cost is that a level pi adds later is unknown here --
 * and dropping it is correct, because `effort` is CHECK-constrained in the
 * schema and `member()`-validated on the wire, so an unrecognised value would
 * fail the WHOLE document for every peer collecting this node. Dropped at the
 * source, the blast radius is one field.
 */
const KNOWN_EFFORTS = new Set<string>(EFFORTS);

/** The subset of pi's ExtensionContext this file reads. All optional. */
export type RuntimeContext = {
  model?: { id: string; provider: string } | undefined;
  thinkingLevel?: string | undefined;
  getContextUsage?:
    | (() => { tokens: number | null; contextWindow: number; percent: number | null } | undefined)
    | undefined;
};

/** The subset of pi's AssistantMessage this file reads. All optional. */
export type RuntimeMessage = {
  role?: string | undefined;
  stopReason?: string | undefined;
  errorMessage?: string | undefined;
  usage?:
    | {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        cacheWrite1h?: number | undefined;
        reasoning?: number | undefined;
        totalTokens: number;
        cost: {
          input: number;
          output: number;
          cacheRead: number;
          cacheWrite: number;
          total: number;
        };
      }
    | undefined;
  providerThinkingLevel?: string | undefined;
};

/**
 * What the agent is running with, read from pi's live context.
 *
 * Only the fields pi actually offered are PRESENT in the result, which is what
 * `setRuntime`'s partial write depends on: an absent key leaves the stored value
 * alone, and an explicit null overwrites it. The distinction is load-bearing --
 * pi reports `percent: null` after every compaction, and the card must lose the
 * stale percentage rather than keep showing one from before the context was
 * cleared.
 *
 * Never infers, never derives a field from a sibling, and never reads the pane.
 * The pane scraper is a display-time fallback for one selected card; state that
 * crosses the wire comes from the owner or not at all.
 */
export function runtimeFromContext(ctx: RuntimeContext | undefined): Partial<AgentRuntime> {
  const runtime: Partial<AgentRuntime> = {};
  // Absent, not merely empty. pi passes a ctx to every handler, but this file
  // DECLARES that API rather than importing it -- and anything that invokes a
  // handler directly is under no obligation to supply one. murmur's own
  // out-of-process test rig calls `agent_start()` with no arguments, and an
  // unguarded read here crashed the pi process: an extension fault reaching the
  // host is the one outcome this whole file is arranged to prevent.
  if (!ctx) return runtime;
  if (ctx.model) {
    // The id carries its own vendor prefix when a ROUTING provider is in play:
    // verified live, `ctx.model.id` is `anthropic/claude-opus-5` while
    // `ctx.model.provider` is `modelbridge` -- the router, not the vendor.
    //
    // Split, and prefer the id's prefix. The card wants the leaf, which is what
    // the reader recognises and what the scraped footer showed. The vendor is
    // kept rather than dropped, because it is the more useful of the two
    // providers and without it `anthropic/claude-opus-5` and another vendor's
    // `claude-opus-5` would be indistinguishable.
    const cut = ctx.model.id.lastIndexOf("/");
    runtime.model = cut === -1 ? ctx.model.id : ctx.model.id.slice(cut + 1);
    runtime.provider = cut === -1 ? ctx.model.provider : ctx.model.id.slice(0, cut);
  }
  if (ctx.thinkingLevel !== undefined && KNOWN_EFFORTS.has(ctx.thinkingLevel)) {
    runtime.effort = ctx.thinkingLevel as AgentRuntime["effort"];
  }
  if (ctx.getContextUsage) {
    try {
      const usage = ctx.getContextUsage();
      if (usage) {
        runtime.context_pct = usage.percent;
        runtime.context_tokens = usage.tokens;
        runtime.context_window = usage.contextWindow;
      }
    } catch {
      // A live read inside someone else's process. Losing the context fields is
      // survivable; losing a model that WAS read successfully is not, so this
      // catches narrowly rather than abandoning the whole report.
    }
  }
  return runtime;
}

/**
 * Tokens, money and the provider's applied effort, from one completed turn.
 *
 * pi's names are camelCase with nested cost; murmur's are snake_case and flat
 * within the bundle. One mapping in one place, so no handler has to know both
 * vocabularies.
 *
 * Returns nothing when the message carries no usage. Not every assistant
 * message does -- an aborted or errored turn may not -- and reporting a bundle
 * of zeroes would claim a turn that cost nothing.
 */
/**
 * Whether a `message_end` message is a completed turn whose usage is worth
 * reporting.
 *
 * pi fires `message_end` for every role, so anything but an assistant is not a
 * turn. An aborted or errored assistant is skipped too, as pi's own
 * `getAssistantUsage` does: its usage is partial at best, and pi's run-failure
 * path synthesises an all-zero bundle. Reporting that would overwrite the last
 * real figures with a claim that the turn cost nothing.
 */
export function isReportableTurn(message: RuntimeMessage | undefined): boolean {
  return (
    message?.role === "assistant" &&
    message.stopReason !== "aborted" &&
    message.stopReason !== "error"
  );
}

export function usageFromMessage(message: RuntimeMessage | undefined): Partial<AgentRuntime> {
  const out: Partial<AgentRuntime> = {};
  // Same reason as `runtimeFromContext`: a direct caller owes this nothing.
  if (!message) return out;
  // Present only when reported: this is the effort the provider ACTUALLY
  // applied, which can differ from the requested level when a model clamps it.
  // Absent means nothing was learned, so nothing should be overwritten.
  if (message.providerThinkingLevel !== undefined) {
    out.provider_effort = message.providerThinkingLevel;
  }
  const usage = message.usage;
  if (!usage) return out;
  out.usage = {
    input: usage.input,
    output: usage.output,
    cache_read: usage.cacheRead,
    cache_write: usage.cacheWrite,
    total_tokens: usage.totalTokens,
    // pi's `undefined` becomes an explicit null: the wire requires both keys,
    // and "the provider said nothing" is a different claim from zero.
    cache_write_1h: usage.cacheWrite1h ?? null,
    reasoning: usage.reasoning ?? null,
    cost_input: usage.cost.input,
    cost_output: usage.cost.output,
    cost_cache_read: usage.cost.cacheRead,
    cost_cache_write: usage.cost.cacheWrite,
    cost_total: usage.cost.total,
  };
  return out;
}
