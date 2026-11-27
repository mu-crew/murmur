import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { NodeIdentity } from "../src/identity.js";
import { buildSnapshot } from "../src/local.js";
import type { Mux } from "../src/mux.js";
import { dbPath } from "../src/paths.js";
import { readRex } from "../src/rex.js";
import { localStatus, readStatus, statusJson } from "../src/status.js";
import { openStore, type Store } from "../src/store.js";
import { vtmuxMux, vtmuxRow } from "./helpers/panes.js";
import { type FakeBlock, rexWalk } from "./helpers/rex.js";

/**
 * `readStatus` is `status --json --cached` for an SDK reader holding a
 * read-only store: the same panes, with nothing written.
 */

const IDENTITY: NodeIdentity = { host_id: "LOCAL", display_name: "here" };
const opened: Store[] = [];

function open(readonly = false): Store {
  const store = openStore({ readonly });
  opened.push(store);
  return store;
}

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-read-status-"));
});

afterEach(() => {
  for (const store of opened.splice(0)) store.close();
});

const working = (app = "pi"): FakeBlock => ({
  status: { records: [{ state: "working", app }] },
  process: { child: { name: app } },
});

/** One local fixture: tmux rows and Rex blocks, read the way the CLI reads them. */
function fixture(rows: string[][], blocks: Record<string, FakeBlock>) {
  const { call } = rexWalk([{ session_id: "s-1", label: "work", blocks }]);
  const mux: Mux = vtmuxMux(rows, {
    // A runtime-hosted harness: the process read a writable read caches.
    paneProcess: () => ({
      managed: false,
      agent_name: null,
      workstream: null,
      orchestrator: false,
      harness: "pi",
    }),
  });
  return { mux, rex: () => readRex(call), cached: true };
}

const before = fixture(
  [
    vtmuxRow({ pane: "%1", state: "working", app: "pi" }),
    vtmuxRow({
      pane: "%2",
      state: "working",
      app: "pi",
      mu_agent: "boss",
      mu_role: "orchestrator",
    }),
  ],
  { "block:a": working() },
);

// %1 holds its state, %2 vanished mid-work (a crash), %3 and block:b are new.
const after = () =>
  fixture(
    [
      vtmuxRow({ pane: "%1", state: "working", app: "pi" }),
      vtmuxRow({ pane: "%3", command: "node", pid: "300" }),
    ],
    { "block:a": working(), "block:b": working("claude") },
  );

function files() {
  const path = dbPath();
  const stat = (file: string) =>
    existsSync(file) ? { mtime: statSync(file).mtimeMs, size: statSync(file).size } : null;
  return { db: stat(path), wal: stat(`${path}-wal`) };
}

async function seed(): Promise<Store> {
  const writer = open();
  await localStatus(writer, IDENTITY, 1_000, before);
  return writer;
}

test("readStatus on a read-only store answers status --json's panes and writes nothing", async () => {
  // The writer stays open, as a dash or status bar would be: its WAL is live.
  const writer = await seed();
  const untouched = files();
  expect(untouched.wal).not.toBeNull();

  const reader = open(true);
  const read = await readStatus(reader, IDENTITY, 2_000, after());
  expect(files()).toEqual(untouched);
  // A second read sees the same memory: nothing was synced the first time.
  expect(await readStatus(reader, IDENTITY, 2_000, after())).toEqual(read);
  expect(files()).toEqual(untouched);

  // What `murmur status --json --cached` prints after the same local read.
  const expected = statusJson(await localStatus(writer, IDENTITY, 2_000, after()));
  expect(read.panes.map(({ recorded: _recorded, ...pane }) => pane)).toEqual(expected.panes);
  expect(read.counts).toEqual(expected.counts);

  const byPane = Object.fromEntries(read.panes.map((pane) => [pane.pane, pane]));
  expect(Object.keys(byPane).sort()).toEqual(["%1", "%2", "%3", "block:a", "block:b"]);
  expect(byPane["%1"]).toMatchObject({ recorded: true, updated_at: 1_000 });
  expect(byPane["block:a"]).toMatchObject({ recorded: true, updated_at: 1_000 });
  expect(byPane["%2"]).toMatchObject({ recorded: true, render_state: "crashed" });
  expect(byPane["%3"]).toMatchObject({ recorded: false, updated_at: 2_000, cli: "pi" });
  expect(byPane["block:b"]).toMatchObject({ recorded: false, updated_at: 2_000 });
});

test("readStatus works with no writer open, and leaves the closed store as it was", async () => {
  (await seed()).close();
  opened.splice(0);
  const untouched = files();

  const reader = open(true);
  const read = await readStatus(reader, IDENTITY, 2_000, after());
  reader.close();
  opened.splice(0);
  // SQLite itself leaves an empty `-wal` behind any open of a WAL database,
  // read-only included; empty means no frame was written.
  const now = files();
  expect(now.db).toEqual(untouched.db);
  expect(untouched.wal).toBeNull();
  expect(now.wal?.size ?? 0).toBe(0);

  const expected = statusJson(await localStatus(open(), IDENTITY, 2_000, after()));
  expect(read.panes.map(({ recorded: _recorded, ...pane }) => pane)).toEqual(expected.panes);
});

test("a recorded crash a live pane reoccupies is gone from the read, as a sync would drop it", async () => {
  const writer = open();
  await localStatus(
    writer,
    IDENTITY,
    1_000,
    fixture([vtmuxRow({ pane: "%1", state: "working" })], {}),
  );
  // %1 vanishes mid-work: recorded as a crash.
  await localStatus(writer, IDENTITY, 2_000, fixture([], {}));
  const reoccupied = fixture([vtmuxRow({ pane: "%1", state: "done", app: "pi" })], {});

  const read = await readStatus(open(true), IDENTITY, 3_000, reoccupied);
  const expected = statusJson(await localStatus(writer, IDENTITY, 3_000, reoccupied));
  expect(read.panes.map(({ recorded: _recorded, ...pane }) => pane)).toEqual(expected.panes);
  expect(read.panes).toEqual([
    expect.objectContaining({ pane: "%1", render_state: "done", recorded: false }),
  ]);
});

test("readStatus probes nothing by default, as status --json --cached does not", async () => {
  const writer = open();
  writer.addPeer("dev", "dev.example");
  const snapshot = buildSnapshot({ host_id: "FAR", display_name: "far" }, [], 1_000);
  writer.replacePeerSnapshot("dev", { ok: true, at: 1_000, snapshot });
  writer.replacePeerSnapshot("dev", {
    ok: false,
    at: 2_000,
    error: "Permission denied (publickey).",
  });
  let probes = 0;
  const warm = () => {
    probes += 1;
    return true;
  };
  const read = await readStatus(open(true), IDENTITY, 3_000, {
    mux: vtmuxMux([]),
    rex: false,
    warm,
  });
  expect(probes).toBe(0);
  expect(read.peers[0]).toMatchObject({ name: "dev", needs_session: true });
});

test("a recorded pane that changed state is still recorded, with a fresh updated_at", async () => {
  const writer = open();
  const at = (state: string) => fixture([vtmuxRow({ pane: "%1", state, app: "pi" })], {});
  await localStatus(writer, IDENTITY, 1_000, at("working"));
  const read = await readStatus(open(true), IDENTITY, 2_000, at("blocked"));
  expect(read.panes).toEqual([
    expect.objectContaining({
      pane: "%1",
      render_state: "blocked",
      recorded: true,
      updated_at: 2_000,
    }),
  ]);
});
