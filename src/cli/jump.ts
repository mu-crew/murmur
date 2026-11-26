import type { Command } from "commander";

/**
 * `murmur jump <target>`: jump to the agent a `status --json` pane's
 * `jump_target` names. The action loads lazily, like `dash`.
 */
export function registerJump(program: Command): void {
  program
    .command("jump")
    .description("Jump to an agent by the jump_target from `status --json`")
    .argument("<target>", "opaque panes[].jump_target token")
    .option("--client <client>", "tmux client to move (switch-client -c)")
    .option("--json", "print one JSON object for success or failure")
    .action(async (target: string, options: { client?: string; json?: boolean }) => {
      const { runJumpCommand } = await import("./jump-run.js");
      await runJumpCommand(target, options);
    });
}
