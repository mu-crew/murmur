import type { Command } from "commander";
import { buildSnapshot, readLocal } from "../local.js";
import { tmux } from "../mux.js";
import { openStore } from "../store.js";
import { requireIdentity } from "./identity-guard.js";

export function registerExport(program: Command): void {
  program
    .command("export")
    // No options, and none to add: the document is complete, so a peer that
    // returns one has said everything it knows and absence in it is absence.
    // There is nothing narrower for a caller to ask for.
    .description("Print this node's current-state snapshot")
    .action(async () => {
      const identity = requireIdentity();
      if (!identity) return;
      const store = openStore();
      try {
        // A fresh local read, never a cache: the document is authoritative,
        // so it must describe the panes as they are now.
        const now = Date.now();
        const local = await readLocal(store, tmux, now);
        process.stdout.write(`${JSON.stringify(buildSnapshot(identity, local.panes, now))}\n`);
      } finally {
        store.close();
      }
    });
}
