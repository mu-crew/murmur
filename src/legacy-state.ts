import { copyFileSync, existsSync, linkSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDir } from "./dirs.js";

/**
 * The first-run migration from a 1.x murmur's state directory.
 *
 * 2.x keeps its state in `murmur2` (see `STATE_DIR_NAME`), because a 1.x build
 * refuses the 2.x store. The first time a 2.x build finds no identity it copies
 * the old `identity.json`, so the host keeps its `host_id` and every peer still
 * knows it; the first time it creates a store it reads the old store's peers
 * (`openStore`, through `copyLegacyStore`).
 *
 * The old directory is only ever read. Nothing here writes, moves or deletes
 * anything in it -- not even SQLite's `-shm` file, which a read-only open of a
 * WAL database still writes -- so a 1.x murmur keeps working beside 2.x.
 */

/**
 * Copy `from/identity.json` to `to/identity.json` when `to` has none. Answers
 * whether `to` has one now. Never throws.
 *
 * Copied under a temporary name and linked into place, so a reader never sees
 * a partial file and a concurrent first run cannot overwrite the winner's copy.
 */
export function migrateLegacyIdentity(from: string | null, to: string): boolean {
  const target = join(to, "identity.json");
  if (existsSync(target)) return true;
  if (from === null) return false;
  const source = join(from, "identity.json");
  if (!existsSync(source)) return false;
  const temporary = join(
    to,
    `.identity.json.${process.pid}.${Math.random().toString(36).slice(2)}`,
  );
  try {
    ensureDir(to);
    copyFileSync(source, temporary);
    linkSync(temporary, target);
  } catch {
    // Lost a race to another first run (EEXIST), or could not read or write.
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // Never written.
    }
  }
  return existsSync(target);
}

/**
 * A private copy of `from/state.db` (and its `-wal`, which holds the latest
 * writes until a checkpoint), for `work` to read, or null when there is no old
 * store. The copy is opened instead of the original so the old directory is
 * never written to, and deleted afterwards. Never throws for a missing or
 * unreadable store: `work`'s fallback is the answer.
 */
export function withLegacyStoreCopy<T>(
  from: string | null,
  work: (path: string) => T,
  fallback: T,
): T {
  if (from === null) return fallback;
  const source = join(from, "state.db");
  if (!existsSync(source)) return fallback;
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "murmur-legacy-"));
    const copy = join(dir, "state.db");
    copyFileSync(source, copy);
    if (existsSync(`${source}-wal`)) copyFileSync(`${source}-wal`, `${copy}-wal`);
    return work(copy);
  } catch {
    return fallback;
  } finally {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
  }
}
