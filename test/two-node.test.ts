import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { Channel } from "../src/channel.js";
import { collect } from "../src/collector.js";
import type { NodeIdentity } from "../src/identity.js";
import { buildSnapshot, readLocal } from "../src/local.js";
import { openStore, type Store } from "../src/store.js";
import type { PaneView } from "../src/view.js";
import { paneViews, renderState, STALENESS_MS, viewSort } from "../src/view.js";
import { type RowField, vtmuxMux, vtmuxRow } from "./helpers/panes.js";

/**
 * The two-node smoke test, as a deterministic test.
 *
 * Two REAL stores in two state directories, joined by a channel that runs node
 * B's local read and serialises its snapshot exactly as `murmur export` prints
 * it, handing the string to node A's collector. That is the whole wire: the
 * transport is ssh and the payload is one JSON document, so a fake channel
 * exercises everything except the hop itself.
 *
 * Each node's multiplexer is a fake vtmux answering `list-panes` rows: the
 * panes and their OSC 7501 records are node B's OWN local facts, which node A
 * never sees and has no way to ask.
 *
 * `peer-cache.test.ts` covers the cache's edges with hand-built documents. This
 * file differs by construction: node B's document is BUILT BY ITS COLLECTOR, so
 * a build path that drifted from the validate path fails here rather than
 * showing up as "that host is broken" on every other machine.
 */

let dirA: string;
let dirB: string;
const stores: Store[] = [];

beforeEach(() => {
  dirA = mkdtempSync(join(tmpdir(), "murmur-node-a-"));
  dirB = mkdtempSync(join(tmpdir(), "murmur-node-b-"));
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

/**
 * A store in one node's state directory.
 *
 * `MURMUR_STATE_DIR` is repointed around the open because `dbPath()` is resolved
 * at open time; the handle then stays bound to that file, which is what lets two
 * nodes be open at once in one process.
 */
function nodeStore(dir: string): Store {
  const previous = process.env.MURMUR_STATE_DIR;
  process.env.MURMUR_STATE_DIR = dir;
  try {
    const opened = openStore();
    stores.push(opened);
    return opened;
  } finally {
    if (previous === undefined) delete process.env.MURMUR_STATE_DIR;
    else process.env.MURMUR_STATE_DIR = previous;
  }
}

const IDENTITY_A: NodeIdentity = { host_id: "HOST-A", display_name: "laptop" };
const IDENTITY_B: NodeIdentity = { host_id: "HOST-B", display_name: "bubba" };

/** A pane on a node, as its vtmux lists it. */
function row(pane: string, fields: Partial<Record<RowField, string>> = {}): string[] {
  return vtmuxRow({ pane, window: "@1", window_name: "api", ...fields });
}

/** A working crew agent, as mu tags it and its program reports itself. */
function working(pane: string, agent = "worker-1", fields: Partial<Record<RowField, string>> = {}) {
  return row(pane, {
    state: "working",
    app: "pi",
    mu_agent: agent,
    mu_workstream: "api",
    ...fields,
  });
}

/** Node A's own collect options: its local panes, no Rex. */
function local(...rows: string[][]) {
  return { mux: vtmuxMux(rows), rex: false as const };
}

/**
 * The single pane a node contributes, asserted to exist.
 *
 * `paneViews(...)[0]` is `PaneView | undefined`, and these tests care about the
 * word `renderState` produces for it. An explicit failure here says "the peer
 * contributed no pane", which is the real diagnosis, rather than a non-null
 * assertion the lint rules forbid or a `?.` that silently makes the assertion
 * vacuous.
 */
function onlyPane(views: PaneView[]): PaneView {
  expect(views).toHaveLength(1);
  const [view] = views;
  if (!view) throw new Error("expected exactly one pane in the view");
  return view;
}

/**
 * The wire. `murmur export` on node B, verbatim: read the local panes, build
 * the document, serialise it, hand back the string.
 */
function exportFrom(storeB: Store, rows: string[][] | null, now: number): Channel {
  return {
    exec: async () => {
      const read = await readLocal(
        storeB,
        vtmuxMux(rows === null ? new Map([["default\0", null]]) : rows),
        now,
        {
          rex: false,
        },
      );
      return JSON.stringify(buildSnapshot(IDENTITY_B, read.panes, now));
    },
  };
}

test("a remote RUNNING agent renders running on the other node, never crashed", async () => {
  // The trap that looks exactly like a real crash: if any read path on A
  // probed B's processes, it would conclude they are dead and paint `crashed`
  // for a healthy agent on another machine. A pid never crosses the wire.
  const a = nodeStore(dirA);
  const b = nodeStore(dirB);
  a.addPeer("bubba", "bubba");

  await collect(
    a,
    exportFrom(b, [working("%11", "worker-1", { pid: "424242" })], 1_000),
    2_000,
    local(),
  );

  const view = onlyPane(paneViews(a, IDENTITY_A, [], 2_000));
  expect(view).toMatchObject({
    pane: "%11",
    activity: "running",
    local: false,
    freshness: "fresh",
    driver: "orchestrated",
    agent_name: "worker-1",
  });
  expect(renderState(view)).toBe("running");
  expect(JSON.stringify(a.peers())).not.toContain("424242");
});

test("a node that goes quiet keeps its last-known panes and only loses freshness", async () => {
  // What an operator sees when a laptop sleeps: the agents that were there are
  // still listed, with the facts that node last reported, and the only thing
  // that changed is the warning that we have not heard from it.
  const a = nodeStore(dirA);
  const b = nodeStore(dirB);
  a.addPeer("bubba", "bubba");
  await collect(a, exportFrom(b, [working("%11")], 1_000), 1_000, local());

  const gone: Channel = {
    exec: async () => {
      throw new Error(
        "Command failed: ssh -o BatchMode=yes bubba murmur export\n" +
          "ssh: connect to host bubba port 22: Host is down\n",
      );
    },
  };
  const results = await collect(a, gone, 2_000, local());

  expect(results[0]).toMatchObject({ peer: "bubba", ok: false, unreachable: true });
  const view = onlyPane(paneViews(a, IDENTITY_A, [], 1_000 + STALENESS_MS + 1));
  expect(view).toMatchObject({ pane: "%11", activity: "running", freshness: "stale" });
  // Freshness is a property of the NODE: `stale` cannot displace what the
  // agent was doing.
  expect(renderState(view)).toBe("running");
  expect(a.peers()[0]?.snapshot?.panes).toHaveLength(1);
});

test("a pane taken over on one node is replaced on the other, leaving one row", async () => {
  // The document is complete, so A's cache is replaced whole: there is no merge
  // step that could leave both the old and the new agent listed for one pane.
  const a = nodeStore(dirA);
  const b = nodeStore(dirB);
  a.addPeer("bubba", "bubba");
  await collect(a, exportFrom(b, [working("%11", "worker-1")], 1_000), 1_000, local());
  expect(paneViews(a, IDENTITY_A, [], 1_000)[0]?.agent_name).toBe("worker-1");

  await collect(a, exportFrom(b, [working("%11", "worker-2")], 3_000), 4_000, local());

  const views = paneViews(a, IDENTITY_A, [], 4_000);
  expect(views).toHaveLength(1);
  expect(views[0]).toMatchObject({ pane: "%11", agent_name: "worker-2", activity: "running" });
});

test("a program blocked on one node is visible on the other, and answering it there clears it here", async () => {
  // Attention is the program's own record, so it crosses the wire as a row
  // carrying its own words and clock. And because absence from a successful
  // snapshot IS absence, the program moving on clears it on A with no
  // tombstone.
  const a = nodeStore(dirA);
  const b = nodeStore(dirB);
  a.addPeer("bubba", "bubba");
  const blocked = row("%12", {
    window: "@2",
    state: "blocked",
    kind: "question",
    app: "codex",
    message: "needs a decision",
    state_time: "1500",
  });

  await collect(a, exportFrom(b, [working("%11"), blocked], 2_000), 2_000, local());

  const before = viewSort(paneViews(a, IDENTITY_A, [], 2_000));
  // Attention sorts ahead of a merely running agent, so the row that wants a
  // human is the first one an operator sees.
  expect(before.map((view) => view.pane)).toEqual(["%12", "%11"]);
  expect(before[0]).toMatchObject({ pane: "%12", blocked_kind: "question", harness: "codex" });
  expect(before[0]?.attention).toEqual([
    { kind: "blocked", requested_at: 1_500_000, message: "needs a decision" },
  ]);

  const answered = row("%12", { window: "@2", state: "working", app: "codex" });
  await collect(a, exportFrom(b, [working("%11"), answered], 3_000), 3_000, local());

  const after = paneViews(a, IDENTITY_A, [], 3_000).sort((l, r) => l.pane.localeCompare(r.pane));
  expect(after.map((view) => [view.pane, view.attention.length])).toEqual([
    ["%11", 0],
    ["%12", 0],
  ]);
});

test("a crew pane's done crosses the wire as crew", async () => {
  // The `@mu_agent` tag is read on B, so a mu-placed codex worker that finished
  // on B is crew on A too -- it does not land in A's own done count.
  const a = nodeStore(dirA);
  const b = nodeStore(dirB);
  a.addPeer("bubba", "bubba");
  const done = row("%12", { state: "done", app: "codex", mu_agent: "w-3", message: "finished" });

  await collect(a, exportFrom(b, [done], 2_000), 2_000, local());

  expect(paneViews(a, IDENTITY_A, [], 2_000)).toMatchObject([
    { pane: "%12", local: false, driver: "orchestrated", agent_name: "w-3" },
  ]);
});

test("a crash detected on one node reaches the other as crashed, with the dead agent still named", async () => {
  // Node B sees its own pane vanish mid-work -- the only node that can -- and
  // records it. What crosses the wire is the CONCLUSION, not the evidence,
  // and it must still say WHICH agent died.
  const a = nodeStore(dirA);
  const b = nodeStore(dirB);
  a.addPeer("bubba", "bubba");
  // An orchestrator: mu closes and watches its workers, so only an
  // orchestrator's pane vanishing mid-work is murmur's crash to record.
  await collect(
    a,
    exportFrom(b, [working("%11", "worker-7", { mu_role: "orchestrator" })], 4_000),
    4_000,
    local(),
  );

  await collect(a, exportFrom(b, [], 5_000), 5_000, local());

  const view = onlyPane(paneViews(a, IDENTITY_A, [], 5_000));
  expect(view).toMatchObject({
    pane: "%11",
    activity: "stopped",
    agent_name: "worker-7",
    workstream: "api",
    driver: "orchestrated",
  });
  // WHEN it died, not merely that it did: `crashed` sorts oldest-first, so a
  // reader on the far node needs the owning node's `requested_at` to place it.
  expect(view.attention).toEqual([
    { kind: "crashed", requested_at: 5_000, message: "pane vanished while working" },
  ]);
  expect(renderState(view)).toBe("crashed");

  // Dismissed on B, gone from A at the next collect.
  expect(b.acknowledgePane({ server: { kind: "default" }, pane: view.pane })).toBe(1);
  await collect(a, exportFrom(b, [], 6_000), 6_000, local());
  expect(paneViews(a, IDENTITY_A, [], 6_000)).toEqual([]);
});

test("a node whose tmux cannot answer records no crash for the panes it could not see", async () => {
  // A null read is absence of evidence. If it synthesised crashes, a tmux
  // hiccup on B would paint every agent there `crashed`, and -- because a
  // successful snapshot is authoritative -- that would propagate to A as fact.
  const a = nodeStore(dirA);
  const b = nodeStore(dirB);
  a.addPeer("bubba", "bubba");
  await collect(
    a,
    exportFrom(b, [working("%11", "worker-1", { mu_role: "orchestrator" })], 1_000),
    1_000,
    local(),
  );

  await collect(a, exportFrom(b, null, 2_000), 2_000, local());
  expect(paneViews(a, IDENTITY_A, [], 2_000).flatMap((view) => view.attention)).toEqual([]);

  // And when it answers again the pane keeps the age it had: nothing was
  // forgotten in between.
  await collect(a, exportFrom(b, [working("%11")], 3_000), 3_000, local());
  expect(onlyPane(paneViews(a, IDENTITY_A, [], 3_000))).toMatchObject({
    pane: "%11",
    activity: "running",
    updated_at: 1_000,
  });
});

test("a peer serving a document this version cannot read is broken, not absent", async () => {
  // The cross-VERSION case, and a real one. That must read as a pairing
  // problem an operator can fix, and it must not discard what we already had.
  const a = nodeStore(dirA);
  const b = nodeStore(dirB);
  a.addPeer("bubba", "bubba");
  await collect(a, exportFrom(b, [working("%11")], 1_000), 1_000, local());

  const oldBuild: Channel = {
    exec: async () => {
      throw new Error(
        "Command failed: ssh -o BatchMode=yes bubba murmur export\n" +
          "error: required option '--since <seq>' not specified\n",
      );
    },
  };
  const results = await collect(a, oldBuild, 2_000, local());

  expect(results[0]).toMatchObject({ peer: "bubba", ok: false, unreachable: false });
  const peer = a.peers()[0];
  expect(peer?.last_error).toBe("error: required option '--since <seq>' not specified");
  expect(peer?.snapshot?.panes).toHaveLength(1);
  expect(peer).toMatchObject({ fetched_at: 1_000, last_attempt_at: 2_000 });
});

test("two nodes' clocks stay separate: a freshly fetched old fact is fresh and old at once", async () => {
  const a = nodeStore(dirA);
  const b = nodeStore(dirB);
  const threeHoursAgo = 100_000_000 - 3 * 3_600_000;
  a.addPeer("bubba", "bubba");

  await collect(a, exportFrom(b, [working("%11")], threeHoursAgo), 100_000_000, local());

  const [view] = paneViews(a, IDENTITY_A, [], 100_000_000);
  expect(view?.freshness).toBe("fresh");
  expect(view?.snapshot_at).toBe(threeHoursAgo);
  expect(view?.fetched_at).toBe(100_000_000);
  expect(a.peers()[0]).toMatchObject({ snapshot_at: threeHoursAgo, fetched_at: 100_000_000 });
});

test("each node authors only its own panes, so identically-numbered panes do not collide", async () => {
  // Both machines routinely hold `%1`: pane ids are unique per NODE, never
  // globally. The view must keep them apart by host.
  const a = nodeStore(dirA);
  const b = nodeStore(dirB);
  a.addPeer("bubba", "bubba");

  const mine = local(working("%1", "local-worker"));
  await collect(a, exportFrom(b, [working("%1", "remote-worker")], 1_000), 1_000, mine);
  const localRead = await readLocal(a, mine.mux, 1_000, { rex: false });

  const views = paneViews(a, IDENTITY_A, localRead.panes, 1_000);
  expect(views).toHaveLength(2);
  const byHost = new Map(views.map((view) => [view.host_id, view]));
  expect(byHost.get("HOST-A")).toMatchObject({
    pane: "%1",
    agent_name: "local-worker",
    local: true,
  });
  expect(byHost.get("HOST-B")).toMatchObject({
    pane: "%1",
    agent_name: "remote-worker",
    local: false,
  });
});
