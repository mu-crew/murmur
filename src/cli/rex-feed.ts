import type { Command } from "commander";
import { ssh } from "../channel.js";
import { COLLECT_FLOOR_MS } from "../collector.js";
import { statusWithCollect } from "../status.js";
import { openStore } from "../store.js";
import { requireIdentity } from "./identity-guard.js";

/** How often the local store is re-read. Peers are fetched on the collect floor. */
const TICK_MS = 2_000;

/**
 * `murmur rex-feed`: report the fleet as OSC 7501 program status records in
 * this pane, for a terminal (Rex) that marks a tab from them. Runs until
 * interrupted, and clears every record it set on the way out.
 *
 * The status pill's job, in Rex's words. Kept to the pill's rule (see
 * `program-status.ts`) so the two cannot disagree about who needs you.
 */
export function registerRexFeed(program: Command): void {
  program
    .command("rex-feed")
    .description("Report agents that need you as terminal program status (OSC 7501), until stopped")
    .action(async () => {
      const identity = requireIdentity();
      if (!identity) return;
      // Loaded here, as dash and pick are: every command pays for what the
      // CLI imports statically, and the status-bar tick runs one.
      const { diffRecords, fleetRecords, formatClear } = await import("../program-status.js");
      const store = openStore();
      let sent = new Map<string | null, string>();
      let stopping = false;
      const write = (s: string) => process.stdout.write(s);
      const stop = () => {
        if (stopping) return;
        stopping = true;
        for (const id of sent.keys()) if (id !== null) write(formatClear(id));
        write(formatClear(null));
        store.close();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      process.on("SIGHUP", stop);
      process.stdout.write(
        "murmur rex-feed: reporting agents that need you on this tab. Ctrl-C stops.\n",
      );
      while (!stopping) {
        const view = await statusWithCollect(store, identity, Date.now(), ssh, {
          floorMs: COLLECT_FLOOR_MS,
        });
        const { writes, now } = diffRecords(sent, fleetRecords(view));
        for (const w of writes) write(w);
        sent = now;
        await new Promise((resolve) => setTimeout(resolve, TICK_MS));
      }
    });
}
