import { runJump, spawnFzf } from "../jump-select.js";
import { openStore } from "../store.js";
import { requireIdentity } from "./identity-guard.js";

export function runJumpCommand(target: string): void {
  const identity = requireIdentity();
  if (!identity) return;
  const store = openStore();
  try {
    runJump(store, identity, target, { fzf: spawnFzf });
  } finally {
    store.close();
  }
}
