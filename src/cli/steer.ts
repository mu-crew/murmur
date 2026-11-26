import { readFileSync } from "node:fs";
import type { Command } from "commander";

type Options = { json?: boolean };

/** `murmur prompt` and `murmur stop`: steer an agent by its `jump_target`. */
export function registerSteer(program: Command): void {
  program
    .command("prompt")
    .description("Send a prompt to an agent by the jump_target from `status --json`")
    .argument("<target>", "opaque panes[].jump_target token")
    .argument("[text]", "prompt text, or - to read it from stdin")
    .option("--json", "print one JSON receipt for success or failure")
    .action(async (target: string, text: string | undefined, options: Options) => {
      const { runSteerCommand } = await import("./steer-run.js");
      const body = text === "-" ? readFileSync(0, "utf8").replace(/\r?\n$/, "") : (text ?? "");
      await runSteerCommand("prompt", target, body, options);
    });
  program
    .command("stop")
    .description("Interrupt an agent by the jump_target from `status --json`")
    .argument("<target>", "opaque panes[].jump_target token")
    .option("--json", "print one JSON receipt for success or failure")
    .action(async (target: string, options: Options) => {
      const { runSteerCommand } = await import("./steer-run.js");
      await runSteerCommand("stop", target, "", options);
    });
}
