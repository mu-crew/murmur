import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { openStore } from "../src/store.js";
import { builtArtifact } from "./helpers/built.js";

/**
 * The local-sync transaction under REAL contention, from separate processes.
 *
 * `syncLocal` is declared `.immediate` and `store.ts` says why: it reads the
 * previous sighting and then writes, so a deferred transaction starts as a READER
 * and must upgrade, and two upgrading at once fail the loser with
 * SQLITE_BUSY_SNAPSHOT -- which no `busy_timeout` can fix, because waiting
 * cannot make a stale snapshot fresh. The incident it records was "5 of 8
 * concurrent writers failing".
 *
 * None of that was tested. Removing `.immediate` left all 342 tests passing,
 * because a single-process suite never contends: SQLite serialises within one
 * connection, so the failure needs separate OS processes and a shared file.
 * `test/helpers/built.ts` even names this test as a reason `dist/` is executed;
 * it just did not exist.
 *
 * This is the pane-ownership pattern (real child processes, one shared state
 * dir) narrowed to the store, with no tmux involved.
 */

let stateDir: string;

const STORE = builtArtifact("index.js");

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "murmur-concurrency-"));
  // Pointed at THIS test's directory, not just handed to the children.
  // `openStore()` in-process reads the environment like everything else, so the
  // seeding below otherwise lands in the suite sandbox that test/setup.ts
  // redirects to -- and the children, which do get `stateDir`, then correctly
  // report no peer. That read as a lost salvage in production and was the test
  // seeding a different database from the one it asserted on.
  process.env.MURMUR_STATE_DIR = stateDir;
});

afterEach(() => {
  // Left on disk deliberately on failure? No: these are large-ish WAL files and
  // the failure output carries everything needed. Cleanup keeps /tmp sane.
  try {
    execFileSync("rm", ["-rf", stateDir]);
  } catch {
    // Best effort.
  }
});

/**
 * One child that opens the store and records one collect: pane `%1` working.
 * Every child in a burst does, so each transaction reads the previous
 * sighting and writes its own, which is the read-then-write that must upgrade.
 *
 * Args are read from `argv[1]` and `argv[2]`, NOT 2 and 3. Under `node -e` there
 * is no script path in argv, so the usual offset is off by one.
 */
const CHILD = `
  const { openStore } = await import(${JSON.stringify(STORE)});
  const store = openStore();
  try {
    store.syncLocal([{
      server: { kind: "default" },
      panes: [{
        server: { kind: "default" },
        session: "$0", window: "@0", pane: process.argv[1],
        session_name: null, window_name: null,
        state: "running", state_time: null,
        agent_name: null, workstream: null, role: null, driver: "human",
        harness: "pi", cli: "pi", pane_title: null,
      }],
    }], Number(process.argv[2]));
    process.stdout.write("OK synced\\n");
  } catch (error) {
    // The code AND the message: a bare code made a harness mistake read as a
    // store failure once already.
    process.stdout.write(
      "ERR " + (error && error.code ? error.code : String(error)) + " :: " + error.message + "\\n",
    );
  } finally {
    store.close();
  }
`;

/** Run the 8-child sync burst against `stateDir`, returning each child's line. */
async function burst(): Promise<string[]> {
  const run = promisify(execFile);
  const settled = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      run(process.execPath, ["--input-type=module", "-e", CHILD, "%1", String(9_000 + index)], {
        encoding: "utf8",
        env: { ...process.env, MURMUR_STATE_DIR: stateDir },
        timeout: 30_000,
      }),
    ),
  );
  return settled.map(({ stdout }) => stdout.trim());
}

/**
 * Failures that are murmur's fault.
 *
 * SQLITE_IOERR_FSTAT is excluded deliberately, and not to make a test pass. It
 * survives the fix at ~1% of children (3 of 240 measured), appears on APFS home
 * as well as /tmp, and is the filesystem failing a stat under a process burst
 * rather than murmur mishandling a lock -- a different bug with a different
 * owner. Folding it in makes these tests flaky against correct code, which is
 * how a suite teaches people to re-run until green.
 */
function realFailures(lines: string[]): string[] {
  return lines.filter((line) => !line.startsWith("OK ") && !line.includes("SQLITE_IOERR"));
}

/** The peer names a FRESH process sees: what actually survived the rebuild. */
function peerNames(): string {
  return execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { openStore } = await import(${JSON.stringify(STORE)});
       const store = openStore();
       process.stdout.write(store.peers().map((peer) => peer.name).join(","));
       store.close();`,
    ],
    { encoding: "utf8", env: { ...process.env, MURMUR_STATE_DIR: stateDir }, timeout: 30_000 },
  );
}

test("eight processes opening a STALE database all create the schema exactly once", async () => {
  // The upgrade burst, which is the deterministic form of the race and the one
  // the design guarantees: a schema bump ships in an npm upgrade, and then the
  // status-bar tick, the dash and every side panel on the machine reopen at
  // once. All of them saw a stale `user_version`, all of them ran `CREATE
  // TABLE`, and the losers threw `table ... already exists` out of a read path.
  //
  // Seeding a stale version makes every child take the create path, so this
  // fires on the first run rather than needing a fresh-directory race to land.
  // Measured before the fix: 23 failures over 20 trials, against 0 after.
  const seed = openStore();
  seed.addPeer("dev", "dev.example");
  seed.close();
  const database = new Database(join(stateDir, "state.db"));
  database.pragma("user_version = 1");
  database.close();

  const children = await burst();

  expect(realFailures(children)).toEqual([]);

  // The peer a human typed survives the concurrent rebuild. This is the
  // assertion that matters most in this file: peers are the only rows no
  // collect can re-derive, so losing this race destroys information rather than
  // costing a round trip.
  expect(peerNames()).toBe("dev");
}, 60_000);

test("repeated upgrade bursts never lose the salvaged peer", async () => {
  // The test above catches an unlocked reset only PROBABILISTICALLY -- measured
  // at 5 of 8 runs with the lock removed -- because the loss needs two
  // processes to interleave inside a window of a few file operations. A test
  // that fails three times in eight is one people re-run until it passes.
  //
  // Eight bursts, each preceded by a fresh stale-version seed, so that window is
  // entered dozens of times per run.
  //
  // The round count is DETECTION PROBABILITY, not repetition of a deterministic
  // failure, and it was measured rather than assumed. Neutering `withResetLock`
  // and varying the count: 2 rounds PASSED (bug undetected), 4 failed at round
  // 4, 5 passed, 6 failed. So each round is an independent chance to lose the
  // race, and cutting the count trades regression coverage for wall clock --
  // silently, because the reduced version is still green against broken code.
  //
  // That is why this stays at 8 despite being the slowest test in the suite
  // (~13.8s, 64 real node processes): the earlier claim that removing the lock
  // "failed every attempt" is not what the evidence shows, and 8 is the count
  // this was validated at. Lower it only with the same experiment re-run.
  for (let round = 0; round < 8; round += 1) {
    const seed = openStore();
    seed.addPeer("dev", "dev.example");
    seed.close();
    const database = new Database(join(stateDir, "state.db"));
    database.pragma("user_version = 1");
    database.close();

    const children = await burst();

    expect(realFailures(children), `round ${round}`).toEqual([]);
    expect(peerNames(), `round ${round}`).toBe("dev");
  }
}, 120_000);

test("eight processes syncing one pane all settle, none dies on a locked database", async () => {
  // Eight, matching the measured incident.
  //
  // CONCURRENTLY, and that is the entire test. A version that ran the children
  // one after another never contended, and passed with `.immediate` REMOVED --
  // a test that proved nothing while looking thorough.
  const children = await burst();

  expect(realFailures(children)).toEqual([]);
  expect(children).toHaveLength(8);

  // And the table is consistent: one sighting of %1, so a collect that then
  // finds the pane gone records exactly one crash, not one per writer.
  const crashes = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { openStore } = await import(${JSON.stringify(STORE)});
       const store = openStore();
       const { crashed } = store.syncLocal([{ server: { kind: "default" }, panes: [] }], 99999);
       process.stdout.write(crashed.length + " " + store.localPanes().length);
       store.close();`,
    ],
    { encoding: "utf8", env: { ...process.env, MURMUR_STATE_DIR: stateDir }, timeout: 30_000 },
  );
  expect(crashes).toBe("1 1");
}, 60_000);
