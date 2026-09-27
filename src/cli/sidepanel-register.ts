import type { Command } from "commander";
import type { SidepanelResult } from "../sidepanel-controller.js";

type Toggle = (command: string[], env: NodeJS.ProcessEnv) => SidepanelResult;

export function runSidepanelToggle(
  command: string[] = [process.execPath, process.argv[1] ?? "murmur", "_sidepanel-run"],
  toggle: Toggle,
  env: NodeJS.ProcessEnv = process.env,
  writeError: (message: string) => unknown = process.stderr.write.bind(process.stderr),
): void {
  const result = toggle(command, env);
  if (result.ok) return;
  writeError(`${result.message}\n`);
  process.exitCode = 1;
}

export function registerSidepanel(program: Command): void {
  program
    .command("sidepanel")
    .description("Toggle the agent side panel in this tmux window")
    .action(async () => {
      const { toggleSidepanel } = await import("../sidepanel-controller.js");
      runSidepanelToggle(
        [process.execPath, process.argv[1] ?? "murmur", "_sidepanel-run"],
        toggleSidepanel,
      );
    });

  program.command("_sidepanel-run", { hidden: true }).action(async () => {
    process.env.NODE_ENV ??= "production";
    const { runSidepanelRenderer } = await import("./sidepanel.js");
    await runSidepanelRenderer();
  });
}
