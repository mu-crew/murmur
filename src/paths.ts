import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The state directory's name. `murmur2` since the hook-harness store: a 1.x
 * murmur refuses that store (it reads schema 9 and refuses anything from 10
 * up), so the two keep separate directories and run side by side. A change
 * that breaks on-disk compatibility with the released version takes the next
 * name (`murmur3`); an additive one stays here.
 */
export const STATE_DIR_NAME = "murmur2";

/** What 1.x murmur called it. Read once, by the first-run migration, never written. */
export const LEGACY_STATE_DIR_NAME = "murmur";

/**
 * Everything murmur keeps: the store, identity, the compile cache, the tmux
 * socket cache. `MURMUR_STATE_DIR` overrides it; otherwise the XDG state home.
 */
export function stateDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return (
    env.MURMUR_STATE_DIR ??
    join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), STATE_DIR_NAME)
  );
}

/**
 * Where the pane inbox and the remote area live: under the home directory
 * whatever `XDG_STATE_HOME` says. Muse Code starts its hooks with an env
 * allowlist that keeps `HOME` and drops `XDG_STATE_HOME`, so a hook could not
 * find the XDG path, and writers and readers must agree on one place.
 * `MURMUR_STATE_DIR` still overrides it, for tests and sandboxes; a hook that
 * cannot see that variable cannot see the override either.
 */
export function homeStateDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.MURMUR_STATE_DIR ?? join(home, ".local", "state", STATE_DIR_NAME);
}

/**
 * The directory a 1.x murmur in this environment uses, for the first-run
 * migration, or null under `MURMUR_STATE_DIR`: an explicit directory is the
 * operator's, and nothing is migrated into it.
 */
export function legacyStateDir(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string | null {
  if (env.MURMUR_STATE_DIR !== undefined) return null;
  return join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), LEGACY_STATE_DIR_NAME);
}

export function configDir(): string {
  return (
    process.env.MURMUR_CONFIG_DIR ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "murmur")
  );
}

/** The current-state database. The only database murmur holds. */
export function dbPath(): string {
  return join(stateDir(), "state.db");
}
