import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { spawnRunner } from "../src/agents.js";
import { ssh } from "../src/channel.js";
import { spawnFzf } from "../src/jump-select.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "murmur-helper-test-"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function shim(file: string): void {
  writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "$0"\n`, { mode: 0o755 });
}

function expectExecutable(stdout: string, file: string): void {
  const executable = stdout.trim();
  expect(isAbsolute(executable)).toBe(true);
  expect(realpathSync(executable)).toBe(realpathSync(file));
}

test("local helpers run by absolute path, holding the first match until PATH changes", () => {
  const name = "murmur-test-helper";
  const early = join(dir, "early", name);
  const directory = join(dir, "directory", name);
  const nonexecutable = join(dir, "nonexecutable", name);
  const first = join(dir, "first", name);
  const last = join(dir, "last", name);
  const dirs = [early, directory, nonexecutable, first, last].map((file) => dirname(file));
  for (const entry of dirs) mkdirSync(entry);
  mkdirSync(directory);
  writeFileSync(nonexecutable, "not executable", { mode: 0o644 });
  shim(first);
  shim(last);

  vi.stubEnv("PATH", dirs.map((entry) => relative(process.cwd(), entry)).join(delimiter));
  expectExecutable(spawnRunner(name, []).stdout, first);
  shim(early);
  expectExecutable(spawnRunner(name, []).stdout, first);

  vi.stubEnv("PATH", dirs.join(delimiter));
  expect(spawnRunner(name, []).stdout.trim()).toBe(early);
  expect(spawnRunner(last, []).stdout.trim()).toBe(last);
});

test("missing ssh reports ENOENT with the helper name and PATH, then picks up a new PATH", async () => {
  vi.stubEnv("PATH", dir);
  await expect(ssh.exec("example.invalid", ["murmur", "export"])).rejects.toMatchObject({
    code: "ENOENT",
    path: "ssh",
    message: expect.stringContaining(`PATH=${dir}`),
  });
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const executable = join(bin, "ssh");
  shim(executable);
  vi.stubEnv("PATH", bin);
  expect((await ssh.exec("example.invalid", ["murmur", "export"])).trim()).toBe(executable);
});

test("fzf resolves against the child environment, not the process PATH", () => {
  vi.stubEnv("PATH", dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const executable = join(bin, "fzf");
  shim(executable);
  expectExecutable(spawnFzf([], "", { PATH: relative(process.cwd(), bin) }), executable);
  expect(spawnFzf([], "", { PATH: dir })).toBe("");
});
