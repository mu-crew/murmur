// Directory creation without Node's recursive mkdir.
//
// `mkdirSync(dir, { recursive: true })` -- and `module.enableCompileCache`,
// which uses the same code path -- spins forever at 100% CPU on some paths:
// anything under /proc, where mkdir keeps returning ENOENT. A TMPDIR or
// MURMUR_STATE_DIR there hung every command, the status-bar tick included.
// ensureDir walks up at most `maxDepth` levels, creates the missing ones one
// non-recursive mkdir at a time, and throws at the first error.
//
// Builtins only: src/cli.ts loads this before the program graph.

import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

/** Create `dir` and any missing parents. Throws a clear error; never spins. */
export function ensureDir(dir: string, maxDepth = 32): void {
  const missing: string[] = [];
  let cur = dir;
  for (;;) {
    let isDirectory: boolean;
    try {
      isDirectory = statSync(cur).isDirectory();
    } catch {
      missing.push(cur);
      const parent = dirname(cur);
      if (parent === cur || missing.length >= maxDepth) {
        throw new Error(`cannot create directory ${dir}: no existing parent directory`);
      }
      cur = parent;
      continue;
    }
    if (!isDirectory) throw new Error(`cannot create directory ${dir}: ${cur} is not a directory`);
    break;
  }
  for (const d of missing.reverse()) {
    try {
      mkdirSync(d);
    } catch (error) {
      // A concurrent murmur may have created it between the stat and here.
      if ((error as NodeJS.ErrnoException).code === "EEXIST" && statSync(d).isDirectory()) continue;
      throw new Error(`cannot create directory ${dir}: ${(error as Error).message}`);
    }
  }
}
