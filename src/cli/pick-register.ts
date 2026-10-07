import type { Command } from "commander";

/**
 * Register `murmur pick` WITHOUT loading the picker module.
 *
 * Same reasoning as `dash-register.ts`. `pick.ts` reaches `paint.ts`, which
 * measures cells with `string-width`, and that library builds its Unicode
 * regexes at load. A static import here put that cost on every `murmur`
 * invocation, including `status --json`, which a status-line poller runs
 * every few seconds. Measured: `murmur status` 103ms -> 82ms and
 * `murmur --version` 80ms -> 54ms once the width code left the static graph.
 *
 * The surface (name, description, options) stays here so `murmur pick --help`
 * and arg-parse errors work without the import; only the action waits for it.
 */
export function registerPick(program: Command): void {
  program
    .command("pick")
    .description("Pick an agent and jump to it")
    .option("--all", "include orchestrated agents")
    .option("--rows", "print picker rows only (internal, for the crew toggle's reload)")
    .action(async (options: { all?: boolean; rows?: boolean }) => {
      const { runPickCommand } = await import("./pick.js");
      await runPickCommand(options);
    });
}
