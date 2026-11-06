import { capLastText, type InboxEvent } from "./inbox-event.js";
import type { Activity, AttentionKind } from "./types.js";

/**
 * The event vocabulary's effect on one agent's turn, as a pure step.
 *
 * Two places apply inbox events: the store's drain, for a pane of this node's
 * tmux, and the remote area's fold (`src/remote.ts`), for a worker whose pane
 * is on another node. Both take their transitions from here, so a remote
 * worker's state cannot drift from a local one's. Ownership -- who may claim,
 * which session an event must name -- stays with each caller, because a pane
 * and a remote key have different owners to check.
 *
 * ARCHITECTURE.md § The inbox gives each event's effect in prose.
 */

/** How a turn that carried a `generation_id` ended. */
export const GENERATION_ENDS = ["stopped", "interrupted", "failed"] as const;

export type GenerationEnd = (typeof GENERATION_ENDS)[number];

export type TurnState = {
  activity: Activity;
  session_id: string | null;
  run_count: number;
  last_text: string | null;
  /**
   * The run whose turn wrote `last_text`: the `run_count` its `turn_stopped`
   * was applied at, or for a named turn's late text the run that turn ended
   * in. Null when no turn of this session has written it. A turn that ends
   * with no text (an interrupt, a failure, an unnamed stop without text)
   * leaves both as they were, so a reader can tell the previous turn's text
   * from its own. A named turn's stop without text writes a null text at its
   * own run, until its text arrives.
   */
  last_text_run: number | null;
  /** False while the activity is mu's word (an interrupt it sent) and no harness event confirmed it. */
  confirmed: boolean;
  /**
   * The last ended turn's generation, and how it ended. Only cursor-agent and
   * Muse name their turns, and only their events set these: a second end of
   * the same generation is that turn's echo, not a new turn.
   */
  generation_id: string | null;
  generation_end: GenerationEnd | null;
  /** The run that generation ended in, for its late text's `last_text_run`. */
  generation_run: number | null;
};

export type TurnEvent = Pick<
  InboxEvent,
  "event" | "by" | "session_id" | "source" | "reason" | "message" | "text" | "generation_id"
>;

/** Attention an event raises. `settled` leaves `done` to the settle rule, which knows focus and driver. */
export type TurnRaise = { kind: "blocked" | "error"; message: string } | { kind: "settled" };

export type TurnStep =
  /** The event changes nothing: refused, not applied. */
  | { kind: "ignore" }
  | {
      kind: "apply";
      /** The turn's new state, or null to leave the row exactly as it is. */
      next: TurnState | null;
      /** Release the claim: the row goes, its attention stays. */
      release: boolean;
      /** Attention kinds this event clears, before anything is raised. */
      clear: AttentionKind[];
      raise: TurnRaise | null;
    };

/** A fresh claim's turn: idle, nothing run, nothing said. */
export function initialTurn(session_id: string | null): TurnState {
  return {
    activity: "stopped",
    session_id,
    run_count: 0,
    last_text: null,
    last_text_run: null,
    confirmed: true,
    generation_id: null,
    generation_end: null,
    generation_run: null,
  };
}

const IGNORE: TurnStep = { kind: "ignore" };

/**
 * One event's step from `state`.
 *
 * `blocked` lasts until the next event: the dialog it reported is answered or
 * gone once the harness says anything else. A generation's echo is the one
 * exception, since it is not the harness saying anything new.
 */
export function stepTurn(state: TurnState, event: TurnEvent): TurnStep {
  const generation = event.generation_id;
  // An event about a turn that has already ended: cursor-agent's late text,
  // its `stop` after the text, the `error` stop that follows an abort, or
  // Muse's late `Interrupt`.
  const ended =
    generation !== null && generation === state.generation_id && state.generation_end !== null;
  if (ended && event.event === "turn_stopped") {
    if (event.text === null) return IGNORE;
    return {
      kind: "apply",
      next: {
        ...state,
        last_text: capLastText(event.text),
        last_text_run: state.generation_run ?? state.run_count,
      },
      release: false,
      clear: [],
      raise: null,
    };
  }
  if (ended && event.event === "turn_failed" && state.generation_end === "interrupted") {
    return IGNORE;
  }
  // Muse's async Interrupt after its turn's Stop, maybe during the next turn,
  // or an interrupt repeated: the turn it names is over. After a failure it is
  // cursor-agent's abort, applied below.
  if (ended && event.event === "interrupted" && state.generation_end !== "failed") {
    return IGNORE;
  }

  const clear: AttentionKind[] = event.event === "permission_requested" ? [] : ["blocked"];
  const next: TurnState = {
    ...state,
    session_id: state.session_id ?? event.session_id,
    confirmed: true,
  };
  let raise: TurnRaise | null = null;
  const end = (how: GenerationEnd): void => {
    if (generation === null) return;
    next.generation_id = generation;
    next.generation_end = how;
    next.generation_run = next.run_count;
  };

  switch (event.event) {
    case "session_start":
      // `compact` is the same session carrying on: no state change at all.
      if (event.source === "compact") {
        return { kind: "apply", next: null, release: false, clear, raise: null };
      }
      next.activity = "stopped";
      next.session_id = event.session_id ?? state.session_id;
      if (event.source !== "resume") {
        // startup, clear, or a source this build does not know: a new session.
        next.run_count = 0;
        next.last_text = null;
        next.last_text_run = null;
        next.generation_id = null;
        next.generation_end = null;
        next.generation_run = null;
      }
      break;
    case "prompt_submitted":
      next.activity = "running";
      next.run_count += 1;
      // A new prompt answers the last turn's outcome, a failure as much as a
      // finish: the error it leaves would otherwise outlive every later turn.
      clear.push("done", "error");
      break;
    case "continued":
      next.activity = "running";
      break;
    case "permission_requested":
      raise = { kind: "blocked", message: event.message ?? "" };
      break;
    case "interrupted":
      next.activity = "stopped";
      // From the harness, an interrupt is a fact; from mu it is a request the
      // next harness event confirms or replaces (`idle?`).
      next.confirmed = event.by !== "mu";
      // The abort's own error stop, if it was applied first, was its echo.
      if (ended && state.generation_end === "failed") clear.push("error");
      end("interrupted");
      break;
    case "turn_stopped":
      next.activity = "stopped";
      if (generation !== null) {
        // A named turn's text may still be on its way (cursor-agent sends it
        // separately): no text yet is no text, never the previous turn's.
        next.last_text = event.text === null ? null : capLastText(event.text);
        next.last_text_run = next.run_count;
        end("stopped");
      } else if (event.text !== null) {
        next.last_text = capLastText(event.text);
        next.last_text_run = next.run_count;
      }
      raise = { kind: "settled" };
      break;
    case "turn_failed":
      // The turn is over; a failure is not something it is still doing.
      next.activity = "stopped";
      raise = { kind: "error", message: event.message ?? "" };
      end("failed");
      break;
    case "session_end":
      // `/clear` ends one session and starts the next in the same process.
      return { kind: "apply", next: null, release: event.reason !== "clear", clear, raise: null };
  }
  return { kind: "apply", next, release: false, clear, raise };
}
