import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, expect, test } from "vitest";
import { registerSidepanel, runSidepanelToggle } from "../src/cli/sidepanel-register.js";

const originalExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = originalExitCode;
});

test("registers the public toggle and private renderer commands", () => {
  const program = new Command();
  registerSidepanel(program);

  expect(program.commands.find((command) => command.name() === "sidepanel")?.description()).toBe(
    "Toggle the agent side panel in this tmux window",
  );
  expect(program.commands.map((command) => command.name())).toContain("_sidepanel-run");
  expect(program.helpInformation()).not.toContain("_sidepanel-run");
});

test("the toggle keeps renderer argv separated", () => {
  const calls: string[][] = [];
  const errors: string[] = [];

  runSidepanelToggle(
    ["/path with spaces/node", "/path with spaces/murmur", "_sidepanel-run"],
    (command) => {
      calls.push(command);
      return { ok: true };
    },
    {},
    (message) => errors.push(message),
  );

  expect(calls).toEqual([["/path with spaces/node", "/path with spaces/murmur", "_sidepanel-run"]]);
  expect(errors).toEqual([]);
});

test("the toggle reports controller failures", () => {
  const errors: string[] = [];
  runSidepanelToggle(
    ["node", "murmur", "_sidepanel-run"],
    () => ({ ok: false, message: "not in tmux" }),
    {},
    (message) => errors.push(message),
  );

  expect(errors).toEqual(["not in tmux\n"]);
  expect(process.exitCode).toBe(1);
});

test("declaring all CLI commands leaves ink unloaded", () => {
  const repo = new URL("..", import.meta.url).pathname;
  const dir = mkdtempSync(join(repo, ".murmur-sidepanel-ink-probe-"));
  const probe = join(dir, "probe.mts");
  writeFileSync(
    probe,
    [
      `import { registerSidepanel } from ${JSON.stringify(join(repo, "src/cli/sidepanel-register.ts"))};`,
      'import { Command } from "commander";',
      "registerSidepanel(new Command());",
      String.raw`const inkLoaded = process.moduleLoadList.some((entry) => /node_modules\/(\.pnpm\/)?ink[@\/]/.test(entry));`,
      "console.log(JSON.stringify({ inkLoaded, total: process.moduleLoadList.length }));",
    ].join("\n"),
  );
  try {
    const output = execFileSync(process.execPath, ["--experimental-strip-types", probe], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = JSON.parse(output.trim().split("\n").at(-1) ?? "{}");
    expect(result.total).toBeGreaterThan(50);
    expect(result.inkLoaded).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
