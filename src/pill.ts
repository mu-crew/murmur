/**
 * The status pill's counts: `@murmur_count_<state>` (and `@murmur_count_crew`)
 * as global options on every local tmux server, so a status format can branch
 * on them with no `#(...)` process per redraw.
 *
 * The ONLY tmux options murmur still writes. Pane, window and session state is
 * the multiplexer's own from 3.0 (`#{pane_program_state}`,
 * `#{window_program_state}`, `#{session_program_state}`); the counts stay
 * murmur's because only murmur folds crew and human agents the way the pill
 * reads them (`statusRollup`). Local only: remote peers still need
 * `murmur status`.
 */
import { type LocalRead, PANE_FIELDS, PILL_FIELDS, PILL_WORDS } from "./local.js";
import type { Mux } from "./mux.js";
import { emptyCounts, paneDriver, RENDER_PRIORITY, renderState, statusRollup } from "./view.js";

/** The pill's value per word for these panes: unset (`""`) at zero, so a format can test presence. */
export function pillValues(panes: LocalRead["panes"]): Record<(typeof PILL_WORDS)[number], string> {
  const human = emptyCounts();
  const crew = emptyCounts();
  for (const pane of panes) {
    const target = paneDriver(pane) === "human" ? human : crew;
    target[
      renderState({
        activity: pane.agent?.activity ?? null,
        attention: pane.attention,
        pending: pane.agent?.pending ?? null,
      })
    ] += 1;
  }
  const { totals, crew: crewTotal } = statusRollup(human, crew);
  const values = { crew: crewTotal > 0 ? String(crewTotal) : "" } as Record<
    (typeof PILL_WORDS)[number],
    string
  >;
  for (const state of RENDER_PRIORITY) {
    values[state === "running" ? "working" : state] =
      totals[state] > 0 ? String(totals[state]) : "";
  }
  return values;
}

/**
 * Write the pill to every tmux server the read reached, and only where it
 * changed: the current values came back in the same `list-panes`.
 */
export function publishCounts(mux: Mux, local: LocalRead): void {
  const values = pillValues(local.panes);
  for (const read of local.tmux) {
    const first = read.rows[0];
    if (read.panes === null || first === undefined) continue;
    const current = first.slice(PANE_FIELDS.length, PANE_FIELDS.length + PILL_FIELDS.length);
    const commands = PILL_WORDS.flatMap((word, index) => {
      const next = values[word];
      if ((current[index] ?? "") === next) return [];
      return [
        next === ""
          ? ["set-option", "-gqu", `@murmur_count_${word}`]
          : ["set-option", "-gq", `@murmur_count_${word}`, next],
      ];
    });
    if (commands.length > 0) mux.run(commands, read.server);
  }
}
