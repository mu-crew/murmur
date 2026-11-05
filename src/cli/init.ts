import type { Command } from "commander";
import {
  HOOK_HARNESSES,
  type HookHarness,
  type HookInstallResult,
  installHooks,
  isHookHarness,
} from "../hook-install.js";
import { createIdentity, loadIdentity, type NodeIdentity, setDisplayName } from "../identity.js";

/**
 * `--hooks`'s value: harness names, comma-separated, or `all`. An unknown name
 * is an error rather than ignored, so a typo cannot read as "done".
 */
export function parseHookList(value: string): HookHarness[] | string {
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  // Every name is checked before `all` expands, so `all,claud` is still a typo.
  if (names.length === 0 || !names.every((name) => name === "all" || isHookHarness(name))) {
    return `--hooks takes ${HOOK_HARNESSES.join(", ")} or all, comma-separated; got ${JSON.stringify(value)}`;
  }
  return names.includes("all") ? [...HOOK_HARNESSES] : names.filter(isHookHarness);
}

/** One line per harness, saying what `init` did to its config file. */
export function describeInstall(result: HookInstallResult): string {
  const head = `hooks ${result.harness}:`;
  switch (result.state) {
    case "skipped":
      return `${head} not set up here (no ${result.path}); --hooks ${result.harness} writes it`;
    case "unchanged":
      return `${head} up to date in ${result.path}`;
    case "refused":
      return `${head} left ${result.path} untouched: ${result.error}`;
    case "written": {
      const parts = [
        result.added.length > 0 ? `added ${result.added.join(", ")}` : "",
        result.fixed.length > 0 ? `fixed ${result.fixed.join(", ")}` : "",
        result.removed.length > 0 ? `removed ${result.removed.join(", ")}` : "",
      ].filter(Boolean);
      // codex runs a new or changed hook only after the user trusts it once.
      const trust = result.harness === "codex" ? " (codex asks you to trust them once)" : "";
      return `${head} ${parts.join("; ")} in ${result.path}${trust}`;
    }
  }
}

/**
 * The warning for codex's older `notify` line, which reports a finished turn
 * a second time once murmur's hooks are in. murmur does not edit codex's TOML,
 * so the user removes it.
 */
export function describeNotifyConflict(configPath: string): string {
  return `hooks codex: ${configPath} still runs murmur from its \`notify\` line, so every finished turn is reported twice; remove that line`;
}

export function registerInit(program: Command): void {
  program
    .command("init")
    .description(
      "Initialize this node's identity, and add murmur's hook entries for each hook harness set up here",
    )
    .option("--name <name>", "display name")
    .option(
      "--hooks <harnesses>",
      `write hook entries for these even when not set up yet (${HOOK_HARNESSES.join(", ")}, all)`,
    )
    .option("--no-hooks", "leave every harness's hook config alone")
    .action((opts: { name?: string; hooks?: string | false }) => {
      // Checked before anything is written, so a mistyped flag changes nothing.
      let harnesses: HookHarness[] | undefined;
      if (typeof opts.hooks === "string") {
        const parsed = parseHookList(opts.hooks);
        if (typeof parsed === "string") {
          process.stderr.write(`murmur: ${parsed}\n`);
          process.exitCode = 1;
          return;
        }
        harnesses = parsed;
      }
      // `--name` on an already-initialised node RENAMES it, keeping the host_id.
      // It used to be ignored silently, which is the one thing a rename must not
      // do: the operator's only feedback was the old name printed back.
      const existing = loadIdentity();
      let identity: NodeIdentity;
      try {
        identity = existing
          ? opts.name
            ? setDisplayName(opts.name)
            : existing
          : createIdentity(opts.name);
      } catch (error) {
        // An empty `--name` is operator error, not a murmur fault, and the
        // writer refuses it because a nameless node is broken from every peer's
        // point of view while looking fine locally. A stack trace for a
        // mistyped flag buries the one line that says what to do -- and there
        // is no global handler, so this is the place to catch it.
        process.stderr.write(`murmur: ${error instanceof Error ? error.message : error}\n`);
        process.exitCode = 1;
        return;
      }
      console.log(`host_id: ${identity.host_id}`);
      console.log(`display_name: ${identity.display_name}`);

      if (opts.hooks === false) return;
      // Only handlers whose command starts with `murmur` are touched: mu's,
      // museum's, muzzle's and the user's own stay as they are.
      for (const result of installHooks({ harnesses })) {
        if (result.state === "refused") {
          process.stderr.write(`murmur: ${describeInstall(result)}\n`);
          process.exitCode = 1;
        } else {
          console.log(describeInstall(result));
        }
        if (result.notifyConfig !== undefined) {
          process.stderr.write(`murmur: ${describeNotifyConflict(result.notifyConfig)}\n`);
        }
      }
    });
}
