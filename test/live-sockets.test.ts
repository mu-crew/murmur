import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { filterLiveSockets } from "../src/mux.js";

test("filterLiveSockets keeps listening Unix sockets and drops dead ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-socks-"));
  const live = join(dir, "live");
  const dead = join(dir, "dead");
  const server = createServer();
  try {
    await new Promise<void>((resolve) => server.listen(live, resolve));
    // Create a stale socket file by listening then closing without unlinking,
    // or probing a nonexistent path: both fail connect() with ECONNREFUSED/ENOENT.
    const deadServer = createServer();
    await new Promise<void>((resolve) => deadServer.listen(dead, resolve));
    await new Promise<void>((resolve) => deadServer.close(() => resolve()));

    expect(filterLiveSockets([dead, live, join(dir, "missing")])).toEqual([live]);
    expect(filterLiveSockets([])).toEqual([]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
