import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentAnchor, AnchorLookup, ProcessRow } from "./process-chain.js";

/**
 * The read side of mu's anchor files, as far as placing an event needs it.
 *
 * mu starts each harness through a wrapper that writes
 * `~/.local/state/mu-next/anchors/<pid>.json` and then `exec`s the harness, so
 * the pid stays the same. A hook finds its agent's identity there rather than
 * in the environment, which some harnesses clear for their hooks. murmur only
 * reads; mu owns the format.
 *
 * The file's `start_time` (seconds since the epoch, the process's `lstart`) must
 * match the process's: a pid is reused, and an anchor left behind by a dead
 * agent must not name a stranger.
 */

/**
 * mu's anchor directories, in the order they are read: the home path
 * `~/.local/state/mu-next/anchors` always, then `$XDG_STATE_HOME`'s when that
 * names another directory. Not under murmur's state dir: mu writes them.
 *
 * The home path comes first and never depends on the environment, because a
 * hook may not have one: Muse Code starts its hooks with a fixed allowlist that
 * keeps `HOME` and drops `XDG_STATE_HOME`. So mu needs to write only the home
 * path for every hook to find it; the XDG directory is a fallback for a wrapper
 * that wrote there alone.
 */
export function anchorDirs(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const primary = join(home, ".local", "state", "mu-next", "anchors");
  const xdg = env.XDG_STATE_HOME ? join(env.XDG_STATE_HOME, "mu-next", "anchors") : primary;
  return xdg === primary ? [primary] : [primary, xdg];
}

/** One second of slack, for two readers rounding the same `lstart` differently. */
const START_SLACK_S = 1;

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Parse one anchor file's contents for `process`, or null when it does not match. */
export function parseAnchor(raw: string, process: ProcessRow): AgentAnchor | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  const started = record.start_time;
  if (typeof started !== "number" || process.started === null) return null;
  if (Math.abs(started - process.started) > START_SLACK_S) return null;
  return {
    agent_name: text(record.agent_name),
    workstream: text(record.workstream),
    role: text(record.role),
    cli: text(record.cli),
    orchestrator: record.orchestrator === true,
    remote_key: text(record.remote_key),
  };
}

/**
 * An `AnchorLookup` over directories of anchor files, read in order. A file
 * that does not match the process (a reused pid's leftover) does not stop the
 * search: the next directory may hold the live one.
 */
export function anchorLookup(dirs: string | readonly string[] = anchorDirs()): AnchorLookup {
  const list = typeof dirs === "string" ? [dirs] : dirs;
  return (process) => {
    for (const dir of list) {
      let raw: string;
      try {
        raw = readFileSync(join(dir, `${process.pid}.json`), "utf8");
      } catch {
        continue;
      }
      const anchor = parseAnchor(raw, process);
      if (anchor) return anchor;
    }
    return null;
  };
}
