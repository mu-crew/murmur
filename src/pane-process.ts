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
 * per status tick. `murmur stop` alone reads `MU_CTL_SOCK` (`readPaneCtlSocket`),
 * fresh and uncached, to reach pi's control socket.
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
  /** `MU_ORCHESTRATOR=1`. */
  orchestrator: boolean;
  /** The harness its argv names, else null. */
  harness: string | null;
};

/** How long one `ps` may take. A pane past it gets no fallback this read. */
export const PANE_PROCESS_TIMEOUT_MS = 1_000;

/** The runtimes a harness runs under, as tmux names a pane's command. */
export const HARNESS_HOSTS: ReadonlySet<string> = new Set(["node", "bun"]);

/**
 * The npm packages that are a harness whose script name is not one, matched
 * only as the package right after the last `node_modules/` in the script path
 * (`.../node_modules/@anthropic-ai/claude-code/cli.js`).
 */
const HARNESS_PACKAGES: Readonly<Record<string, string>> = {
  "@anthropic-ai/claude-code": "claude",
  "@mariozechner/pi-coding-agent": "pi",
  "@openai/codex": "codex",
};

/** Runtime flags that take the next argv word as their value. */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "--preload",
  "--conditions",
  "-C",
  "--env-file",
  "--title",
  "--inspect-port",
]);

/** The script a runtime argv runs: the first word after its flags. */
function runtimeScript(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--") return args[i + 1];
    if (!arg.startsWith("-")) return arg;
    if (VALUE_FLAGS.has(arg)) i++;
  }
  return undefined;
}

/** The harness an npm package path is, by the package after the last `node_modules/`. */
function packageHarness(script: string): string | null {
  const segments = script.split("/");
  const at = segments.lastIndexOf("node_modules");
  if (at < 0) return null;
  const first = segments[at + 1] ?? "";
  const pkg = first.startsWith("@") ? `${first}/${segments[at + 2] ?? ""}` : first;
  return HARNESS_PACKAGES[pkg] ?? null;
}

/**
 * The harness an argv runs: argv[0] when it is one (a runtime that set its
 * process title), else the script a runtime runs, by its basename (a bin link
 * such as `/opt/homebrew/bin/claude`) or its npm package.
 */
export function argvHarness(argv: readonly string[]): string | null {
  const [command, ...args] = argv;
  const direct = harnessName(command);
  if (direct) return direct;
  const runtime = (command?.split("/").pop() ?? "").replace(/\.exe$/, "");
  if (!HARNESS_HOSTS.has(runtime)) return null;
  const script = runtimeScript(args);
  if (!script) return null;
  return harnessName(script) ?? packageHarness(script);
}

const MU_KEYS = ["MU_MANAGED_AGENT", "MU_AGENT_NAME", "MU_WORKSTREAM", "MU_ORCHESTRATOR"] as const;
type MuKey = (typeof MU_KEYS)[number];

/** The facts from an argv and `KEY=value` environment entries; every other entry is dropped. */
export function paneProcessFacts(argv: readonly string[], entries: readonly string[]): PaneProcess {
  const env = new Map<MuKey, string>();
  for (const entry of entries) {
    const at = entry.indexOf("=");
    const key = entry.slice(0, at) as MuKey;
    if (at > 0 && MU_KEYS.includes(key)) env.set(key, entry.slice(at + 1));
  }
  return {
    managed: env.get("MU_MANAGED_AGENT") === "1",
    agent_name: env.get("MU_AGENT_NAME") || null,
    workstream: env.get("MU_WORKSTREAM") || null,
    // As mu checks it: "1" only.
    orchestrator: env.get("MU_ORCHESTRATOR") === "1",
    harness: argvHarness(argv),
  };
}

/** A whole mu entry (MU_ prefix) as `ps -E` prints it: mu's values carry no space. */
const MU_ENTRY = /^MU_[A-Z_]+=\S*$/;

/**
 * macOS (and other BSD) `ps`: `command` is argv, `envCommand` (`ps -E`) is the
 * same argv then the environment, all joined by spaces, newlines as `\012`.
 * Only the suffix after the exact argv is environment, so an argv word never
 * reads as a variable. A value with a space in it splits into words, so only
 * whole KEY=value words with the MU_ prefix count, and a key seen twice with
 * different values voids the environment: such a value cannot outvote a real
 * mu key printed before or after it. Null when the two reads disagree (the
 * pid changed between them).
 */
export function parsePsEnvironment(command: string, envCommand: string): PaneProcess | null {
  const env = psEnvironment(command, envCommand);
  return env && paneProcessFacts(env.argv, env.entries);
}

/** A root process's argv and its environment entries, as far as they could be read. */
type PaneEnv = { argv: string[]; entries: string[] };

function psEnvironment(command: string, envCommand: string): PaneEnv | null {
  const argvLine = command.replace(/\n+$/, "");
  const envLine = envCommand.replace(/\n+$/, "");
  if (!argvLine.trim() || !envLine.startsWith(argvLine)) return null;
  const entries = envLine
    .slice(argvLine.length)
    .split(/\s+/)
    .filter((word) => MU_ENTRY.test(word));
  const seen = new Map<string, string>();
  for (const entry of entries) {
    const at = entry.indexOf("=");
    const [key, value] = [entry.slice(0, at), entry.slice(at + 1)];
    if (seen.has(key) && seen.get(key) !== value) {
      return { argv: argvLine.trim().split(/\s+/), entries: [] };
    }
    seen.set(key, value);
  }
  return { argv: argvLine.trim().split(/\s+/), entries };
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
  const env = readPaneEnv(pid, platform, procRoot);
  return env && paneProcessFacts(env.argv, env.entries);
}

/**
 * The mu pi extension's control socket a pane's root process was given
 * (`MU_CTL_SOCK`), or null. mu sets it for every harness it spawns; only a pi
 * with the extension loaded listens on it. Never throws.
 */
export function readPaneCtlSocket(
  pid: string,
  platform: NodeJS.Platform = process.platform,
  procRoot = "/proc",
): string | null {
  const entries = readPaneEnv(pid, platform, procRoot)?.entries ?? [];
  const entry = entries.find((candidate) => candidate.startsWith(`${CTL_SOCK_KEY}=`));
  return entry?.slice(CTL_SOCK_KEY.length + 1) || null;
}

const CTL_SOCK_KEY = "MU_CTL_SOCK";

/** The argv and environment of a pid, by `/proc` on Linux and `ps -E` elsewhere. */
function readPaneEnv(pid: string, platform: NodeJS.Platform, procRoot: string): PaneEnv | null {
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
      return { argv, entries: environ };
    } catch {
      return null;
    }
  }
  try {
    const ps = (args: string[]) =>
      execFileSync(helperPath("ps"), [...args, "-ww", "-o", "command=", "-p", pid], {
        encoding: "utf8",
        timeout: PANE_PROCESS_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "ignore"],
      });
    const command = ps([]);
    return psEnvironment(command, ps(["-E"]));
  } catch {
    return null;
  }
}
