import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { loadIdentity } from "../src/identity.js";
import type { InboxEvent } from "../src/inbox-event.js";
import { inboxDir, inboxKey, remoteDir, writeInboxEvent } from "../src/inbox-file.js";
import { homeStateDir, legacyStateDir, stateDir } from "../src/paths.js";
import { openStore } from "../src/store.js";
import { builtArtifact } from "./helpers/built.js";

/**
 * The move to `murmur2` and the first-run migration from a 1.x directory.
 *
 * 1.5.2 reads schema 9 and refuses any store from 10 up, so 2.x keeps its own
 * directory. Its first run copies the host's identity and the old store's peers
 * and never writes a byte in the old directory: a 1.x murmur (an older pi
 * extension, say) keeps working beside it.
 */

const IDENTITY = { host_id: "1d2ee96e-3a94-41b2-90fa-5f1ee2f04276", display_name: "box" };

let home: string;
const saved: Record<string, string | undefined> = {};
const VARS = ["HOME", "MURMUR_STATE_DIR", "XDG_STATE_HOME"] as const;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "murmur-legacy-home-"));
  for (const name of VARS) saved[name] = process.env[name];
  // The default directories, under a home that is a temp dir: never the real one.
  process.env.HOME = home;
  delete process.env.MURMUR_STATE_DIR;
  delete process.env.XDG_STATE_HOME;
});

afterEach(() => {
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  rmSync(home, { recursive: true, force: true });
});

/**
 * A 1.5.2 state directory: its identity, and a schema-9 store in WAL mode whose
 * last peer is still in the `-wal`, as a running 1.x murmur leaves it.
 */
function legacyDir(dir: string, version = 9): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "identity.json"), `${JSON.stringify(IDENTITY, null, 2)}\n`);
  const db = new Database(join(dir, "state.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("wal_autocheckpoint = 0");
  db.exec(`CREATE TABLE peers (
    name TEXT NOT NULL PRIMARY KEY, target TEXT NOT NULL, jump_command TEXT NOT NULL,
    host_id TEXT, display_name TEXT, snapshot TEXT, snapshot_at INTEGER, fetched_at INTEGER,
    last_attempt_at INTEGER, last_error TEXT, murmur_version TEXT, snapshot_version INTEGER
  ) STRICT`);
  db.pragma(`user_version = ${version}`);
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.prepare(
    "INSERT INTO peers (name, target, jump_command, host_id, snapshot) VALUES (?, ?, ?, ?, ?)",
  ).run("devbox", "me@devbox", "ssh -t me@devbox", "abc", "{}");
  // Left in the WAL: the copy must carry it.
  db.prepare("INSERT INTO peers (name, target, jump_command) VALUES (?, ?, ?)").run(
    "laptop",
    "laptop.lan",
    "ssh -t laptop.lan",
  );
  // Closing a WAL database checkpoints and deletes the `-wal`; a 1.x murmur
  // that is still running keeps it. Copied aside and back to keep it.
  const wal = readFileSync(join(dir, "state.db-wal"));
  const main = readFileSync(join(dir, "state.db"));
  db.close();
  writeFileSync(join(dir, "state.db"), main);
  writeFileSync(join(dir, "state.db-wal"), wal);
  rmSync(join(dir, "state.db-shm"), { force: true });
}

/** Every file in `dir` with a hash of its bytes: what "never written" means. */
function fingerprint(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    out[name] = createHash("sha256")
      .update(readFileSync(join(dir, name)))
      .digest("hex");
  }
  return out;
}

test("the state lives in murmur2; the inbox and remote area under HOME whatever XDG says", () => {
  expect(stateDir()).toBe(join(home, ".local", "state", "murmur2"));
  expect(homeStateDir()).toBe(join(home, ".local", "state", "murmur2"));
  expect(legacyStateDir()).toBe(join(home, ".local", "state", "murmur"));

  const env = { XDG_STATE_HOME: "/xdg" };
  expect(stateDir(env, "/home/u")).toBe("/xdg/murmur2");
  // Muse's hooks keep HOME and lose XDG_STATE_HOME: the inbox cannot follow it.
  expect(homeStateDir(env, "/home/u")).toBe("/home/u/.local/state/murmur2");
  expect(legacyStateDir(env, "/home/u")).toBe("/xdg/murmur");

  // An explicit directory moves everything and migrates nothing into it.
  const pinned = { MURMUR_STATE_DIR: "/pinned", XDG_STATE_HOME: "/xdg" };
  expect(stateDir(pinned, "/home/u")).toBe("/pinned");
  expect(homeStateDir(pinned, "/home/u")).toBe("/pinned");
  expect(legacyStateDir(pinned, "/home/u")).toBeNull();
});

test("the inbox and the remote area stay under HOME when XDG_STATE_HOME points elsewhere", () => {
  // A Muse hook loses XDG_STATE_HOME and a reader keeps it: both must still
  // name one directory, so neither follows it.
  const xdg = join(home, "xdg");
  process.env.XDG_STATE_HOME = xdg;
  const fixed = join(home, ".local", "state", "murmur2");
  expect(stateDir()).toBe(join(xdg, "murmur2"));
  expect(inboxDir()).toBe(join(fixed, "inbox"));
  expect(remoteDir()).toBe(join(fixed, "remote"));

  // Only the two pids place a file; the writer validates nothing else.
  expect(writeInboxEvent({ server_pid: 4242, root_pid: 4343 } as InboxEvent)).toBe(true);
  expect(readdirSync(join(fixed, "inbox", inboxKey(4242, 4343)))).toHaveLength(1);
  expect(() => readdirSync(join(xdg, "murmur2", "inbox"))).toThrow();
});

test("the first run copies the identity and the peers, and never writes the old directory", () => {
  const old = join(home, ".local", "state", "murmur");
  legacyDir(old);
  const before = fingerprint(old);
  expect(Object.keys(before)).toEqual(["identity.json", "state.db", "state.db-wal"]);

  expect(loadIdentity()).toEqual(IDENTITY);
  const store = openStore();
  try {
    const peers = store.peers();
    expect(peers.map((peer) => [peer.name, peer.target, peer.jump_command])).toEqual([
      ["devbox", "me@devbox", "ssh -t me@devbox"],
      ["laptop", "laptop.lan", "ssh -t laptop.lan"],
    ]);
    // Only what a person typed: observed columns start empty, as after a reset.
    expect(peers[0]?.host_id ?? null).toBeNull();
  } finally {
    store.close();
  }

  const fresh = join(home, ".local", "state", "murmur2");
  expect(JSON.parse(readFileSync(join(fresh, "identity.json"), "utf8"))).toEqual(IDENTITY);
  // Byte for byte, and no `-shm` or anything else left behind.
  expect(fingerprint(old)).toEqual(before);
});

test("a second run migrates nothing again: a peer removed in murmur2 stays removed", () => {
  legacyDir(join(home, ".local", "state", "murmur"));
  const first = openStore();
  try {
    expect(first.removePeer("devbox")).toBe(true);
  } finally {
    first.close();
  }
  const second = openStore();
  try {
    expect(second.peers().map((peer) => peer.name)).toEqual(["laptop"]);
  } finally {
    second.close();
  }
});

test("the old directory follows XDG_STATE_HOME, as a 1.x murmur's did", () => {
  const xdg = join(home, "xdg");
  process.env.XDG_STATE_HOME = xdg;
  legacyDir(join(xdg, "murmur"));
  expect(loadIdentity()).toEqual(IDENTITY);
  expect(readdirSync(join(xdg, "murmur2"))).toContain("identity.json");
});

test("an empty store left by a first open that died before its schema still migrates", () => {
  // The file appears before the schema commits. A first open killed in that
  // window leaves `state.db` at user_version 0 with no tables; the next open
  // must still treat the store as new and bring the 1.x peers.
  legacyDir(join(home, ".local", "state", "murmur"));
  const fresh = join(home, ".local", "state", "murmur2");
  mkdirSync(fresh, { recursive: true });
  new Database(join(fresh, "state.db")).close();
  const store = openStore();
  try {
    expect(store.peers().map((peer) => peer.name)).toEqual(["devbox", "laptop"]);
  } finally {
    store.close();
  }
  expect(JSON.parse(readFileSync(join(fresh, "identity.json"), "utf8"))).toEqual(IDENTITY);
});

test("a store from a schema this build cannot read gives no peers, and is left alone", () => {
  const old = join(home, ".local", "state", "murmur");
  legacyDir(old, 99);
  const before = fingerprint(old);
  const store = openStore();
  try {
    expect(store.peers()).toEqual([]);
  } finally {
    store.close();
  }
  expect(fingerprint(old)).toEqual(before);
});

test("an explicit MURMUR_STATE_DIR migrates nothing", () => {
  legacyDir(join(home, ".local", "state", "murmur"));
  process.env.MURMUR_STATE_DIR = join(home, "pinned");
  expect(loadIdentity()).toBeNull();
  const store = openStore();
  try {
    expect(store.peers()).toEqual([]);
  } finally {
    store.close();
  }
});

test("the built CLI migrates on its first command, from the default directories", () => {
  // The whole wiring, in a child whose HOME is a temp dir and which has no
  // MURMUR_STATE_DIR: the defaults are what is under test.
  const old = join(home, ".local", "state", "murmur");
  legacyDir(old);
  const before = fingerprint(old);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.MURMUR_STATE_DIR;
  delete env.XDG_STATE_HOME;
  // `peer remove` opens the store and dials nothing; the peer exists only if
  // the first open brought it over.
  const out = execFileSync(
    process.execPath,
    [builtArtifact("cli.js"), "peer", "remove", "devbox"],
    {
      encoding: "utf8",
      env,
      timeout: 30_000,
    },
  );
  expect(out).toBe("Removed devbox\n");
  const fresh = join(home, ".local", "state", "murmur2");
  expect(readdirSync(fresh)).toEqual(expect.arrayContaining(["identity.json", "state.db"]));
  const db = new Database(join(fresh, "state.db"), { readonly: true });
  try {
    expect(db.prepare("SELECT name FROM peers").all()).toEqual([{ name: "laptop" }]);
  } finally {
    db.close();
  }
  expect(fingerprint(old)).toEqual(before);
});
