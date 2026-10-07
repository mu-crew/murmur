import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import module from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { enableCompileCacheIn } from "../src/compile-cache.js";
import { ensureDir } from "../src/dirs.js";
import { builtArtifact } from "./helpers/built.js";

const hasCompileCache = typeof module.enableCompileCache === "function";
const hasProc = existsSync("/proc/self");

/** The test env minus anything that would enable or disable the cache for us. */
function cacheEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.NODE_DISABLE_COMPILE_CACHE;
  delete env.NODE_COMPILE_CACHE;
  return env;
}

function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [builtArtifact("cli.js"), ...args], {
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
}

/**
 * `dist/cli.js` turns on Node's module compile cache before it loads the
 * program, so each invocation skips recompiling the bundle. Node before 22.8
 * has no `module.enableCompileCache`, so there is nothing to assert there.
 */
test.skipIf(!hasCompileCache)("the CLI enables the compile cache under the state dir", () => {
  const state = mkdtempSync(join(tmpdir(), "murmur-cc-"));
  const result = runCli(
    ["--version"],
    cacheEnv({ NODE_DEBUG_NATIVE: "COMPILE_CACHE", MURMUR_STATE_DIR: state }),
  );
  expect(result.status).toBe(0);
  expect(result.stderr).toContain("[compile cache]");
  expect(readdirSync(join(state, "compile-cache")).length).toBeGreaterThan(0);
});

test("ensureDir creates nested missing parents", () => {
  const root = mkdtempSync(join(tmpdir(), "murmur-dirs-"));
  const dir = join(root, "a", "b", "c");
  ensureDir(dir);
  ensureDir(dir);
  expect(existsSync(dir)).toBe(true);
});

test("ensureDir creates 40 missing components, like recursive mkdir", () => {
  const root = mkdtempSync(join(tmpdir(), "murmur-dirs-"));
  const dir = join(root, ...Array.from({ length: 40 }, () => "a"));
  ensureDir(dir);
  expect(statSync(dir).isDirectory()).toBe(true);
});

test("ensureDir throws when a path component is a file", () => {
  const root = mkdtempSync(join(tmpdir(), "murmur-dirs-"));
  writeFileSync(join(root, "file"), "");
  expect(() => ensureDir(join(root, "file", "x"))).toThrow(/not a directory/);
});

/**
 * Node's recursive mkdir spins forever at 100% CPU under /proc, where mkdir
 * keeps answering ENOENT. ensureDir must fail promptly instead.
 */
test.skipIf(!hasProc)("ensureDir fails fast under /proc", () => {
  const start = Date.now();
  expect(() => ensureDir("/proc/murmur-nope/x")).toThrow(/cannot create directory/);
  expect(Date.now() - start).toBeLessThan(1000);
});

test("enableCompileCacheIn skips an unusable dir, a missing API and a throwing API", () => {
  const root = mkdtempSync(join(tmpdir(), "murmur-cc-"));
  const calls: string[] = [];
  const enable = (dir: string) => calls.push(dir);
  const saved = { ...process.env };
  delete process.env.NODE_DISABLE_COMPILE_CACHE;
  delete process.env.NODE_COMPILE_CACHE;
  try {
    writeFileSync(join(root, "file"), "");
    expect(enableCompileCacheIn(join(root, "file", "cc"), enable)).toBe(false);
    expect(enableCompileCacheIn(join(root, "cc"), null)).toBe(false);
    expect(
      enableCompileCacheIn(join(root, "cc"), () => {
        throw new Error("boom");
      }),
    ).toBe(false);
    if (process.getuid?.() !== 0) {
      const ro = join(root, "ro");
      ensureDir(ro);
      chmodSync(ro, 0o500);
      expect(enableCompileCacheIn(join(ro, "cc"), enable)).toBe(false);
    }
    expect(enableCompileCacheIn(join(root, "ok", "cc"), enable)).toBe(true);
    expect(calls).toEqual([join(root, "ok", "cc")]);
    process.env.NODE_COMPILE_CACHE = join(root, "theirs");
    expect(enableCompileCacheIn(join(root, "off"), enable)).toBe(false);
    delete process.env.NODE_COMPILE_CACHE;
    process.env.NODE_DISABLE_COMPILE_CACHE = "1";
    expect(enableCompileCacheIn(join(root, "off"), enable)).toBe(false);
    expect(existsSync(join(root, "off"))).toBe(false);
  } finally {
    process.env = saved;
  }
});

test.skipIf(!hasProc)("a TMPDIR under /proc does not hang the CLI", () => {
  for (const args of [["--version"], ["status"]]) {
    const start = Date.now();
    const result = runCli(args, cacheEnv({ TMPDIR: "/proc/murmur-nope" }));
    // A spin shows up as the spawn timeout (result.error) or the time bound.
    // `status` exits 1 on an uninitialised node; only the hang matters here.
    expect(result.error).toBeUndefined();
    expect(Date.now() - start).toBeLessThan(5000);
    if (args[0] === "--version") expect(result.status).toBe(0);
    else expect(result.stderr).toContain("murmur init");
  }
});

test.skipIf(!hasProc)("a state dir under /proc fails fast with a clear error", () => {
  for (const args of [["--version"], ["init"], ["peer", "list"]]) {
    const start = Date.now();
    const result = runCli(args, cacheEnv({ MURMUR_STATE_DIR: "/proc/murmur-nope/state" }));
    expect(result.error).toBeUndefined();
    expect(Date.now() - start).toBeLessThan(5000);
    if (args[0] === "--version") expect(result.status).toBe(0);
    else {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("cannot create directory /proc/murmur-nope/state");
    }
  }
});
