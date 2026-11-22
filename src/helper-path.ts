import { accessSync, constants, statSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { delimiter, isAbsolute } from "node:path";

// Node uses this Unix search path when the child environment has no PATH.
const DEFAULT_PATH = "/usr/bin:/bin";
type Lookup = { executable: string } | { code: "ENOENT" | "EACCES" };
const cache = new Map<string, Lookup>();
let searchPath: string | undefined;
let searchCwd: string | undefined;
let directories: string[] = [];

function lookup(file: string, path: string): Lookup {
  if (isAbsolute(file)) return { executable: file };
  const cwd = process.cwd();
  if (file.includes("/")) return { executable: `${cwd}/${file}` };
  if (path !== searchPath || cwd !== searchCwd) {
    searchPath = path;
    searchCwd = cwd;
    // Do not normalize `..`: the kernel resolves it after following symlinks.
    directories = path
      .split(delimiter)
      .map((dir) => (isAbsolute(dir) ? dir : dir ? `${cwd}/${dir}` : cwd));
    cache.clear();
  }
  const cached = cache.get(file);
  if (cached) return cached;

  let result: Lookup = { code: "ENOENT" };
  for (const dir of directories) {
    const candidate = `${dir}${dir.endsWith("/") ? "" : "/"}${file}`;
    try {
      const stat = statSync(candidate, { throwIfNoEntry: false });
      if (!stat) continue;
      if (!stat.isFile()) {
        result = { code: "EACCES" };
        continue;
      }
      accessSync(candidate, constants.X_OK);
      result = { executable: candidate };
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EACCES") result = { code: "EACCES" };
    }
  }
  cache.set(file, result);
  return result;
}

/** Resolve on first use, then reuse the path unless PATH or the working directory changes. */
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
