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
