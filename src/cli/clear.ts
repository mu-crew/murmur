import type { Command } from "commander";
import { publishAgentStates } from "../agent-state.js";
import { asPaneId } from "../ids.js";
import { type Mux, tmux } from "../mux.js";
import { openStore, type Store } from "../store.js";

/**
 * Acknowledge every attention request on one pane, then republish its window.
 *
 * The whole write path. Nothing here must refuse to clear anything, because
 * attention is all focus can address: `acknowledgePane` is one `DELETE FROM
 * attention WHERE pane = ?` and cannot touch an agent's activity, identity or
 * owner metadata, so a focus hook has nothing to overwrite a running agent with.
 *
 * Best effort, silent and total: this runs inside the tmux server.
 */
export function clearPane(raw: string, mux: Mux = tmux): void {
  let store: Store | undefined;
  try {
    if (!raw) return;
    // argv is the boundary: the pane id arrives as a bare string from the hook.
    const pane = asPaneId(raw);
    // The badge is a tmux option, not murmur state, so resolving it needs no
    // murmur knowledge -- and a pane murmur has never seen can still carry an
    // orphan badge nothing else will clear.
    const current = mux.currentWindow();
    const server = current?.server ?? ({ kind: "default" } as const);
    const window = current?.pane === pane ? current.window : mux.windowForPane(pane, server);
    const location = current?.pane === pane ? current : window ? { server, pane } : null;

    try {
      store = openStore();
      if (location) store.acknowledgePane(location);
    } catch {
      // No database, or an unwritable one. Nothing was read, so there is no
      // evidence the request was satisfied -- and clearing on no evidence is the
      // one direction that loses information.
    }

    // Both guards, for the same reason, stated at the top of this file: keep the
    // badge when tmux OR the store cannot answer.
    //
    // The store guard used to be a ternary passing `null`, which erased the
    // badge without murmur ever reading the attention it reported -- the exact
    // opposite of the rule. A locked or transiently unwritable state.db plus one
    // focus event wiped the crashed/blocked glyph off a window whose attention
    // row was still in the database, and nothing repaints it until the agent's
    // next event. For a crashed agent that is never.
    //
    // A pane murmur has never seen still clears, because there `openStore`
    // succeeds and the projection finds no local state for it.
    if (!window || !store) return;
    // Pane and window states are derived projections, so they are recomputed
    // after the delete: blindly clearing them made a live running agent display
    // as idle though its agent row was untouched.
    try {
      publishAgentStates(window, mux, store, server);
    } catch {
      // Unreadable projection: leave the badge. Stale is recoverable, erasing a
      // real signal is not.
    }
  } catch {
    // Focus hooks run inside the tmux server: they must always be silent and
    // total.
  } finally {
    try {
      store?.close();
    } catch {
      // Silent and total.
    }
  }
}

export function registerClear(program: Command): void {
  program
    .command("clear")
    .description("Acknowledge attention for a pane")
    .option("--pane <pane-id>", "focused tmux pane id")
    .action((options: { pane?: string }) => clearPane(options.pane ?? ""));
}
