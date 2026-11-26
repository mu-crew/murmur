import { promptAgent, type SteerResult, stopAgent } from "../steer.js";
import { openStore } from "../store.js";
import { requireIdentity } from "./identity-guard.js";

export function printSteerResult(result: SteerResult, json: boolean | undefined): void {
  if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else if (!result.ok) process.stderr.write(`murmur: ${result.message}\n`);
  if (!result.ok) process.exitCode = 1;
}

export async function runSteerCommand(
  action: "prompt" | "stop",
  target: string,
  text: string,
  options: { json?: boolean },
): Promise<void> {
  try {
    const identity = requireIdentity();
    if (!identity) return;
    const store = openStore();
    try {
      const result =
        action === "prompt"
          ? await promptAgent(store, identity, target, text)
          : await stopAgent(store, identity, target);
      printSteerResult(result, options.json);
    } finally {
      store.close();
    }
  } catch (error) {
    printSteerResult(
      {
        ok: false,
        reason: "delivery_failed",
        message: error instanceof Error ? error.message : String(error),
      },
      options.json,
    );
  }
}
