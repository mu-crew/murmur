/**
 * Strip murmur's own environment before any test module loads.
 *
 * The suite must not be able to tell what the developer running it exports:
 * which tmux pane `npm test` runs in, which state dir murmur points at, which
 * tmux servers and Rex are live on the machine. Every name below is read by
 * production code, and an inherited value aims a test at the developer's real
 * panes, real store or real multiplexer.
 *
 * Cleared suite-wide rather than stubbed per test: no test legitimately wants
 * the ambient value, a per-test stub is the one someone forgets, and a setup
 * file runs before the module under test is imported, so there is no ordering
 * to get wrong. Tests that want a value set it themselves with `vi.stubEnv`.
 *
 * Removal is not always the safe move, though -- see REDIRECTED below, where
 * clearing a variable hands the suite the developer's live state instead of
 * isolating it.
 */

import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll } from "vitest";

/**
 * Deleted outright: every variable whose absence is the safe answer.
 *
 * TMUX and TMUX_PANE name the pane running `npm test`: inherited, a test that
 * resolves "this pane" resolves a REAL agent's pane. Tests that need a pane
 * pass one explicitly -- `vi.stubEnv`, a fake mux, or a child env -- and the
 * tmux tests stand up their own private servers.
 */
const CLEARED = [
  // A mu worker's identity: inherited when a crew agent runs the suite.
  "MU_AGENT_NAME",
  "MU_WORKSTREAM",
  // The rest of the identity `readPaneProcess` parses from a pane's root
  // process (never this one's environment).
  "MU_MANAGED_AGENT",
  "MU_ORCHESTRATOR",
  "TMUX",
  "TMUX_PANE",
  // A suite run from a Rex pane would otherwise take the Rex jump path and
  // open real tabs (`outsideTmux`).
  "TERM_PROGRAM",
  "REX_SESSION",
  "REX_BLOCK",
] as const;

/**
 * Redirected, not deleted: every variable that has a DANGEROUS default.
 *
 * This is the part a plain delete gets wrong. `stateDir()` falls back to
 * `$XDG_STATE_HOME/murmur3`, else `~/.local/state/murmur3` -- the developer's
 * real database -- so unsetting MURMUR_STATE_DIR aims the suite at
 * PRODUCTION, and the two states are indistinguishable from inside a test.
 *
 * TMUX_TMPDIR is the same hazard for the multiplexer. The local collector
 * enumerates every socket in tmux's conventional directory and WRITES the
 * pill options to each server it reaches, so a collect left on the default
 * directory would read and write the developer's live tmux servers. Pointed at
 * an empty sandbox, the directory names only the private servers a test
 * starts; short, under /tmp, for the unix socket path limit.
 *
 * One directory per test FILE (a setup file runs once per file), created here
 * rather than per test, because a child spawned by a test inherits the
 * environment and must land in the same sandbox.
 */
// Recorded in the environment so a RE-IMPORT reuses it. The isolation tests
// re-import this module mid-test (`vi.resetModules()`) to assert what it does
// rather than what the shell happened to hold; a fresh mkdtemp there would
// repoint state under a test that is already running, and leave the first
// directory behind with no hook to sweep it.
const SANDBOX_ENV = "MURMUR_SUITE_SANDBOX";
const existing = process.env[SANDBOX_ENV];
const sandbox = existing ?? mkdtempSync(join(tmpdir(), "murmur-suite-"));
process.env[SANDBOX_ENV] = sandbox;

// Swept at the end of the file's run, by whichever import created it. Not
// load-bearing for isolation -- a leftover sandbox is harmless -- but without
// it a full run leaves one directory per test file behind, and a suite that
// litters is a suite whose temp dirs nobody notices growing.
if (!existing) afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

const TMUX_SANDBOX_ENV = "MURMUR_SUITE_TMUX";
const tmuxSandbox = process.env[TMUX_SANDBOX_ENV] ?? mkdtempSync("/tmp/mmt-");
process.env[TMUX_SANDBOX_ENV] = tmuxSandbox;
if (!existing) afterAll(() => rmSync(tmuxSandbox, { recursive: true, force: true }));

const REDIRECTED = {
  MURMUR_STATE_DIR: join(sandbox, "state"),
  MURMUR_CONFIG_DIR: join(sandbox, "config"),
  XDG_STATE_HOME: join(sandbox, "xdg-state"),
  XDG_CONFIG_HOME: join(sandbox, "xdg-config"),
  TMUX_TMPDIR: tmuxSandbox,
} as const;

for (const name of CLEARED) delete process.env[name];
for (const [name, value] of Object.entries(REDIRECTED)) process.env[name] = value;

/**
 * ssh, fenced: any ssh a test starts -- directly, through `helperPath`, or in a
 * built-CLI child -- must name its config with `-F`, or it is refused as an
 * unreachable host (255). ssh reads ~/.ssh/config from the passwd home, not
 * $HOME, so no redirect above reaches it, and the developer's config can
 * rewrite `dev`, deny it, or run a `Match exec`. A status test once resolved
 * its fixture through whatever that config said.
 */
const fence = join(sandbox, "bin");
const searchPath = (process.env.PATH ?? "").split(delimiter).filter((dir) => dir !== fence);
const realSsh = searchPath
  .map((dir) => join(dir, "ssh"))
  .find((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
mkdirSync(fence, { recursive: true });
writeFileSync(
  join(fence, "ssh"),
  [
    "#!/bin/sh",
    `for arg in "$@"; do case "$arg" in -F*) ${realSsh ? `exec '${realSsh.replaceAll("'", `'\\''`)}' "$@"` : "exit 255"} ;; esac; done`,
    `echo "murmur test rig: refusing ssh without -F (it would read the developer's ssh config): ssh $*" >&2`,
    "exit 255",
    "",
  ].join("\n"),
  { mode: 0o755 },
);
/**
 * Rex, fenced the same way: the local collector asks the `rex` CLI for every
 * Rex pane, so a test that forgets `rex: false` would read the developer's
 * live Rex. The rig's `rex` answers nothing, which murmur reads as "no Rex
 * here". A test that wants Rex injects a reader.
 */
writeFileSync(
  join(fence, "rex"),
  ["#!/bin/sh", 'echo "murmur test rig: no Rex in the suite" >&2', "exit 1", ""].join("\n"),
  { mode: 0o755 },
);
process.env.PATH = [fence, ...searchPath].join(delimiter);

/** Every variable the rig controls, cleared or redirected. The drift guard's set. */
const OWNED = [...CLEARED, ...(Object.keys(REDIRECTED) as (keyof typeof REDIRECTED)[])] as const;

export { CLEARED, OWNED, REDIRECTED };
