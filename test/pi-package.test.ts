import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { isMurmurShimText, migratePi } from "../src/pi-migrate.js";
import { builtArtifact } from "./helpers/built.js";

/**
 * The pi package contract: package.json declares the extension pi loads, the
 * built extension finds its store as a sibling, and `murmur pi migrate` moves
 * only a shim the old `murmur link pi` provably wrote.
 */

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  pi?: Record<string, string[]>;
  files?: string[];
  exports?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

describe("package manifest", () => {
  test("declares exactly the extension pi loads, and ships it", () => {
    expect(pkg.pi).toEqual({ extensions: ["./dist/extension/murmur-pi.js"] });
    expect(pkg.files).toContain("dist");
  });

  test("lists pi as an optional '*' peer and never bundles it", () => {
    const name = "@earendil-works/pi-coding-agent";
    expect(pkg.peerDependencies?.[name]).toBe("*");
    expect(pkg.peerDependenciesMeta?.[name]?.optional).toBe(true);
    expect(pkg.dependencies?.[name]).toBeUndefined();
  });

  test("the built extension imports its store as a sibling, lazily", () => {
    // A relative specifier resolves from wherever pi installed the package; the
    // old bare "@mu-crew/murmur/extension-store" never resolved outside a
    // dependent, which is why `link pi` had to pin it.
    const source = readFileSync(builtArtifact("extension", "murmur-pi.js"), "utf8");
    expect(source).toContain('"./store.js"');
    expect(source).not.toContain("better-sqlite3");
    expect(existsSync(builtArtifact("extension", "store.js"))).toBe(true);
  });

  test("the store the extension loads opens a real store from dist", () => {
    const dir = mkdtempSync(join(tmpdir(), "murmur-pkg-"));
    try {
      const out = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const m = await import(${JSON.stringify(builtArtifact("extension", "store.js"))});
           const s = m.openStore(); s.close(); console.log(typeof m.loadIdentity);`,
        ],
        { encoding: "utf8", env: { ...process.env, MURMUR_STATE_DIR: dir } },
      );
      expect(out.trim()).toBe("function");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // pi also ships as a single-file Bun build, and Bun panics on better-sqlite3's
  // native addon instead of throwing. This runs the built store under Bun: open,
  // claim, write, reopen, and the corrupt-file reset. MURMUR_TEST_BUN names a Bun
  // binary; BUN_BE_BUN lets a Bun-compiled app (such as such a pi build) act as one.
  const bun = process.env.MURMUR_TEST_BUN ?? onPath("bun");
  test.skipIf(bun === null)("the store the extension loads works under Bun", () => {
    const dir = mkdtempSync(join(tmpdir(), "murmur-bun-"));
    const script = join(dir, "probe.mjs");
    writeFileSync(
      script,
      `const m = await import(${JSON.stringify(builtArtifact("extension", "store.js"))});
       const location = { server: { kind: "default" }, session: "$0", window: "@0", pane: "%1",
         session_name: "work", window_name: "w" };
       const meta = { agent_name: "worker-1", pi_session: null, workstream: "ws", role: null,
         cli: "pi", driver: "orchestrated" };
       let s = m.openStore();
       const claim = s.claimAgent({ location, owner_pid: process.pid, meta });
       const refused = s.claimAgent({ location, owner_pid: 1, meta }).outcome;
       const moved = s.setActivity({ agent_id: claim.agent_id, owner_pid: process.pid,
         activity: "running", location });
       s.addPeer("devbox", "devbox");
       s.close();
       s = m.openStore();
       const panes = s.localPanes().length;
       const peers = s.peers().map((p) => p.name).join(",");
       s.close();
       console.log(JSON.stringify({ claimed: claim.outcome, refused, moved, panes, peers }));`,
    );
    const run = () =>
      execFileSync(bun as string, [script], {
        encoding: "utf8",
        env: { ...process.env, MURMUR_STATE_DIR: dir, BUN_BE_BUN: "1" },
      });
    try {
      expect(JSON.parse(run())).toEqual({
        claimed: "claimed",
        refused: "refused",
        moved: true,
        panes: 1,
        peers: "devbox",
      });
      // An unreadable state.db is reset, not fatal, on Bun as on Node.
      writeFileSync(join(dir, "state.db"), "not a database");
      expect(JSON.parse(run()).claimed).toBe("claimed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function onPath(name: string): string | null {
  const found = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
  return found.status === 0 ? found.stdout.trim() : null;
}

describe("murmur pi migrate", () => {
  let home: string;
  const ext = () => join(home, ".pi", "agent", "extensions", "murmur.ts");
  // What released `murmur link pi` versions wrote, byte for byte, rendered from
  // the tagged src/cli/link.ts for an install at /opt/murmur: v0.2.0-v0.2.2 and
  // v0.2.3-v1.4.0 are the only two templates that shipped.
  const FIXTURE = "/opt/murmur/dist/extension/";
  const templates = ["v0.2.0", "v0.2.3"].map((v) =>
    readFileSync(join("test", "fixtures", `link-shim-${v}.txt`), "utf8"),
  );
  const shim = (store: string, entry: string, template = templates[1] ?? "") =>
    template
      .replace(JSON.stringify(`${FIXTURE}store.js`), JSON.stringify(store))
      .replace(JSON.stringify(`${FIXTURE}murmur-pi.js`), JSON.stringify(entry));
  const released = shim(
    "/usr/lib/node_modules/@mu-crew/murmur/dist/extension/store.js",
    "/usr/lib/node_modules/@mu-crew/murmur/dist/extension/murmur-pi.js",
  );

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "murmur-migrate-"));
    mkdirSync(join(home, ".pi", "agent", "extensions"), { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test("recognises every released shim and nothing near it", () => {
    for (const template of templates) expect(isMurmurShimText(template)).toBe(true);
    expect(isMurmurShimText(released)).toBe(true);
    // JSON escaping in the generated paths, as link pi wrote them.
    const odd = shim("/a b/dist/extension/store.js", '/a"b/dist/extension/murmur-pi.js');
    expect(isMurmurShimText(odd)).toBe(true);
    expect(isMurmurShimText(shim("relative/store.js", "/x/dist/extension/murmur-pi.js"))).toBe(
      false,
    );
    expect(isMurmurShimText(shim("/x/dist/extension/store.js", "/x/evil.js"))).toBe(false);
    expect(isMurmurShimText(`${released}console.log(1);\n`)).toBe(false);
  });

  test("reports and changes nothing without apply", () => {
    writeFileSync(ext(), released);
    const r = migratePi({ home });
    expect(r).toMatchObject({ state: "shim", moved: false });
    expect(existsSync(ext())).toBe(true);
    expect(r.guidance.join(" ")).toContain("--apply");
  });

  test("moves the shim out of discovery, to a name pi never loads", () => {
    writeFileSync(ext(), released);
    const r = migratePi({ home, apply: true });
    expect(r.moved).toBe(true);
    expect(existsSync(ext())).toBe(false);
    const to = r.to ?? "";
    expect(to.startsWith(join(home, ".pi", "agent", "disabled"))).toBe(true);
    expect(to.endsWith(".ts")).toBe(false);
    expect(readFileSync(to, "utf8")).toBe(released);
    expect(r.guidance.join(" ")).toMatch(/\/reload/);

    // A second parked shim never overwrites the first.
    writeFileSync(ext(), released);
    expect(migratePi({ home, apply: true }).to).toBe(`${to}.1`);
  });

  test("never touches a --copy install, an edited shim or a symlink", () => {
    writeFileSync(ext(), "export default function () {}\n");
    expect(migratePi({ home, apply: true })).toMatchObject({ state: "foreign", moved: false });
    expect(existsSync(ext())).toBe(true);

    rmSync(ext());
    const target = join(home, "shim.ts");
    writeFileSync(target, released);
    symlinkSync(target, ext());
    expect(migratePi({ home, apply: true })).toMatchObject({ state: "foreign", moved: false });
  });

  test("the CLI reads MURMUR_PI_HOME, prints JSON, and reports a failed move without a trace", () => {
    writeFileSync(ext(), released);
    const env = { ...process.env, MURMUR_PI_HOME: home };
    const cli = builtArtifact("cli.js");
    const report = JSON.parse(
      execFileSync(process.execPath, [cli, "pi", "migrate", "--json"], { env, encoding: "utf8" }),
    );
    expect(report).toMatchObject({ path: ext(), state: "shim", moved: false });

    // A destination it cannot write: the shim stays, the error is one line.
    const disabled = join(home, ".pi", "agent", "disabled");
    mkdirSync(disabled);
    chmodSync(disabled, 0o555);
    try {
      const run = spawnSync(process.execPath, [cli, "pi", "migrate", "--apply"], {
        env,
        encoding: "utf8",
      });
      expect(run.status).toBe(1);
      expect(run.stderr).toMatch(/^murmur: EACCES/);
      expect(run.stderr).not.toContain("    at ");
      expect(existsSync(ext())).toBe(true);
    } finally {
      chmodSync(disabled, 0o755);
    }

    const moved = JSON.parse(
      execFileSync(process.execPath, [cli, "pi", "migrate", "--apply", "--json"], {
        env,
        encoding: "utf8",
      }),
    );
    expect(moved).toMatchObject({ state: "shim", moved: true });
    expect(existsSync(ext())).toBe(false);
  });

  test("absent is absent", () => {
    expect(migratePi({ home, apply: true })).toMatchObject({ state: "absent", moved: false });
  });
});
