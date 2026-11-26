import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { conventionalTmuxDirectory, tmux } from "../src/mux.js";
import { configDir, dbPath, stateDir } from "../src/paths.js";
import { builtArtifact } from "./helpers/built.js";
import { CLEARED } from "./setup.js";

/**
 * The suite must be unable to reach the developer's live murmur state, or the
 * pane it was launched from.
 *
 * Live damage, not theory: tests that spawned the built CLI inherited the
 * vitest environment verbatim. That environment had no MURMUR_STATE_DIR -- so
 * `stateDir()` fell through to the REAL database -- and it had the $TMUX_PANE
 * of the pane running `npm test`, so every run wrote rows for panes whose
 * agents were alive and working.
 *
 * Clearing MURMUR_STATE_DIR (which is what the first isolation pass did) is not
 * enough, and is the trap: a cleared variable falls back to the real home, so
 * "isolated" and "aimed at production" look identical. The rig has to REDIRECT
 * the fallback, so that a test which sets nothing still cannot land outside a
 * temporary directory.
 */

const SANDBOX = resolve(tmpdir());

/** Is `path` inside the OS temp dir, whatever the test set (or forgot to set)? */
function underTmp(path: string): boolean {
  return resolve(path).startsWith(`${SANDBOX}/`);
}

test("a test that sets nothing still resolves state under a temp dir", () => {
  // The default path, exercised by every test that never touches
  // MURMUR_STATE_DIR: identity.json, state.db and the config dir must all land
  // in the sandbox rather than in the developer's home.
  expect(underTmp(stateDir()), `stateDir() escaped the sandbox: ${stateDir()}`).toBe(true);
  expect(underTmp(configDir()), `configDir() escaped the sandbox: ${configDir()}`).toBe(true);
  expect(underTmp(dbPath()), `dbPath() escaped the sandbox: ${dbPath()}`).toBe(true);
});

test("the local collector cannot find the developer's tmux servers", () => {
  // `readLocal` enumerates every socket in tmux's conventional directory and
  // writes the pill options to each server it reaches. Inherited, that
  // directory is the developer's: a collect in any test would read and write
  // their live servers. The rig points it at an empty sandbox.
  const directory = conventionalTmuxDirectory();
  expect(directory.startsWith("/tmp/mmt-") || directory.startsWith("/private/tmp/mmt-")).toBe(true);
  expect(tmux.servers().map((server) => server.kind === "default")).not.toContain(true);
});

test("a subprocess inheriting the test environment resolves the same sandbox", () => {
  // The actual incident shape. Several tests spawn the built CLI; a child inherits process.env, so isolation only holds
  // if it survives the process boundary.
  //
  // Resolves the path rather than running a verb that writes, deliberately: a
  // red run of this test must not be the thing that corrupts the real database.
  const out = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(builtArtifact("index.js"))});
       process.stdout.write(m.stateDir());`,
    ],
    { encoding: "utf8", env: process.env, timeout: 30_000 },
  );
  expect(underTmp(out), `a child resolved state outside the sandbox: ${out}`).toBe(true);
});

test("no test can address the tmux pane that launched the suite", () => {
  // $TMUX_PANE and $TMUX are inherited. Left in place, anything that resolves
  // "this pane" or "this server" resolves the pane running `npm test` -- an
  // agent's pane, when the suite is run by an agent.
  //
  // Honest about its limit: outside tmux this cannot fail, which is why the
  // test below asserts the setup's own behaviour instead of the ambient value.
  expect(process.env.TMUX_PANE, "TMUX_PANE leaked into the suite").toBeUndefined();
  expect(process.env.TMUX, "TMUX leaked into the suite").toBeUndefined();
});

test("the setup clears the inherited pane and owner claim rather than reading them", () => {
  // The setup's behaviour, independent of where the suite runs: set every name
  // it promises to clear, load it fresh, and require that they are gone.
  for (const name of CLEARED) vi.stubEnv(name, "%999");
  for (const name of CLEARED) expect(process.env[name]).toBe("%999");

  vi.resetModules();
  return import("./setup.js").then(() => {
    for (const name of CLEARED) {
      expect(process.env[name], `${name} survived the setup`).toBeUndefined();
    }
    vi.unstubAllEnvs();
  });
});
