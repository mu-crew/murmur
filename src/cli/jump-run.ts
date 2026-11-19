import { reportJumpFailure, runJump, spawnFzf } from "../jump-select.js";
import { openStore } from "../store.js";
import { requireIdentity } from "./identity-guard.js";

/** Every failure, a corrupt identity or store included, is one line and exit 1. */
export function runJumpCommand(target: string): void {
  try {
    const identity = requireIdentity();
    if (!identity) {
      process.exitCode = 1;
      return;
    }
    const store = openStore();
    try {
      runJump(store, identity, target, { fzf: spawnFzf });
    } finally {
      store.close();
    }
  } catch (error) {
    reportJumpFailure(`murmur: ${error instanceof Error ? error.message : String(error)}`);
  }
}
