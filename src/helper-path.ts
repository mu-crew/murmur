import { accessSync, constants, statSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { delimiter, isAbsolute } from "node:path";

// Node uses this Unix search path when the child environment has no PATH.
const DEFAULT_PATH = "/usr/bin:/bin";
type Lookup = { executable: string } | { code: "ENOENT" | "EACCES" };
const cache = new Map<string, { executable: string }>();
let searchPath: string | undefined;
let searchCwd: string | undefined;
let directories: string[] = [];

function currentDirectory(): string | undefined {
  try {
    return process.cwd();
  } catch {
    // A deleted working directory: relative paths cannot resolve, as in the kernel.
    return undefined;
  }
}

function probe(candidate: string): Lookup | null {
  try {
    const stat = statSync(candidate, { throwIfNoEntry: false });
    if (!stat) return null;
    if (!stat.isFile()) return { code: "EACCES" };
    accessSync(candidate, constants.X_OK);
    return { executable: candidate };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EACCES" ? { code: "EACCES" } : null;
  }
}

function lookup(file: string, path: string): Lookup {
  if (isAbsolute(file)) return { executable: file };
  if (file.includes("/")) {
    const cwd = currentDirectory();
    return cwd === undefined ? { code: "ENOENT" } : { executable: `${cwd}/${file}` };
  }
  // The cwd only matters when PATH has a relative (or empty) entry.
  const relative = path.split(delimiter).some((dir) => !isAbsolute(dir));
  const cwd = relative ? (currentDirectory() ?? null) : "";
  const cwdKey = cwd ?? undefined;
  if (path !== searchPath || (cwdKey ?? "\0") !== searchCwd) {
    searchPath = path;
    searchCwd = cwdKey ?? "\0";
    // Do not normalize `..`: the kernel resolves it after following symlinks.
    directories = path
      .split(delimiter)
      .flatMap((dir) =>
        isAbsolute(dir) ? [dir] : cwd === null ? [] : [dir ? `${cwd}/${dir}` : cwd],
      );
    cache.clear();
  }
  const cached = cache.get(file);
  const hit = cached && probe(cached.executable);
  if (hit && "executable" in hit) return hit;
  cache.delete(file);

  // Misses are not cached: a helper installed later is found without a restart.
  let result: Lookup = { code: "ENOENT" };
  for (const dir of directories) {
    const candidate = `${dir}${dir.endsWith("/") ? "" : "/"}${file}`;
    const found = probe(candidate);
    if (!found) continue;
    result = found;
    if ("executable" in found) {
      cache.set(file, found);
      break;
    }
  }
  return result;
}

/** Reuse a still-executable match while PATH and the search cwd stay the same. */
export function findHelper(file: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const result = lookup(file, env.PATH ?? DEFAULT_PATH);
  return "executable" in result ? result.executable : null;
}

export function helperPath(file: string): string {
  const path = process.env.PATH ?? DEFAULT_PATH;
  const result = lookup(file, path);
  if ("executable" in result) return result.executable;
  const { code } = result;
  throw Object.assign(new Error(`spawn ${file} ${code} (PATH=${path})`), {
    code,
    errno: -osConstants.errno[code],
    path: file,
    syscall: `spawn ${file}`,
  });
}
