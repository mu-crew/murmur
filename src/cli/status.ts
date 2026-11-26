import type { Command } from "commander";
import { ssh } from "../channel.js";
import { COLLECT_FLOOR_MS } from "../collector.js";
import { localStatus, statusJson, statusWithCollect, tmuxStatus } from "../status.js";
import { openStore } from "../store.js";
import { requireIdentity } from "./identity-guard.js";

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Show current agent status")
    .option("--json", "print JSON")
    .option(
      "--cached",
      "read this node's panes and the cached peers; never reach a peer (a caller refreshes with `collect`)",
    )
    .action(async (options: { json?: boolean; cached?: boolean }) => {
      const identity = requireIdentity();
      if (!identity) return;
      const store = openStore();
      try {
        // The one surface that passes a floor. A status-line poller re-runs
        // this on a timer -- possibly per attached client -- and a repaint is
        // not a reason to reach a machine.
        //
        // `--cached` skips even that: a picker must open in ~50ms, and a due
        // peer costs a real ssh fetch of up to 4s that is only recorded once it
        // settles, so a caller that gives up early pays again on every open.
        const view = options.cached
          ? // No warm-socket probe either: `ssh -O check` is an ssh exec. So
            // `needs_session` here means "last attempt was refused on auth" and
            // may stay true while a warm socket exists; `murmur jump` re-probes.
            await localStatus(store, identity, Date.now(), { cached: true })
          : await statusWithCollect(store, identity, Date.now(), ssh, {
              floorMs: COLLECT_FLOOR_MS,
            });
        process.stdout.write(
          options.json ? `${JSON.stringify(statusJson(view), null, 2)}\n` : tmuxStatus(view),
        );
      } finally {
        store.close();
      }
    });
}
