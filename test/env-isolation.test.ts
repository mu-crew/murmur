import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { CLEARED, OWNED, REDIRECTED } from "./setup.js";

/**
 * The suite must not be able to tell what the developer's shell exports.
 *
 * Tests once passed on the maintainer's machine and failed in every other
 * checkout, on byte-identical files, because his shell exported a murmur
 * variable the code under test read. A value inherited from `npm test`'s pane
 * aims a test at the developer's real panes, store or multiplexer.
 *
 * These tests guard the rig itself, in the three ways it can rot.
 */

test("the ambient murmur environment is gone by the time a test runs", () => {
  // The wiring. If `setupFiles` is dropped from vitest.config.ts, or the setup
  // stops running before test modules, this fails in exactly the shells where
  // it matters: the ones that leaked a value in.
  //
  // Honest about its own limit -- in an already-clean shell this cannot fail,
  // which is why the two tests below do not depend on the environment at all.
  for (const name of CLEARED) {
    expect(process.env[name], `${name} leaked into the suite`).toBeUndefined();
  }
  // The redirected half is asserted by value, not by absence: unsetting these
  // hands the suite the developer's real state dir, so "gone" would be the
  // wrong contract. See test/state-isolation.test.ts.
  for (const [name, value] of Object.entries(REDIRECTED)) {
    expect(process.env[name], `${name} is not pointed at the sandbox`).toBe(value);
  }
});

test("the setup file rewrites the variables rather than merely reading them", () => {
  // The setup's own behaviour, independent of the shell: set every name, load
  // the module fresh, and require that it acted. A setup that imports cleanly
  // but changes nothing would pass the test above in a clean shell.
  for (const name of OWNED) vi.stubEnv(name, "/leaked/from/the/developer/shell");
  for (const name of OWNED) expect(process.env[name]).toBe("/leaked/from/the/developer/shell");

  vi.resetModules();
  return import("./setup.js").then(() => {
    for (const name of CLEARED) {
      expect(process.env[name], `${name} survived the setup`).toBeUndefined();
    }
    for (const name of Object.keys(REDIRECTED)) {
      expect(process.env[name], `${name} kept the leaked value`).not.toBe(
        "/leaked/from/the/developer/shell",
      );
    }
    vi.unstubAllEnvs();
  });
});

test("every environment variable src/ reads is one the rig controls", () => {
  // The drift guard, and the reason this is a list rather than a single delete.
  // Any MURMUR_*/MU_*/TMUX* read is a hazard -- one read at module scope cannot
  // be intercepted by a test at all -- and this fails the moment one is added
  // without being listed.
  //
  // Deliberately does NOT assert the reverse (that every OWNED name is still
  // read by src/): clearing a variable nothing reads is harmless, and pinning
  // it would make deleting a feature fail an unrelated test.
  const owned = new Set<string>(OWNED);
  const read = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts")) {
        // Widened past `process.env.X` on purpose: TMUX / TMUX_PANE / XDG_*
        // reach src/ both as `process.env.TMUX_PANE` and as `env.TMUX_PANE` on a
        // passed-in environment, and a name indexed through a constant is
        // invisible to the narrow pattern. All three shapes count as "src/ reads
        // this".
        for (const match of readFileSync(path, "utf8").matchAll(
          /(?:\benv\.|["'`])((?:MURMUR|MU|TMUX|XDG)[A-Z0-9_]*)/g,
        )) {
          if (match[1]) read.add(match[1]);
        }
        // REX_* only as a property read: glance.ts quotes REX_* names that are
        // its own shell and constant names, not environment reads.
        for (const match of readFileSync(path, "utf8").matchAll(/\benv\.(REX_[A-Z0-9_]+)/g)) {
          if (match[1]) read.add(match[1]);
        }
      }
    }
  };
  walk("src");

  // Sanity: the scan found something, so an empty result cannot pass this.
  expect(read.size).toBeGreaterThan(0);
  expect([...read].sort()).toEqual([...read].filter((name) => owned.has(name)).sort());
});

test("an ssh a test starts cannot read the developer's ssh config", async () => {
  // ssh reads ~/.ssh/config from the passwd home, not $HOME, so no env
  // redirect isolates it: a `Match exec` there runs, a `Host dev` rewrite
  // reroutes a resolver test. The rig's ssh refuses any argv without `-F`.
  const { spawnSync } = await import("node:child_process");
  const { findHelper } = await import("../src/helper-path.js");
  const ssh = findHelper("ssh");
  expect(ssh).not.toBeNull();
  const unisolated = spawnSync(ssh ?? "ssh", ["-G", "localhost"], { encoding: "utf8" });
  expect(unisolated.status).toBe(255);
  expect(unisolated.stdout).toBe("");
  expect(unisolated.stderr).toContain("-F");
});
