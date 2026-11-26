import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * The state directory's name. `murmur3` since the OSC 7501 collector: 3.0's
 * store holds no agent rows, and a 2.x murmur refuses it, so the two keep
 * separate directories and run side by side. A change that breaks on-disk compatibility with the
 * released version takes the next name; an additive one stays here.
 */
export const STATE_DIR_NAME = "murmur3";

/** What 2.x murmur called it. Read once, by the first-run migration, never written. */
export const LEGACY_STATE_DIR_NAME = "murmur2";

/**
 * `$XDG_STATE_HOME`, or undefined when it is unset, empty or relative. The XDG
 * spec says a relative value is to be ignored, and mu and muzzle ignore it: a
 * murmur that honoured `XDG_STATE_HOME=state` would put its store under
 * whatever directory it was started in, and miss mu's anchors.
 */
export function xdgStateHome(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.XDG_STATE_HOME;
  return value && isAbsolute(value) ? value : undefined;
}

/** `$MURMUR_STATE_DIR`, or undefined when it is unset or empty. */
function stateDirOverride(env: NodeJS.ProcessEnv): string | undefined {
  return env.MURMUR_STATE_DIR || undefined;
}

/**
 * Everything murmur keeps: the store, identity, the compile cache. `MURMUR_STATE_DIR` overrides it; otherwise the XDG state home.
 */
export function stateDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return (
    stateDirOverride(env) ??
    join(xdgStateHome(env) ?? join(home, ".local", "state"), STATE_DIR_NAME)
  );
}

/**
 * The directory a 2.x murmur in this environment uses, for the first-run
 * migration, or null under `MURMUR_STATE_DIR`: an explicit directory is the
 * operator's, and nothing is migrated into it.
 */
export function legacyStateDir(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string | null {
  if (stateDirOverride(env) !== undefined) return null;
  return join(xdgStateHome(env) ?? join(home, ".local", "state"), LEGACY_STATE_DIR_NAME);
}

/** Where peers and settings live, by the same rules as the state directory. */
export function configDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const xdg = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : null;
  return env.MURMUR_CONFIG_DIR || join(xdg ?? join(home, ".config"), "murmur");
}

/** The current-state database. The only database murmur holds. */
export function dbPath(): string {
  return join(stateDir(), "state.db");
}
