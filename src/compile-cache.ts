// Best-effort V8 compile cache for the `murmur` bin (see src/cli.ts).
//
// Never hand enableCompileCache a directory that does not exist yet: it
// creates it with Node's recursive mkdir, which spins forever on paths under
// /proc (see src/dirs.ts). Create the directory with ensureDir first, check
// it is writable, and skip the cache on any failure. Builtins only.

import { accessSync, constants } from "node:fs";
import * as nodeModule from "node:module";
import { ensureDir } from "./dirs.js";

type EnableCompileCache = (dir: string) => unknown;

const nodeEnable = (nodeModule as { enableCompileCache?: EnableCompileCache }).enableCompileCache;

/**
 * Enable the compile cache in `dir`. Returns whether it was turned on; never
 * throws. `enable` is null on Node before 22.8, which has no such API.
 * Skipped under NODE_DISABLE_COMPILE_CACHE, and under NODE_COMPILE_CACHE,
 * where Node has already enabled the cache in the operator's directory.
 */
export function enableCompileCacheIn(
  dir: string,
  enable: EnableCompileCache | null = nodeEnable ?? null,
): boolean {
  if (enable === null) return false;
  if (process.env.NODE_DISABLE_COMPILE_CACHE || process.env.NODE_COMPILE_CACHE) return false;
  try {
    ensureDir(dir);
    accessSync(dir, constants.W_OK);
    enable(dir);
    return true;
  } catch {
    return false;
  }
}
