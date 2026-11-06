import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { loadSocketCache, SILENT_SOCKET_TTL_MS } from "../src/socket-cache.js";

/**
 * The pid-to-socket cache the drain keeps across processes. Start times and the
 * clock are injected, so a recycled pid and an expiring entry are pinned
 * without real processes.
 */

function cachePath(): string {
  return join(mkdtempSync(join(tmpdir(), "murmur-socket-cache-")), "tmux-sockets.json");
}

const alive = (pids: number[]) => (pid: number) => pids.includes(pid);
const STAT = { ino: 7, mtime: 1000 };

test("a server's socket outlives the process that found it, while its start time matches", () => {
  const path = cachePath();
  const times = new Map([[4242, 1_700_000_000]]);
  const first = loadSocketCache(path, { startTimes: () => times });
  first.record("/tmp/tmux-501/rig", STAT, 4242);
  first.save(alive([4242]));
  expect(JSON.parse(readFileSync(path, "utf8")).servers).toEqual({
    4242: { started: 1_700_000_000, socket: "/tmp/tmux-501/rig" },
  });

  const second = loadSocketCache(path, { startTimes: () => times });
  expect(second.server(4242)).toBe("/tmp/tmux-501/rig");

  // The same pid, started later: a recycled pid, never the old server's socket.
  const recycled = loadSocketCache(path, { startTimes: () => new Map([[4242, 1_800_000_000]]) });
  expect(recycled.server(4242)).toBeNull();
  // Gone altogether.
  expect(loadSocketCache(path, { startTimes: () => new Map() }).server(4242)).toBeNull();
});

test("a scan skips a socket that answered nothing lately, or another live server's", () => {
  let clock = 1_000_000;
  const path = cachePath();
  const options = {
    now: () => clock,
    startTimes: () =>
      new Map([
        [10, 1],
        [11, 1],
      ]),
  };
  const cache = loadSocketCache(path, options);
  cache.record("/s/silent", STAT, null);
  cache.record("/s/other", STAT, 11);
  cache.save(alive([10, 11]));

  const later = loadSocketCache(path, options);
  expect(later.skip("/s/silent", STAT, 10, alive([10, 11]))).toBe(true);
  expect(later.skip("/s/other", STAT, 10, alive([10, 11]))).toBe(true);
  // The very server being looked for is never skipped.
  expect(later.skip("/s/other", STAT, 11, alive([10, 11]))).toBe(false);
  // Its server died: the socket may be anyone's now.
  expect(later.skip("/s/other", STAT, 10, alive([10]))).toBe(false);
  // A socket file recreated since (a restarted server) is asked again.
  expect(later.skip("/s/silent", { ino: 8, mtime: 1000 }, 10, alive([10]))).toBe(false);
  expect(later.skip("/s/unknown", STAT, 10, alive([10]))).toBe(false);

  clock += SILENT_SOCKET_TTL_MS;
  expect(later.skip("/s/silent", STAT, 10, alive([10, 11]))).toBe(false);
});

test("save drops dead servers and expired silences, and writes nothing unchanged", () => {
  let clock = 1_000_000;
  const path = cachePath();
  const options = {
    now: () => clock,
    startTimes: () =>
      new Map([
        [10, 1],
        [11, 1],
      ]),
  };
  const cache = loadSocketCache(path, options);
  cache.record("/s/a", STAT, 10);
  cache.record("/s/b", STAT, 11);
  cache.record("/s/silent", STAT, null);
  cache.save(alive([10, 11]));

  clock += SILENT_SOCKET_TTL_MS;
  loadSocketCache(path, options).save(alive([10]));
  const file = JSON.parse(readFileSync(path, "utf8"));
  expect(Object.keys(file.servers)).toEqual(["10"]);
  expect(Object.keys(file.sockets)).toEqual(["/s/a"]);

  writeFileSync(path, "sentinel");
  // Unreadable reads as empty, and an empty cache with nothing new is not written.
  loadSocketCache(path, options).save(alive([10]));
  expect(readFileSync(path, "utf8")).toBe("sentinel");
});

test("a null path remembers nothing and writes nothing", () => {
  const cache = loadSocketCache(null, { startTimes: () => new Map([[10, 1]]) });
  cache.record("/s/a", STAT, 10);
  // Found this process, so this process still knows it.
  expect(cache.server(10)).toBe("/s/a");
  cache.save(alive([10]));
  expect(existsSync("tmux-sockets.json")).toBe(false);
});
