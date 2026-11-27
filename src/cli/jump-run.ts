import { type JumpOptions, reportJumpFailure, runJump, spawnFzf } from "../jump-select.js";
import { openStore } from "../store.js";
import { requireIdentity } from "./identity-guard.js";

/** Every failure, a corrupt identity or store included, is one line and exit 1. */
export async function runJumpCommand(target: string, options: JumpOptions = {}): Promise<void> {
  try {
    const identity = requireIdentity(options);
    if (!identity) return;
    const store = openStore();
    try {
      await runJump(store, identity, target, { fzf: spawnFzf }, options);
    } finally {
      store.close();
    }
  } catch (error) {
    const message = `murmur: ${error instanceof Error ? error.message : String(error)}`;
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, reason: "error", message })}\n`);
      process.exitCode = 1;
    } else reportJumpFailure(message);
  }
}
