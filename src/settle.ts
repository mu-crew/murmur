/**
 * The settle rule, shared by pi's extension (`agent_settled`) and the inbox
 * drain (a hook harness's `turn_stopped`), so the two cannot disagree about when
 * a finished turn asks for a human.
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
