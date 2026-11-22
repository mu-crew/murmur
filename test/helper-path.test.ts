import { spawnSync } from "node:child_process";
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

// Runs `body` in a child whose working directory has been deleted, against the
// bundled helper-path and inbox modules.
function inDeletedCwd(body: string, path: string): { status: number | null; out: string } {
  const bundle = join(dir, "bundle.mjs");
  const entry = join(dir, "entry.ts");
  const root = join(__dirname, "..", "src");
  writeFileSync(
    entry,
    `export * from ${JSON.stringify(join(root, "helper-path.ts"))};\nexport { probeSockets } from ${JSON.stringify(join(root, "inbox.ts"))};\n`,
  );
  const built = spawnSync(
    join(__dirname, "..", "node_modules", ".bin", "esbuild"),
    [
      entry,
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--packages=external",
      `--outfile=${bundle}`,
    ],
    { encoding: "utf8" },
  );
  expect(built.status, built.stderr).toBe(0);
  const doomed = join(dir, "doomed");
  mkdirSync(doomed);
  const script = `import { pathToFileURL } from "node:url";
const m = await import(pathToFileURL(${JSON.stringify(bundle)}).href);
process.chdir(${JSON.stringify(doomed)});
(await import("node:fs")).rmdirSync(${JSON.stringify(doomed)});
${body}`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, PATH: path },
    cwd: dir,
  });
  return { status: r.status, out: r.stdout + r.stderr };
}

test("a deleted working directory does not break resolution through absolute PATH entries", () => {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  shim(join(bin, "tmux"));
  const r = inDeletedCwd(
    `console.log(m.helperPath("tmux"));
console.log(m.findHelper("tmux"));
try { m.helperPath("nope-missing"); } catch (e) { console.log(e.code); }
console.log(JSON.stringify([...m.probeSockets(["/nonexistent-sock"], 200)]));`,
    `relative-entry:${bin}`,
  );
  expect(r.out).toContain(`${bin}/tmux\n${bin}/tmux\nENOENT\n`);
  expect(r.status, r.out).toBe(0);
});

test("a cached miss or vanished hit is looked up again", () => {
  const a = join(dir, "a");
  const b = join(dir, "b");
  mkdirSync(a);
  mkdirSync(b);
  const r = inDeletedCwd(
    `const fs = await import("node:fs");
const sh = '#!/bin/sh\\n';
console.log(m.findHelper("late-tool"));
fs.writeFileSync(${JSON.stringify(join(b, "late-tool"))}, sh, { mode: 0o755 });
console.log(m.findHelper("late-tool"));
fs.writeFileSync(${JSON.stringify(join(a, "late-tool"))}, sh, { mode: 0o755 });
console.log(m.findHelper("late-tool"));
fs.rmSync(${JSON.stringify(join(a, "late-tool"))});
console.log(m.findHelper("late-tool"));`,
    `${a}:${b}`,
  );
  expect(r.out).toBe(
    `null\n${join(b, "late-tool")}\n${join(b, "late-tool")}\n${join(b, "late-tool")}\n`,
  );
});
