import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { dbPath } from "../src/paths.js";
import { status } from "../src/status.js";
import { openStore, type Store, StoreTooNewError } from "../src/store.js";
import {
  type Location,
  type PaneState,
  type SeenPane,
  SNAPSHOT_VERSION,
  type TmuxServer,
} from "../src/types.js";
import { builtArtifact } from "./helpers/built.js";
import { recordedPanes } from "./helpers/panes.js";

/**
 * The store holds what the multiplexer cannot remember for murmur, and nothing
 * else: since when each live pane has held its state, which panes vanished
 * mid-work (`crashed`), which alerts have fired, and the peer cache. Every
 * test here is a claim about one of those, or about opening the file safely.
 */

const stores: Store[] = [];

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-store-"));
});

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // Already closed by the test.
    }
  }
});

function store(): Store {
  const opened = openStore();
  stores.push(opened);
  return opened;
}

const DEFAULT: TmuxServer = { kind: "default" };

function location(pane = "%1", over: Partial<Location> = {}): Location {
  return {
    server: DEFAULT,
    session: asSessionId("$0"),
    window: asWindowId("@0"),
    pane: asPaneId(pane),
    session_name: "work",
    window_name: "worker-1",
    ...over,
  };
}

/** One pane as a collect saw it. */
function seen(pane: string, state: PaneState, over: Partial<SeenPane> = {}): SeenPane {
  return {
    ...location(pane),
    state,
    state_time: null,
    agent_name: "worker-1",
    workstream: "murmur",
    role: "implementer",
    driver: "orchestrated",
    harness: "pi",
    cli: "pi",
    pane_title: null,
    ...over,
  };
}

// --- local memory ----------------------------------------------------------

test("a state that holds keeps its age; a changed one is news at this collect", () => {
  const s = store();
  const first = s.syncLocal([{ server: DEFAULT, panes: [seen("%1", "running")] }], 1_000);
  expect(first.since.get(`default\0\0%1`)).toBe(1_000);

  const held = s.syncLocal([{ server: DEFAULT, panes: [seen("%1", "running")] }], 2_000);
  expect(held.since.get(`default\0\0%1`)).toBe(1_000);

  const changed = s.syncLocal([{ server: DEFAULT, panes: [seen("%1", "done")] }], 3_000);
  expect(changed.since.get(`default\0\0%1`)).toBe(3_000);
});

test("the multiplexer's own state time wins over murmur's sighting", () => {
  // `pane_program_state_time` is when the program changed state, which is
  // what an alert's age and a sort should read -- not when murmur noticed.
  const s = store();
  const sync = s.syncLocal(
    [{ server: DEFAULT, panes: [seen("%1", "blocked", { state_time: 500 })] }],
    9_000,
  );
  expect(sync.since.get(`default\0\0%1`)).toBe(500);
});

test("a crash is news when first seen, not when the program last reported", () => {
  // The pane sat in `error` since 500; it dying at 9_000 is a new alert.
  const s = store();
  s.syncLocal([{ server: DEFAULT, panes: [seen("%1", "error", { state_time: 500 })] }], 1_000);
  const crash = seen("%1", "crashed", { state_time: 500 });
  const first = s.syncLocal([{ server: DEFAULT, panes: [crash] }], 9_000);
  expect(first.since.get(`default\0\0%1`)).toBe(9_000);
  const again = s.syncLocal([{ server: DEFAULT, panes: [crash] }], 12_000);
  expect(again.since.get(`default\0\0%1`)).toBe(9_000);
});

test("a pane still on the server that drops out of the listing did not crash", () => {
  const s = store();
  s.syncLocal([{ server: DEFAULT, panes: [seen("%1", "running")] }], 1_000);
  const sync = s.syncLocal([{ server: DEFAULT, panes: [], live: new Set(["%1"]) }], 2_000);
  expect(sync.crashed).toEqual([]);
  expect(s.localPanes()).toEqual([]);
});

test.each<[PaneState, boolean]>([
  ["running", true],
  ["waiting", true],
  ["blocked", true],
  ["done", false],
  ["idle", false],
  ["error", false],
  ["crashed", false],
])("a pane that vanishes while %s crashed: %s", (state, crashed) => {
  // Mid-work is a crash murmur must remember, since the multiplexer has
  // nothing left to say about the pane; at rest it simply finished.
  const s = store();
  s.syncLocal([{ server: DEFAULT, panes: [seen("%1", state, { driver: "human" })] }], 1_000);
  const sync = s.syncLocal([{ server: DEFAULT, panes: [] }], 2_000);
  expect(sync.crashed).toEqual(crashed ? ["%1"] : []);
  expect(s.localPanes()).toHaveLength(crashed ? 1 : 0);
});

test.each<[string, TmuxServer | { kind: "rex" }, string]>([
  ["tmux", DEFAULT, "%1"],
  ["rex", { kind: "rex" }, "block:01a21c8c-0000-7000-8000-000000000001"],
])("a %s crew pane mu closes mid-work is no crash; a human one still is", (_, server, pane) => {
  // mu closes workers and delegates while their OSC 7501 state still says
  // working, and tracks its own agents dying; only a human pane crashes here.
  const s = store();
  const other = pane.replace(/1$/, "2");
  s.syncLocal(
    [
      {
        server: server as TmuxServer,
        panes: [
          seen(pane, "running", {
            server: server as TmuxServer,
            driver: "orchestrated",
            role: "worker",
          }),
          seen(other, "running", {
            server: server as TmuxServer,
            driver: "human",
            agent_name: null,
            workstream: null,
          }),
        ],
      },
    ],
    1_000,
  );
  const sync = s.syncLocal([{ server: server as TmuxServer, panes: [] }], 2_000);
  expect(sync.crashed).toEqual([other]);
});

test("a Rex orchestrator's crash is skipped today: Rex panes have role null", () => {
  // Known gap until rex-mu-role-parity populates role in src/rex.ts; with
  // role "orchestrator" on the record the crash is recorded (see the tmux case).
  const server = { kind: "rex" } as unknown as TmuxServer;
  const pane = "block:01a21c8c-0000-7000-8000-000000000001";
  const s = store();
  s.syncLocal(
    [{ server, panes: [seen(pane, "running", { server, driver: "orchestrated", role: null })] }],
    1_000,
  );
  expect(s.syncLocal([{ server, panes: [] }], 2_000).crashed).toEqual([]);
});

test("a crash carries the identity the pane was last seen with", () => {
  const s = store();
  s.syncLocal(
    [
      {
        server: DEFAULT,
        panes: [seen("%1", "waiting", { pane_title: "Fix auth", role: "orchestrator" })],
      },
    ],
    1_000,
  );
  s.syncLocal([{ server: DEFAULT, panes: [] }], 2_000);

  expect(s.localPanes()).toEqual([
    {
      ...location("%1"),
      agent: {
        activity: "stopped",
        agent_name: "worker-1",
        workstream: "murmur",
        role: "orchestrator",
        driver: "orchestrated",
        cli: "pi",
        harness: "pi",
        pane_title: "Fix auth",
        title: null,
        message: null,
        progress: null,
        blocked_kind: null,
        pending: null,
        resume_command: null,
        resume_cwd: null,
        cwd: null,
        updated_at: 2_000,
      },
      attention: [
        {
          kind: "crashed",
          message: "pane vanished while waiting",
          source: "murmur",
          driver: "orchestrated",
          requested_at: 2_000,
        },
      ],
    },
  ]);
});

test("a crash is recorded once, and its age is when it was first seen", () => {
  const s = store();
  s.syncLocal([{ server: DEFAULT, panes: [seen("%1", "running", { driver: "human" })] }], 1_000);
  expect(s.syncLocal([{ server: DEFAULT, panes: [] }], 2_000).crashed).toEqual(["%1"]);
  // Gone is gone: a second empty read concludes nothing new.
  expect(s.syncLocal([{ server: DEFAULT, panes: [] }], 3_000).crashed).toEqual([]);
  s.recordCrash(location("%1"), 4_000);
  expect(s.localPanes().map((pane) => pane.attention[0]?.requested_at)).toEqual([2_000]);
});

test("a server that cannot be asked is no evidence, and changes nothing", () => {
  // A null read is a timeout or a permission error, not "no panes": treating
  // it as empty would paint every agent on the server `crashed`.
  const s = store();
  s.syncLocal([{ server: DEFAULT, panes: [seen("%1", "running")] }], 1_000);
  expect(s.syncLocal([{ server: DEFAULT, panes: null }], 2_000).crashed).toEqual([]);
  expect(s.localPanes()).toEqual([]);
  // And the sighting survives it, with its age.
  const back = s.syncLocal([{ server: DEFAULT, panes: [seen("%1", "running")] }], 3_000);
  expect(back.since.get(`default\0\0%1`)).toBe(1_000);
});

test("each server is its own namespace, and a server seen once is asked again", () => {
  // Pane ids are unique per server: `%1` on mule is not `%1` on default.
  const s = store();
  const mule: TmuxServer = { kind: "label", value: "mule" };
  s.syncLocal(
    [
      { server: DEFAULT, panes: [seen("%1", "running", { driver: "human" })] },
      { server: mule, panes: [seen("%1", "running", { server: mule, driver: "human" })] },
    ],
    1_000,
  );
  expect(s.knownServers()).toEqual([DEFAULT, mule]);

  const sync = s.syncLocal([{ server: mule, panes: [] }], 2_000);
  expect(sync.crashed).toEqual(["%1"]);
  expect(s.localPanes().map((pane) => pane.server)).toEqual([mule]);
  // Default was not asked this time, so its pane is still a sighting.
  expect(s.knownServers()).toEqual([DEFAULT]);
});

test("a live pane at a crashed address is a new occupant, and clears the crash", () => {
  const s = store();
  s.recordCrash(location("%1"), 1_000);
  s.syncLocal([{ server: DEFAULT, panes: [seen("%1", "idle")] }], 2_000);
  expect(s.localPanes()).toEqual([]);
});

test("acknowledging dismisses one pane's crash on one server, and nothing else", () => {
  const s = store();
  const mule: TmuxServer = { kind: "label", value: "mule" };
  s.recordCrash(location("%1"));
  s.recordCrash(location("%1", { server: mule }));
  s.recordCrash({ ...location("block:9"), server: { kind: "rex" } });

  expect(s.acknowledgePane({ server: mule, pane: asPaneId("%1") })).toBe(1);
  expect(s.acknowledgePane({ server: mule, pane: asPaneId("%1") })).toBe(0);
  expect(s.localPanes().map((pane) => pane.server.kind)).toEqual(["default", "rex"]);
});

// --- alert dedup -----------------------------------------------------------

test("each alert key is won once, by whichever process claims it first", () => {
  const s = store();
  const other = store();
  expect(s.claimAlerts(["a", "b"], ["a", "b"], 1_000, 60_000)).toEqual(["a", "b"]);
  expect(other.claimAlerts(["a", "b", "c"], ["a", "b", "c"], 1_001, 60_000)).toEqual(["c"]);
});

test("an old claim is forgotten only once its event is gone", () => {
  // A lagging reader must not re-fire an event still on screen; one that has
  // left can be forgotten, so the table stays small.
  const s = store();
  s.claimAlerts(["a", "b"], ["a", "b"], 1_000, 60_000);
  s.claimAlerts([], ["a"], 100_000, 60_000);
  expect(s.claimAlerts(["a", "b"], ["a", "b"], 100_001, 60_000)).toEqual(["b"]);
});

// --- peers -------------------------------------------------------------------

test("a successful fetch replaces the whole document; a pane absent after is gone", () => {
  const s = store();
  s.addPeer("dev", "dev.example");
  const base = {
    murmur_snapshot: 8 as const,
    host_id: "REMOTE",
    display_name: "dev",
    murmur_version: "9.9.9",
    generated_at: 1_000,
    panes: [],
  };
  s.replacePeerSnapshot("dev", {
    ok: true,
    at: 2_000,
    snapshot: {
      ...base,
      panes: [
        {
          server: { kind: "default" },
          pane: asPaneId("%1"),
          session: asSessionId("$0"),
          window: asWindowId("@0"),
          session_name: null,
          window_name: null,
          agent: null,
          attention: [
            { kind: "done", message: "", source: "pi", driver: "human", requested_at: 1 },
          ],
        },
      ],
    },
  });

  s.replacePeerSnapshot("dev", { ok: true, at: 3_000, snapshot: { ...base, generated_at: 2_500 } });

  const peer = s.peers()[0];
  expect(peer?.snapshot?.panes).toEqual([]);
  // Two clocks, never interchangeable: theirs says when the document was built,
  // ours when we reached them, and freshness reads only ours.
  expect(peer).toMatchObject({
    host_id: "REMOTE",
    display_name: "dev",
    murmur_version: "9.9.9",
    snapshot_version: SNAPSHOT_VERSION,
    snapshot_at: 2_500,
    fetched_at: 3_000,
    last_attempt_at: 3_000,
    last_error: null,
  });
});

test("a failed fetch keeps the previous snapshot and leaves fetched_at alone", () => {
  const s = store();
  s.addPeer("dev", "dev.example");
  s.replacePeerSnapshot("dev", {
    ok: true,
    at: 1_000,
    snapshot: {
      murmur_snapshot: 8,
      host_id: "REMOTE",
      display_name: "dev",
      murmur_version: "1.0.0",
      generated_at: 900,
      panes: [],
    },
  });

  s.replacePeerSnapshot("dev", { ok: false, at: 5_000, error: "Host is down" });

  expect(s.peers()[0]).toMatchObject({
    snapshot: { host_id: "REMOTE" },
    fetched_at: 1_000,
    last_attempt_at: 5_000,
    last_error: "Host is down",
  });
});

test("a new peer defaults to today's ssh attach command", () => {
  const s = store();
  s.addPeer("dev", "dev.example");

  expect(s.peers()[0]?.jump_command).toBe("ssh -t 'dev.example' env LC_CTYPE=C.UTF-8 {attach}");
});

test.each([
  "ssh -t 'dev.example' tmux attach -t ''\\''{pane}'\\'''",
  "ssh -t 'dev.example' env LC_CTYPE=C.UTF-8 tmux attach -t ''\\''{pane}'\\'''",
])("addPeer upgrades a previous generated jump command", (generated) => {
  const s = store();
  s.addPeer("dev", "dev.example", generated);

  s.addPeer("dev", "dev.example");

  expect(s.peers()[0]?.jump_command).toBe("ssh -t 'dev.example' env LC_CTYPE=C.UTF-8 {attach}");
});

test("a stored jump command round-trips", () => {
  const s = store();
  s.addPeer("dev", "dev.example");

  expect(s.setPeerJumpCommand("dev", 'et dev -c "tmux attach -t {pane}"')).toBe(true);
  expect(s.peers()[0]?.jump_command).toBe('et dev -c "tmux attach -t {pane}"');
});

test("a peer's Rex host is set, survives a retarget, and clears", () => {
  const s = store();
  s.addPeer("dev", "dev.example");
  expect(s.peers()[0]?.rex_host).toBeNull();
  expect(s.setPeerRexHost("dev", "me@dev")).toBe(true);
  expect(s.peers()[0]?.rex_host).toBe("me@dev");
  // Human-authored, like the jump command: a corrected target keeps it.
  s.addPeer("dev", "dev2.example");
  expect(s.peers()[0]?.rex_host).toBe("me@dev");
  expect(s.setPeerRexHost("dev", null)).toBe(true);
  expect(s.peers()[0]?.rex_host).toBeNull();
  expect(s.setPeerRexHost("nobody", "x")).toBe(false);
});

test("a 3.0 store (schema 13) upgrades in place: every row kept, compat stamp kept", () => {
  // Additive schema rule: 14 only adds the nullable peers.rex_host and 15 the
  // pane_process cache, so a 3.0.x store is upgraded, never rebuilt, and a
  // 3.0.x build can still open it.
  const s = store();
  s.addPeer("dev", "dev.example");
  s.recordCrash(location());
  s.close();
  const database = new Database(dbPath());
  database.exec("ALTER TABLE peers DROP COLUMN rex_host; DROP TABLE pane_process");
  database.pragma("user_version = 13");
  database.close();

  const reopened = store();
  expect(reopened.localPanes()).toHaveLength(1);
  expect(reopened.setPeerRexHost("dev", "me@dev")).toBe(true);
  expect(reopened.peers()[0]?.rex_host).toBe("me@dev");
  reopened.close();
  const after = new Database(dbPath(), { readonly: true });
  expect(after.pragma("user_version", { simple: true })).toBe(15);
  expect(after.prepare("SELECT compatible_since FROM compat").all()).toEqual([
    { compatible_since: 13 },
  ]);
  after.close();
});

test("a 3.1 store (schema 14) gains the pane_process cache in place", () => {
  const s = store();
  s.addPeer("dev", "dev.example");
  s.close();
  const database = new Database(dbPath());
  database.exec("DROP TABLE pane_process");
  database.pragma("user_version = 14");
  database.close();

  const reopened = store();
  expect(reopened.peers().map((peer) => peer.name)).toEqual(["dev"]);
  const worker = {
    managed: true,
    agent_name: "x",
    workstream: null,
    orchestrator: false,
    harness: null,
  };
  reopened.recordPaneProcess({ kind: "default" }, "%1", "41", worker);
  expect(reopened.paneProcesses({ kind: "default" }).get("%1")).toEqual({
    pid: "41",
    process: worker,
  });
  reopened.close();
  const after = new Database(dbPath(), { readonly: true });
  expect(after.pragma("user_version", { simple: true })).toBe(15);
  expect(after.prepare("SELECT compatible_since FROM compat").all()).toEqual([
    { compatible_since: 13 },
  ]);
  after.close();
});

test("a reset keeps a peer's Rex host along with its name and target", () => {
  const s = store();
  s.addPeer("dev", "dev.example");
  s.setPeerRexHost("dev", "me@dev");
  s.close();
  const database = new Database(dbPath());
  database.exec("DROP TABLE compat");
  database.pragma("user_version = 9");
  database.close();

  expect(store().peers()[0]).toMatchObject({ name: "dev", rex_host: "me@dev" });
});

test("addPeer with the same target keeps the cache and a custom jump command", () => {
  const s = store();
  s.addPeer("dev", "old.example");
  s.replacePeerSnapshot("dev", {
    ok: true,
    at: 1_000,
    snapshot: {
      murmur_snapshot: 8,
      host_id: "REMOTE",
      display_name: "dev",
      murmur_version: "1.0.0",
      generated_at: 900,
      panes: [],
    },
  });

  s.addPeer("dev", "old.example");

  expect(s.peers()[0]).toMatchObject({ target: "old.example", snapshot: { host_id: "REMOTE" } });
  expect(s.removePeer("dev")).toBe(true);
  expect(s.removePeer("dev")).toBe(false);
});

test("addPeer with a new target drops the old node's cache", () => {
  // The new target is unverified: rows cached from the old node must not stay
  // actionable through it (the new node can have the same %N).
  const s = store();
  s.addPeer("dev", "old.example");
  s.replacePeerSnapshot("dev", {
    ok: true,
    at: 1_000,
    snapshot: {
      murmur_snapshot: 8,
      host_id: "REMOTE",
      display_name: "dev",
      murmur_version: "1.0.0",
      generated_at: 900,
      panes: [],
    },
  });

  s.addPeer("dev", "new.example");

  expect(s.peers()[0]).toMatchObject({
    target: "new.example",
    snapshot: null,
    host_id: null,
    fetched_at: null,
  });
});

// --- opening a current store waits on nobody ----------------------------

test("opening a current store does not wait for another connection's write lock", () => {
  // The schema transaction is `.immediate`, so taking it on every open queued
  // each read path -- the picker, the status bar -- behind whichever writer held
  // the lock, for up to busy_timeout. Before the fix this blocked the full 5s
  // and then threw SQLITE_BUSY.
  store().close();
  const writer = new Database(dbPath());
  try {
    writer.exec("BEGIN IMMEDIATE");
    const started = Date.now();
    const opened = store();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(opened.peers()).toEqual([]);
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
  }
});

test("opening a current store does not wait for a reader pinning the WAL", () => {
  // `wal_checkpoint(TRUNCATE)` waits for every reader to leave the WAL. A
  // reader mid-transaction, with frames written after its snapshot, made every
  // open stall for the full busy_timeout.
  store().addPeer("dev", "dev.example");
  const writer = new Database(dbPath());
  const reader = new Database(dbPath());
  try {
    writer.pragma("wal_autocheckpoint = 0");
    reader.exec("BEGIN");
    reader.prepare("SELECT COUNT(*) FROM peers").get();
    writer.prepare("UPDATE peers SET target = 'dev2.example'").run();
    const started = Date.now();
    const opened = store();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(opened.peers().map((peer) => peer.target)).toEqual(["dev2.example"]);
  } finally {
    reader.exec("COMMIT");
    reader.close();
    writer.close();
  }
});

// --- identity and legacy -------------------------------------------------

test("openStore mints no identity", async () => {
  const { loadIdentity } = await import("../src/identity.js");
  expect(loadIdentity()).toBeNull();

  store();

  expect(loadIdentity()).toBeNull();
});

test("an existing database upgrades without losing peers", () => {
  const s = store();
  s.addPeer("dev", "dev.example");
  s.replacePeerSnapshot("dev", {
    ok: true,
    at: 1_000,
    snapshot: {
      murmur_snapshot: 8,
      host_id: "REMOTE",
      display_name: "dev",
      murmur_version: "1.0.0",
      generated_at: 900,
      panes: [],
    },
  });
  s.recordCrash(location());
  s.close();

  const database = new Database(dbPath());
  database.exec("ALTER TABLE peers DROP COLUMN jump_command");
  database.pragma("user_version = 3");
  database.close();

  const reopened = store();

  // The fields a human typed survive; every observed column starts empty,
  // so a never-reached peer cannot render as fresh.
  expect(reopened.peers()).toEqual([
    {
      name: "dev",
      target: "dev.example",
      jump_command: "ssh -t 'dev.example' env LC_CTYPE=C.UTF-8 {attach}",
      host_id: null,
      display_name: null,
      snapshot: null,
      snapshot_at: null,
      fetched_at: null,
      last_attempt_at: null,
      last_error: null,
      murmur_version: null,
      snapshot_version: null,
      rex_host: null,
    },
  ]);
  expect(reopened.localPanes()).toEqual([]);
});

test("a store from a newer murmur is refused and left exactly as it was", () => {
  // Two installs on one machine can run different versions. Rebuilding
  // downward made each side wipe the other's rows on every open; an older
  // build must stay out of the way instead.
  const s = store();
  s.addPeer("dev", "dev.example");
  s.recordCrash(location());
  s.close();
  const database = new Database(dbPath());
  const newer = (database.pragma("user_version", { simple: true }) as number) + 1;
  database.pragma(`user_version = ${newer}`);
  // A newer build that says this one can no longer use its store. One that only
  // added columns keeps the stamp, and is opened: see the next test.
  database.prepare("UPDATE compat SET compatible_since = ?").run(newer);
  database.close();

  expect(() => openStore()).toThrow(StoreTooNewError);
  expect(() => openStore()).toThrow(/newer murmur .*Upgrade this murmur/);

  const after = new Database(dbPath(), { readonly: true });
  expect(after.pragma("user_version", { simple: true })).toBe(newer);
  expect(after.prepare("SELECT COUNT(*) AS n FROM crashed").get()).toEqual({ n: 1 });
  expect(after.prepare("SELECT name FROM peers").all()).toEqual([{ name: "dev" }]);
  after.close();
  // The reset lock is released on the way out, so the next open is not delayed.
  expect(existsSync(`${dbPath()}.reset-lock`)).toBe(false);

  // The CLI says so in one line and a fixed exit code, not a stack trace on
  // every status-bar tick.
  spawnSync(process.execPath, [builtArtifact("cli.js"), "init"], { env: process.env });
  const run = spawnSync(process.execPath, [builtArtifact("cli.js"), "status"], {
    env: process.env,
    encoding: "utf8",
  });
  expect(run.status).toBe(4);
  expect(run.stderr).toMatch(/^murmur: .*newer murmur/);
  expect(run.stderr).not.toContain("    at ");

  const untouched = new Database(dbPath(), { readonly: true });
  expect(untouched.pragma("user_version", { simple: true })).toBe(newer);
  untouched.close();
});

test("a newer store whose compat stamp still includes this build is opened, not refused or reset", () => {
  // The "compatible since" stamp is for the NEXT release: a build that only adds
  // nullable columns bumps user_version and keeps the stamp, and this build must
  // keep working against its store instead of refusing it -- two installs
  // upgrade separately, so either can be the older one for a while.
  const s = store();
  s.addPeer("dev", "dev.example");
  s.syncLocal([{ server: DEFAULT, panes: [seen("%1", "running", { driver: "human" })] }], 1_000);
  s.close();
  const database = new Database(dbPath());
  const ours = database.pragma("user_version", { simple: true }) as number;
  database.pragma(`user_version = ${ours + 1}`);
  database.exec("ALTER TABLE seen ADD COLUMN later_column TEXT");
  database.exec("ALTER TABLE crashed ADD COLUMN later_column TEXT");
  database.close();

  const reopened = store();
  // Kept: no reset discarded the sighting or the peer.
  expect(reopened.peers().map((peer) => peer.name)).toEqual(["dev"]);
  // And usable: a write that names its columns ignores the one it does not know.
  expect(reopened.syncLocal([{ server: DEFAULT, panes: [] }], 2_000).crashed).toEqual(["%1"]);
  expect(reopened.localPanes()).toHaveLength(1);
  reopened.close();
  const after = new Database(dbPath(), { readonly: true });
  expect(after.pragma("user_version", { simple: true })).toBe(ours + 1);
  after.close();
});

test("a 2.x store (schema 12) is rebuilt as 3.0's, keeping only the peers", () => {
  // 2.x kept agent rows, attention and an inbox; 3.0 keeps none of them. The
  // compat stamp says 2.x's file is not ours, so it is reset once.
  const s = store();
  s.addPeer("dev", "dev.example");
  s.close();
  const database = new Database(dbPath());
  database.exec("DROP TABLE seen; CREATE TABLE agents (pane TEXT)");
  database.exec("UPDATE compat SET compatible_since = 10");
  database.pragma("user_version = 12");
  database.close();

  const reopened = store();
  expect(reopened.peers().map((peer) => peer.name)).toEqual(["dev"]);
  reopened.close();
  const after = new Database(dbPath(), { readonly: true });
  expect(after.pragma("user_version", { simple: true })).toBe(15);
  const tables = (
    after.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((row) => row.name);
  expect(tables).toEqual(["alerted", "compat", "crashed", "pane_process", "peers", "seen"]);
  after.close();
});

test("a store from before the compat stamp is reset once, keeping peers", () => {
  // Schema 9 had no stamp. Everything but the peers is re-observed at the
  // next collect, so a reset costs nothing a person typed.
  const s = store();
  s.addPeer("dev", "dev.example");
  s.recordCrash(location());
  s.close();
  const database = new Database(dbPath());
  database.exec("DROP TABLE compat");
  database.pragma("user_version = 9");
  database.close();

  const reopened = store();
  expect(reopened.localPanes()).toEqual([]);
  expect(reopened.peers().map((peer) => peer.name)).toEqual(["dev"]);
  reopened.close();
  const after = new Database(dbPath(), { readonly: true });
  expect(after.prepare("SELECT compatible_since FROM compat").all()).toEqual([
    { compatible_since: 13 },
  ]);
  after.close();
});

test("a corrupt database is rebuilt rather than crashing every command", () => {
  // The whole reset strategy exists for a file murmur cannot use, and this was
  // the one case that did not get it. better-sqlite3's constructor does not READ
  // the file, so a garbage state.db constructs fine and the `user_version`
  // pragma is what throws -- straight through `needsReset`'s catch, which
  // answered "no reset needed" for precisely the file that needed one. Every
  // command that opens the store then died on the same pragma with a raw
  // SqliteError: the status bar on every tick.
  //
  // Nothing here is history, so throwing it away is free. That is exactly the
  // argument the version-mismatch path already makes.
  const s = store();
  s.addPeer("dev", "dev.example");
  s.close();

  // Not a truncated or half-written file: bytes that are definitively not a
  // database, which is what a full disk or a killed write leaves behind.
  writeFileSync(dbPath(), randomBytes(4096));
  for (const suffix of ["-wal", "-shm"]) rmSync(`${dbPath()}${suffix}`, { force: true });

  // The assertion is simply that this does not throw.
  const reopened = store();
  expect(reopened.localPanes()).toEqual([]);
  // Salvage is best-effort and correctly gives up here: an unreadable file has
  // no peer table to read, so the names a human typed are genuinely gone. The
  // claim is that murmur RUNS, not that it recovers data that no longer exists.
  expect(reopened.peers()).toEqual([]);

  // And the rebuilt file is a working store, not merely an opened one.
  reopened.addPeer("bubba", "bubba.example");
  expect(reopened.peers().map((peer) => peer.name)).toEqual(["bubba"]);
});

test("a rebuild with nothing to lose stays quiet", () => {
  const warnings: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    warnings.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    const s = store();
    s.addPeer("dev", "dev.example");
    s.close();

    const database = new Database(dbPath());
    database.pragma("user_version = 1");
    database.close();

    store().close();
  } finally {
    process.stderr.write = write;
  }

  // Peers are salvaged, so no agent was lost and there is nothing to report. A
  // warning on every fresh upgrade would be noise that teaches people to ignore
  // the one that matters.
  expect(warnings.join("")).toBe("");
});

test("openStore({ readonly: true }) reads an existing store and refuses writes", () => {
  const s = store();
  s.addPeer("dev", "dev.example");
  s.recordCrash(location());
  s.close();

  const reader = openStore({ readonly: true });
  stores.push(reader);
  expect(reader.peers().map((peer) => peer.name)).toEqual(["dev"]);
  expect(reader.localPanes()).toHaveLength(1);
  expect(() => reader.addPeer("other", "other.example")).toThrow(/readonly/i);
  expect(reader.peers()).toHaveLength(1);
});

test("a readonly open of a missing store throws and creates nothing", () => {
  expect(() => openStore({ readonly: true })).toThrow();
  expect(existsSync(dbPath())).toBe(false);
});

test("a readonly open of a newer murmur's store throws StoreTooNewError", () => {
  store().close();
  const database = new Database(dbPath());
  const newer = (database.pragma("user_version", { simple: true }) as number) + 1;
  database.pragma(`user_version = ${newer}`);
  database.prepare("UPDATE compat SET compatible_since = ?").run(newer);
  database.close();

  expect(() => openStore({ readonly: true })).toThrow(StoreTooNewError);
});

test("a readonly open of an older schema throws instead of migrating", () => {
  store().close();
  const database = new Database(dbPath());
  database.pragma("user_version = 1");
  database.close();

  expect(() => openStore({ readonly: true })).toThrow(/read-write/);
  const after = new Database(dbPath(), { readonly: true });
  expect(after.pragma("user_version", { simple: true })).toBe(1);
  after.close();
});

test("status() reads through a readonly store", () => {
  const s = store();
  s.recordCrash(location());
  s.close();

  const reader = openStore({ readonly: true });
  stores.push(reader);
  const view = status(
    reader,
    { host_id: "HOST", display_name: "host" },
    recordedPanes(reader),
    Date.now(),
    () => false,
  );
  expect(view.panes.length).toBe(1);
});
