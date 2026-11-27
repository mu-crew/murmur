/**
 * What a tmux pane's root process says about itself: mu's identity from its
 * environment, and which harness it is when a runtime (`node`, `bun`) hosts it.
 *
 * The fallback for a pane mu placed but did not tag (`@mu_agent` empty: mu
 * before 5.6.1 swallowed a failed tag write). mu spawns the harness as the
 * pane's root process with `MU_MANAGED_AGENT=1`, `MU_AGENT_NAME`,
 * `MU_WORKSTREAM` and, for an orchestrator, `MU_ORCHESTRATOR=1`.
 *
 * The environment carries every secret in the pane, so it is parsed here and
 * only the mu keys listed below leave this file: nothing else is kept, logged or
 * stored. Read once per pane process (`Store.paneProcess` caches it), never
 * per status tick.
 *
 * Not covered: a pane whose root is a shell that later ran the harness (the
 * env is the shell's), and Rex or remote panes (the env is ssh's).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { helperPath } from "./helper-path.js";
import { harnessName } from "./types.js";

/** The facts murmur keeps about a pane's root process. */
export type PaneProcess = {
  /** `MU_MANAGED_AGENT=1`: mu placed this process. */
  managed: boolean;
  agent_name: string | null;
  workstream: string | null;
  /** `MU_ORCHESTRATOR` set non-empty. */
  orchestrator: boolean;
  /** The harness its argv names, else null. */
  harness: string | null;
};

/** How long one `ps` may take. A pane past it gets no fallback this read. */
export const PANE_PROCESS_TIMEOUT_MS = 1_000;

/** The runtimes a harness runs under, as tmux names a pane's command. */
export const HARNESS_HOSTS: ReadonlySet<string> = new Set(["node", "bun"]);

/**
 * npm package directories that are a harness whose script name is not:
 * `.../@anthropic-ai/claude-code/cli.js`, `.../pi_cli/dist/bundle/cli.js`.
 */
const HARNESS_PACKAGES: Readonly<Record<string, string>> = {
  "claude-code": "claude",
  "pi-coding-agent": "pi",
  pi_cli: "pi",
};

/**
 * The harness an argv runs: argv[0] when it is one (a runtime that set its
 * process title), else the script a runtime runs, by its name or package.
 */
export function argvHarness(argv: readonly string[]): string | null {
  const [command, script] = argv;
  const direct = harnessName(command);
  if (direct) return direct;
  const runtime = (command?.split("/").pop() ?? "").replace(/\.exe$/, "");
  if (!HARNESS_HOSTS.has(runtime) || !script) return null;
  const byName = harnessName(script);
  if (byName) return byName;
  for (const segment of script.split("/").reverse()) {
    const name = HARNESS_PACKAGES[segment];
    if (name) return name;
  }
  return null;
}

const MU_KEYS = ["MU_MANAGED_AGENT", "MU_AGENT_NAME", "MU_WORKSTREAM", "MU_ORCHESTRATOR"] as const;
type MuKey = (typeof MU_KEYS)[number];

/** The facts from an argv and `KEY=value` entries; every other entry is dropped. */
export function paneProcessFacts(argv: readonly string[], entries: readonly string[]): PaneProcess {
  const env = new Map<MuKey, string>();
  for (const entry of entries) {
    const at = entry.indexOf("=");
    const key = entry.slice(0, at) as MuKey;
    // The last one wins: `ps -E` prints argv before the environment.
    if (at > 0 && MU_KEYS.includes(key)) env.set(key, entry.slice(at + 1));
  }
  const managed = env.get("MU_MANAGED_AGENT") === "1";
  return {
    managed,
    agent_name: env.get("MU_AGENT_NAME") || null,
    workstream: env.get("MU_WORKSTREAM") || null,
    orchestrator: !!env.get("MU_ORCHESTRATOR"),
    harness: argvHarness(argv),
  };
}

/**
 * macOS (and other BSD) `ps -E -o command=`: argv then the environment, one
 * space-joined line. Ambiguous for a value with a space in it, which no
 * mu key or harness path this reads has.
 */
export function parsePsEnvironment(line: string): PaneProcess {
  const words = line.trim().split(/\s+/).filter(Boolean);
  return paneProcessFacts(words.slice(0, 2), words);
}

/**
 * One pane root process's facts, or null when they cannot be read: the pid is
 * gone, `ps` failed or ran past `PANE_PROCESS_TIMEOUT_MS`. Never throws.
 */
export function readPaneProcess(
  pid: string,
  platform: NodeJS.Platform = process.platform,
  procRoot = "/proc",
): PaneProcess | null {
  // Interpolated into a path or an argv: digits only, checked here.
  if (!/^\d+$/.test(pid)) return null;
  if (platform === "linux") {
    try {
      const argv = readFileSync(join(procRoot, pid, "cmdline"), "utf8").split("\0");
      let environ: string[] = [];
      try {
        environ = readFileSync(join(procRoot, pid, "environ"), "utf8").split("\0");
      } catch {
        // Another user's process: its argv still names the harness.
      }
      return paneProcessFacts(argv, environ);
    } catch {
      return null;
    }
  }
  try {
    const out = execFileSync(helperPath("ps"), ["-E", "-ww", "-o", "command=", "-p", pid], {
      encoding: "utf8",
      timeout: PANE_PROCESS_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() ? parsePsEnvironment(out) : null;
  } catch {
    return null;
  }
}
