/**
 * The blessed agent harnesses, as data.
 *
 * One frozen table, the same shape mu keeps, so the two tools cannot disagree
 * about which process is which harness. murmur reads only what placing an
 * inbox event needs: how to recognise each harness's processes by their argv.
 *
 * Matched by argv and never by process name. pi can run as `bun`, `node` or
 * `pi`, and cursor-agent is a node process whose argv names it. A harness's
 * launcher and the binary it starts both match (`claude` and its native
 * `claude`, `codex` and `codex.real`, `muse` and `muse.real`), which is what lets
 * `placeEvent` collapse an adjacent run of them into one harness.
 */

export const HARNESSES = ["claude", "codex", "cursor-agent", "muse", "pi"] as const;

export type Harness = (typeof HARNESSES)[number];

type HarnessRow = {
  /** Executable basenames, after stripping a `.real`, `.js`, `.mjs` or `.cjs` suffix. */
  readonly names: readonly string[];
  /**
   * Package directories an interpreted entry point can live in, for a script
   * whose own basename says nothing (`…/pi-coding-agent/dist/cli.js`).
   */
  readonly packages: readonly string[];
};

function row(names: string[], packages: string[] = []): HarnessRow {
  return Object.freeze({ names: Object.freeze(names), packages: Object.freeze(packages) });
}

export const HARNESS_TABLE: Readonly<Record<Harness, HarnessRow>> = Object.freeze({
  claude: row(["claude"]),
  codex: row(["codex"]),
  "cursor-agent": row(["cursor-agent"], ["cursor-agent"]),
  muse: row(["muse"]),
  pi: row(["pi"], ["pi-coding-agent"]),
});

export function isHarness(value: unknown): value is Harness {
  return typeof value === "string" && (HARNESSES as readonly string[]).includes(value);
}

/**
 * Interpreters a harness may run under, whose FIRST argument is then the
 * harness's entry point: `node …/cursor-agent/index.js`, `bun …/pi`.
 */
const INTERPRETERS = new Set(["node", "nodejs", "bun", "deno"]);

function executableName(token: string): string {
  const base = token.slice(token.lastIndexOf("/") + 1);
  return base.replace(/\.(?:real|js|mjs|cjs)$/, "");
}

/**
 * The harness a process's argv names, or null.
 *
 * Reads the executable and, under an interpreter, the script it runs. A path
 * segment names the harness too when it is a package directory the harness's
 * entry point lives in (`…/cursor-agent/index.js`). Arguments past that are never
 * read: a shell running `claude -p …` in its command string is a shell, not a
 * claude.
 */
export function harnessFromArgv(args: string): Harness | null {
  const tokens = args.trim().split(/\s+/);
  const first = tokens[0] ?? "";
  const candidates = [first];
  if (INTERPRETERS.has(executableName(first))) {
    const script = tokens.slice(1).find((token) => !token.startsWith("-"));
    if (script) candidates.push(script);
  }
  for (const candidate of candidates) {
    const name = executableName(candidate);
    const segments = candidate.split("/").slice(0, -1);
    for (const harness of HARNESSES) {
      const { names, packages } = HARNESS_TABLE[harness];
      if (names.includes(name)) return harness;
      if (segments.some((segment) => packages.includes(segment))) return harness;
    }
  }
  return null;
}

/**
 * Options of codex and Muse Code that take a value in the next argument, so
 * the value is not read as the subcommand. A value glued on (`-c=x`,
 * `--model=x`) is one token and needs no entry. An option missing here (a
 * launcher's own) makes the subcommand unreadable, never misread: see
 * `subcommand`.
 */
const VALUE_OPTIONS = new Set([
  "-c",
  "--config",
  "-m",
  "--model",
  "-p",
  "--profile",
  "-s",
  "--sandbox",
  "-a",
  "--ask-for-approval",
  "-C",
  "--cd",
  "-i",
  "--image",
  "--enable",
  "--disable",
  "--add-dir",
  "--local-provider",
  "--remote",
  "--remote-auth-token-env",
]);

/** The subcommands of codex and Muse Code that answer one prompt and exit. */
const ONE_SHOT_SUBCOMMANDS = new Set(["exec", "e", "review"]);

/** The arguments after the executable, or after the script under an interpreter. */
function harnessArguments(tokens: readonly string[]): string[] {
  const rest = tokens.slice(1);
  if (!INTERPRETERS.has(executableName(tokens[0] ?? ""))) return rest;
  const script = rest.findIndex((token) => !token.startsWith("-"));
  return script < 0 ? [] : rest.slice(script + 1);
}

/**
 * The first argument that is neither an option nor an option's value: null
 * when there is none (an interactive session), undefined when it cannot be
 * told. After an option this table does not know, the next bare argument may
 * be that option's value, so only a one-shot subcommand still reads as one.
 */
function subcommand(args: readonly string[]): string | null | undefined {
  let unknown = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] as string;
    // Past `--` every argument is the prompt, never a subcommand.
    if (token === "--") return null;
    if (!token.startsWith("-")) {
      return unknown && !ONE_SHOT_SUBCOMMANDS.has(token) ? undefined : token;
    }
    if (VALUE_OPTIONS.has(token)) index += 1;
    else if (!token.includes("=")) unknown = true;
  }
  return null;
}

/** How a harness process runs, read from its own arguments; see `runMode`. */
export type RunMode = "one-shot" | "interactive";

/**
 * Whether a harness process is a one-shot run, which answers one prompt and
 * exits, or an interactive session; null when its arguments cannot tell.
 * One-shot runs are `codex exec` (or `e`, or `review`), the same for
 * `muse`, `claude -p`/`--print` and `cursor-agent -p`/`--print`.
 *
 * A one-shot run inside another harness's process chain is a nested agent even
 * with no shell between the two: a shell tool that `exec`s its only command
 * leaves `codex exec` directly under the outer `codex.real`, where it would
 * otherwise read as one more member of the outer codex's launcher run. Null
 * (a launcher option this module does not know, before a bare argument) is
 * never grounds to split a run.
 *
 * pi is never one-shot here: its in-process reporter places its own events,
 * and nothing about how it does so changes.
 */
export function runMode(harness: Harness, args: string): RunMode | null {
  const rest = harnessArguments(args.trim().split(/\s+/));
  switch (harness) {
    case "codex":
    case "muse": {
      const sub = subcommand(rest);
      if (sub === undefined) return null;
      return sub !== null && ONE_SHOT_SUBCOMMANDS.has(sub) ? "one-shot" : "interactive";
    }
    case "claude":
    case "cursor-agent":
      return rest.some(
        (token) => token === "-p" || token === "--print" || token.startsWith("--print="),
      )
        ? "one-shot"
        : "interactive";
    case "pi":
      return "interactive";
  }
}
