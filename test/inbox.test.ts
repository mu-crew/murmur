import { execFile, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test } from "vitest";
import { paneReport } from "../src/cli/pane.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import {
  drainInbox,
  INBOX_PANE_CAP,
  type InboxHost,
  inboxDir,
  inboxKey,
  SOCKET_PROBE_BUDGET_MS,
  tmuxInboxHost,
  writeInboxEvent,
} from "../src/inbox.js";
import { type InboxEvent, LAST_TEXT_MAX_BYTES, parseServerSocket } from "../src/inbox-event.js";
import type { PublishPlan } from "../src/mux.js";
import { loadSocketCache } from "../src/socket-cache.js";
import { openStore, type Store } from "../src/store.js";
import type { InboxDelivery, Location } from "../src/types.js";
import { builtArtifact } from "./helpers/built.js";
import { fakeMux } from "./helpers/fake-mux.js";

/**
 * The pane inbox: hook events written as files, applied by readers.
 *
 * The drain's host (tmux and the process table) is faked so each ownership and
 * vocabulary rule is pinned on its own; test/inbox-tmux.test.ts runs the same
 * drain against a real tmux server. The store is real throughout, because the
 * rules live in its transaction.
 */

const SERVER = 4100;
const ROOT = 4200;
const OWNER = 4300;
const PI = 4400;

const stores: Store[] = [];

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-inbox-"));
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

function location(pane = "%1"): Location {
  return {
    server: { kind: "default" },
    session: asSessionId("$0"),
    window: asWindowId("@0"),
    pane: asPaneId(pane),
    session_name: "work",
    window_name: null,
  };
}

function event(over: Partial<InboxEvent> = {}): InboxEvent {
  return {
    v: 1,
    event: "prompt_submitted",
    harness: "claude",
    at: 1_000,
    server_pid: SERVER,
    root_pid: ROOT,
    owner_pid: OWNER,
    tmux: null,
    tmux_pane: null,
    session_id: "s1",
    source: null,
    reason: null,
    message: null,
    text: null,
    generation_id: null,
    by: "harness",
    agent: { agent_name: null, workstream: null, role: null, cli: null, driver: "human" },
    ...over,
  };
}

type HostState = {
  alive: Set<number>;
  focused: boolean;
  piRuns: boolean;
  paneGone: boolean;
  serverFound: boolean;
  piAsked: [number, number][];
};

function host(state: Partial<HostState> = {}): InboxHost & { state: HostState } {
  const full: HostState = {
    alive: new Set([SERVER, OWNER]),
    focused: false,
    piRuns: false,
    paneGone: false,
    serverFound: true,
    piAsked: [],
    ...state,
  };
  return {
    state: full,
    isAlive: (pid) => full.alive.has(pid),
    serverFor: () => (full.serverFound ? { kind: "default" } : null),
    panes: () =>
      full.paneGone
        ? new Map()
        : new Map([[ROOT, { location: location(), focused: full.focused }]]),
    piRunsUnder: (root, except) => {
      full.piAsked.push([root, except]);
      return full.piRuns;
    },
  };
}

function write(...events: Partial<InboxEvent>[]): void {
  for (const over of events) expect(writeInboxEvent(event(over))).toBe(true);
}

function drain(s: Store, h = host(), plans: PublishPlan[] = []) {
  const mux = fakeMux({
    panesInWindow: () => [asPaneId("%1")],
    publish: (_window, plan) => {
      plans.push(plan);
    },
  });
  return drainInbox(s, { host: h, mux });
}

function report(s: Store) {
  return paneReport(s, asPaneId("%1"), { kind: "default" }, false);
}

test("the first event of any kind claims an unclaimed pane, and the drain publishes it", () => {
  const s = store();
  write({ event: "prompt_submitted" });
  const plans: PublishPlan[] = [];
  expect(drain(s, host(), plans)).toMatchObject({ applied: 1, ignored: 0, malformed: 0 });

  expect(report(s)).toMatchObject({
    state: "working",
    agent: { source: "inbox", harness: "claude", session_id: "s1", run_count: 1, cli: "claude" },
  });
  // @murmur_pane_state for the pane, through the one publish path.
  expect(plans.at(-1)?.panes).toEqual([{ pane: "%1", state: "running", label: "claude" }]);
  // Applied events are gone, and so is the emptied directory.
  expect(existsSync(join(inboxDir(), inboxKey(SERVER, ROOT)))).toBe(false);
});

test("events apply in name order, so the last turn's text wins and runs count up", () => {
  const s = store();
  write(
    { event: "session_start", source: "startup", at: 1 },
    { event: "prompt_submitted", at: 2 },
    { event: "turn_stopped", text: "first", at: 3 },
    { event: "prompt_submitted", at: 4 },
    { event: "turn_stopped", text: "second", at: 5 },
  );
  drain(s);
  expect(report(s).agent).toMatchObject({ run_count: 2, last_text: "second", activity: "stopped" });
});

test("an event from another session is ignored, unless it starts one", () => {
  const s = store();
  write({ event: "prompt_submitted", session_id: "s1" });
  drain(s);
  // codex's hidden title session would otherwise move the pane on every prompt.
  write({ event: "prompt_submitted", session_id: "other" });
  expect(drain(s)).toMatchObject({ applied: 0, ignored: 1 });
  expect(report(s).agent).toMatchObject({ session_id: "s1", run_count: 1 });

  write({ event: "session_start", source: "clear", session_id: "s2" });
  drain(s);
  expect(report(s).agent).toMatchObject({ session_id: "s2", run_count: 0, activity: "stopped" });
  write({ event: "session_start", source: "compact", session_id: "s2", at: 9_999 });
  drain(s);
  expect(report(s).agent?.updated_at).not.toBe(9_999);
});

const PI_META = {
  agent_name: null,
  pi_session: null,
  workstream: null,
  role: null,
  cli: "pi",
  driver: "human",
} as const;

test("a pane a live pi owns ignores the inbox", () => {
  const s = store();
  s.claimAgent({ location: location(), owner_pid: PI, meta: PI_META, nestedUnder: () => null });
  write({ event: "prompt_submitted", owner_pid: OWNER });
  expect(drain(s, host({ alive: new Set([SERVER, OWNER, PI]) }))).toMatchObject({
    applied: 0,
    ignored: 1,
  });
  expect(report(s)).toMatchObject({ state: "idle", agent: { source: "pi", run_count: null } });
});

test("a dead pi's row, crashed or stopped, is replaced by the next inbox claim", () => {
  const s = store();
  s.claimAgent({ location: location(), owner_pid: PI, meta: PI_META, nestedUnder: () => null });
  const agentId = s.localPanes()[0]?.agent?.agent_id as string;
  s.setActivity({ agent_id: agentId, owner_pid: PI, activity: "running", location: location() });
  // pi dies mid-run: reconcile marks it crashed and keeps the row.
  s.reconcileLocal({
    server: { kind: "default" },
    panes: new Set([asPaneId("%1")]),
    isAlive: (pid) => pid !== PI,
  });
  expect(report(s)).toMatchObject({ state: "crashed", agent: { source: "pi" } });

  // claude starts in that pane: its events claim it, not vanish.
  write({ event: "session_start", source: "startup", at: 1 }, { event: "prompt_submitted", at: 2 });
  expect(drain(s)).toMatchObject({ applied: 2, ignored: 0 });
  expect(report(s)).toMatchObject({
    state: "working",
    agent: { source: "inbox", harness: "claude", run_count: 1 },
    attention: [],
  });
});

test("the drain asks whether a pi runs in the pane outside the event's own harness", () => {
  const s = store();
  write({ event: "prompt_submitted" });
  const h = host();
  drain(s, h);
  expect(h.state.piAsked).toEqual([[ROOT, OWNER]]);
});

test("an unclaimed pane is never claimed for the inbox while a pi runs in it", () => {
  const s = store();
  write({ event: "prompt_submitted" });
  expect(drain(s, host({ piRuns: true }))).toMatchObject({ applied: 0, ignored: 1 });
  expect(report(s)).toMatchObject({ state: null, agent: null });
});

test("a live other owner is refused; a dead one is replaced", () => {
  const s = store();
  write({ event: "prompt_submitted" });
  drain(s);
  write({ event: "session_start", source: "startup", owner_pid: 5555, session_id: "new" });
  const h = host();
  h.state.alive.add(5555);
  expect(drain(s, h)).toMatchObject({ applied: 0, ignored: 1 });
  expect(report(s).agent).toMatchObject({ session_id: "s1" });

  h.state.alive.delete(OWNER);
  write({ event: "session_start", source: "startup", owner_pid: 5555, session_id: "new" });
  expect(drain(s, h)).toMatchObject({ applied: 1 });
  expect(report(s).agent).toMatchObject({ session_id: "new", run_count: 0 });
});

test("turn_stopped raises done for an unfocused human pane only", () => {
  const unfocused = store();
  write({ event: "prompt_submitted" }, { event: "turn_stopped", text: "ok" });
  drain(unfocused);
  expect(report(unfocused)).toMatchObject({ state: "done" });
  // The next prompt clears it.
  write({ event: "prompt_submitted" });
  drain(unfocused);
  expect(report(unfocused)).toMatchObject({ state: "working", attention: [] });
  unfocused.close();

  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-inbox-"));
  const focused = store();
  write({ event: "prompt_submitted" }, { event: "turn_stopped", text: "ok" });
  drain(focused, host({ focused: true }));
  expect(report(focused)).toMatchObject({ state: "idle", attention: [] });
  focused.close();

  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-inbox-"));
  const crew = store();
  const orchestrated = {
    agent: { agent_name: "w", workstream: "ws", role: null, cli: null, driver: "orchestrated" },
  } as const;
  write(
    { event: "prompt_submitted", ...orchestrated },
    { event: "turn_stopped", text: "ok", ...orchestrated },
  );
  drain(crew);
  expect(report(crew)).toMatchObject({ state: "idle", agent: { agent_name: "w" } });
});

test("blocked lasts until the next event; a failed turn is an error", () => {
  const s = store();
  write({ event: "prompt_submitted" }, { event: "permission_requested", message: "Bash" });
  drain(s);
  expect(report(s)).toMatchObject({
    state: "blocked",
    attention: [{ kind: "blocked", message: "Bash", source: "claude" }],
  });
  write({ event: "continued" });
  drain(s);
  expect(report(s)).toMatchObject({ state: "working", attention: [] });
  write({ event: "turn_failed", message: "rate limited" });
  drain(s);
  expect(report(s)).toMatchObject({
    state: "error",
    agent: { activity: "stopped" },
    attention: [{ kind: "error", message: "rate limited" }],
  });
});

test("mu's interrupt reads idle? until the harness speaks", () => {
  const s = store();
  write({ event: "prompt_submitted" }, { event: "interrupted", by: "mu" });
  drain(s);
  expect(report(s)).toMatchObject({ state: "idle?", agent: { confirmed: false } });
  write({ event: "interrupted", by: "harness" });
  drain(s);
  expect(report(s)).toMatchObject({ state: "idle", agent: { confirmed: true } });
});

test("session_end releases the pane and keeps its attention, except for /clear", () => {
  const s = store();
  write({ event: "prompt_submitted" }, { event: "turn_stopped", text: "done" });
  write({ event: "session_end", reason: "clear" });
  drain(s);
  expect(report(s).agent).not.toBeNull();
  write({ event: "session_end", reason: "logout" });
  drain(s);
  expect(report(s)).toMatchObject({ agent: null, state: "done" });
  // An end on an unclaimed pane claims nothing.
  write({ event: "session_end", reason: "logout", owner_pid: 7777 });
  expect(drain(s)).toMatchObject({ applied: 0, ignored: 1 });
});

test("a malformed file is dropped and counted, and does not stop the pane's other events", () => {
  const s = store();
  write({ event: "prompt_submitted", at: 1 });
  const paneDir = join(inboxDir(), inboxKey(SERVER, ROOT));
  writeFileSync(join(paneDir, `${"9".repeat(20)}-0000000001.json`), "{not json");
  writeFileSync(
    join(paneDir, `${"9".repeat(20)}-0000000002.json`),
    JSON.stringify({ ...event(), root_pid: ROOT + 1 }),
  );
  expect(drain(s)).toMatchObject({ applied: 1, malformed: 2 });
  expect(existsSync(paneDir)).toBe(false);
});

test("an inbox with nothing locatable in it is removed, not kept forever", () => {
  const s = store();
  const paneDir = join(inboxDir(), inboxKey(SERVER, ROOT));
  mkdirSync(paneDir, { recursive: true });
  writeFileSync(join(paneDir, `${"1".repeat(20)}-0000000001.json`), "{not json");
  drain(s);
  expect(existsSync(paneDir)).toBe(false);

  // And a hook writing afterwards recreates it.
  write({ event: "prompt_submitted" });
  expect(readdirSync(paneDir)).toHaveLength(1);
});

test("an inbox no drain can locate is kept for a while, then removed", () => {
  const s = store();
  write({ event: "prompt_submitted" });
  const paneDir = join(inboxDir(), inboxKey(SERVER, ROOT));
  expect(drain(s, host({ serverFound: false }))).toMatchObject({ applied: 0, removed: 0 });
  expect(readdirSync(paneDir)).toHaveLength(1);

  const [file] = readdirSync(paneDir);
  const hoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(join(paneDir, file as string), hoursAgo, hoursAgo);
  expect(drain(s, host({ serverFound: false }))).toMatchObject({ applied: 0, removed: 1 });
  expect(existsSync(paneDir)).toBe(false);
});

test("a dead server's inbox and a gone pane's inbox are deleted", () => {
  const s = store();
  write({ event: "prompt_submitted" });
  const paneDir = join(inboxDir(), inboxKey(SERVER, ROOT));
  expect(drain(s, host({ alive: new Set([OWNER]) }))).toMatchObject({ applied: 0, removed: 1 });
  expect(existsSync(paneDir)).toBe(false);

  write({ event: "prompt_submitted" });
  expect(drain(s, host({ paneGone: true }))).toMatchObject({ applied: 0, removed: 1 });
  expect(existsSync(paneDir)).toBe(false);
});

test("the default host deletes the inbox of a server pid that is really dead", () => {
  // No fake: the real liveness probe, against a pid that has exited.
  const s = store();
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
    encoding: "utf8",
  });
  const deadPid = Number(dead.stdout);
  expect(writeInboxEvent(event({ server_pid: deadPid }))).toBe(true);
  const paneDir = join(inboxDir(), inboxKey(deadPid, ROOT));
  expect(drainInbox(s, { mux: fakeMux() })).toMatchObject({ removed: 1 });
  expect(existsSync(paneDir)).toBe(false);
});

test("a 1 MB event lands whole and its text is capped at 64 KB", () => {
  const s = store();
  const big = "é".repeat(512 * 1024); // 1 MiB of UTF-8, two bytes a character
  write({ event: "prompt_submitted" }, { event: "turn_stopped", text: big });
  drain(s);
  const text = report(s).agent?.last_text ?? "";
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(LAST_TEXT_MAX_BYTES);
  expect(Buffer.byteLength(text)).toBeGreaterThan(LAST_TEXT_MAX_BYTES - 2);
  expect(big.startsWith(text)).toBe(true);
});

test("a pane's hook stops writing past the cap", () => {
  // The cap is 10,000 on a real node; a small one here exercises the same check.
  expect(INBOX_PANE_CAP).toBe(10_000);
  for (let index = 0; index < 3; index += 1)
    expect(writeInboxEvent(event(), inboxDir(), 3)).toBe(true);
  expect(writeInboxEvent(event(), inboxDir(), 3)).toBe(false);
  expect(readdirSync(join(inboxDir(), inboxKey(SERVER, ROOT)))).toHaveLength(3);
});

const execFileAsync = promisify(execFile);

test("20 concurrent writers and one 1 MB event are applied in name order, none partial", async () => {
  // Separate processes, as hooks are, writing while this process drains in a
  // loop and removes the emptied directory under them. A reader that could see
  // a half-written file would count it malformed; a writer that lost a race
  // with the removal would fail or vanish. Name order within a drain is pinned
  // by the next test.
  const s = store();
  const sdk = builtArtifact("index.js");
  const writer = `
    const { writeInboxEvent } = await import(${JSON.stringify(sdk)});
    const [index, size] = process.argv.slice(1).map(Number);
    const ok = writeInboxEvent({
      v: 1, event: "turn_stopped", harness: "claude", at: Date.now(),
      server_pid: ${SERVER}, root_pid: ${ROOT}, owner_pid: ${OWNER},
      tmux: null, tmux_pane: null, session_id: "s1", source: null, reason: null,
      message: null, text: "writer-" + index + ":" + "x".repeat(size), generation_id: null,
      by: "harness", agent: { agent_name: null, workstream: null, role: null, cli: null, driver: "orchestrated" },
    });
    process.exit(ok ? 0 : 1);
  `;
  write({ event: "session_start", source: "startup", at: 0 });
  drain(s);

  const delivered: string[] = [];
  const watched: Store = {
    ...s,
    ingestInbox: (read, options) =>
      s.ingestInbox(() => {
        const deliveries = read();
        for (const delivery of deliveries as InboxDelivery[]) {
          delivered.push(delivery.event?.text?.slice(0, 12) ?? "MALFORMED");
        }
        return deliveries;
      }, options),
  };
  const children = Array.from({ length: 21 }, (_, index) =>
    execFileAsync(process.execPath, [
      "--input-type=module",
      "-e",
      writer,
      String(index),
      String(index === 20 ? 1024 * 1024 : 16),
    ]),
  );
  let running = true;
  const settled = Promise.allSettled(children).finally(() => {
    running = false;
  });
  let totals = { applied: 0, malformed: 0, ignored: 0 };
  const add = (summary: { applied: number; malformed: number; ignored: number }) => {
    totals = {
      applied: totals.applied + summary.applied,
      malformed: totals.malformed + summary.malformed,
      ignored: totals.ignored + summary.ignored,
    };
  };
  while (running) {
    add(drain(watched));
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const results = await settled;
  expect(
    results.map((result) => (result.status === "fulfilled" ? "ok" : String(result.reason))),
  ).toEqual(Array(21).fill("ok"));
  add(drain(watched));

  expect(totals).toEqual({ applied: 21, malformed: 0, ignored: 0 });
  expect(delivered).toHaveLength(21);
  expect(new Set(delivered).size).toBe(21);
  expect(existsSync(join(inboxDir(), inboxKey(SERVER, ROOT)))).toBe(false);
});

test("within one drain, files are handed to the store sorted by name", () => {
  const s = store();
  const paneDir = join(inboxDir(), inboxKey(SERVER, ROOT));
  mkdirSync(paneDir, { recursive: true });
  // Written out of order; named in order.
  for (const index of [3, 1, 2]) {
    writeFileSync(
      join(paneDir, `${String(index).padStart(20, "0")}-0000000001.json`),
      JSON.stringify(event({ event: "turn_stopped", text: `t${index}` })),
    );
  }
  const seen: (string | null)[] = [];
  const watched: Store = {
    ...s,
    ingestInbox: (read, options) =>
      s.ingestInbox(() => {
        const deliveries = read();
        for (const delivery of deliveries) seen.push(delivery.event?.text ?? null);
        return deliveries;
      }, options),
  };
  drain(watched);
  expect(seen).toEqual(["t1", "t2", "t3"]);
  expect(report(s).agent?.last_text).toBe("t3");
});

test("the drain hands the host the hook's hints: its $TMUX and its server's socket", () => {
  const s = store();
  write({ tmux: "/tmp/tmux-501/default,4242,0", server_socket: { kind: "label", value: "mule" } });
  const asked: unknown[] = [];
  let done = 0;
  const h = host();
  expect(
    drain(s, {
      ...h,
      serverFor: (pid, hints) => {
        asked.push([pid, hints]);
        return { kind: "default" };
      },
      done: () => {
        done += 1;
      },
    }),
  ).toMatchObject({ applied: 1 });
  expect(asked).toEqual([
    [SERVER, { tmux: "/tmp/tmux-501/default,4242,0", socket: { kind: "label", value: "mule" } }],
  ]);
  expect(done).toBe(1);
});

test("the real host asks a scan's sockets together, once per drain, for every lookup", () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-probe-dir-"));
  for (const name of ["a", "b", "c"]) writeFileSync(join(dir, name), "");
  const calls: { sockets: readonly string[]; budget: number }[] = [];
  const h = tmuxInboxHost({
    socketDirectory: dir,
    own: [],
    cache: null,
    probe: (sockets, budget) => {
      calls.push({ sockets, budget });
      return new Map(sockets.map((socket) => [socket, socket.endsWith("b") ? 111 : null]));
    },
  });
  const none = { tmux: null, socket: null };
  expect(h.serverFor(111, none)).toEqual({ kind: "path", value: join(dir, "b") });
  // One probe for the whole directory, not one socket after another.
  expect(calls.map((call) => call.sockets)).toEqual([["a", "b", "c"].map((n) => join(dir, n))]);
  expect(calls[0]?.budget).toBeLessThanOrEqual(SOCKET_PROBE_BUDGET_MS);
  // Another pid in the same drain: every socket has answered, so none is asked again.
  expect(h.serverFor(222, none)).toBeNull();
  expect(calls).toHaveLength(1);
});

/** Blocks the test's thread for `ms`, as a probe whose sockets never answer does. */
function nap(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

test("the real host's probes share one budget; a server not found in it waits for the next drain", () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-probe-budget-"));
  writeFileSync(join(dir, "silent"), "");
  const calls: { sockets: readonly string[]; budget: number }[] = [];
  const h = tmuxInboxHost({
    socketDirectory: dir,
    own: [],
    cache: null,
    probeBudgetMs: 1000,
    // Sockets that accept and never answer: each probe runs out its budget,
    // and is killed with nothing to say.
    probe: (sockets, budget) => {
      calls.push({ sockets, budget });
      nap(budget);
      return new Map();
    },
  });
  const started = Date.now();
  expect(h.serverFor(333, { tmux: "/nowhere/hint,333,0", socket: null })).toBeNull();
  expect(h.serverFor(444, { tmux: "/nowhere/other,444,0", socket: null })).toBeNull();
  // The hint got half the budget and the directory scan the rest, so the
  // second lookup had nothing left to ask with.
  expect(calls.map((call) => call.sockets)).toEqual([["/nowhere/hint"], [join(dir, "silent")]]);
  expect(calls[0]?.budget).toBeLessThanOrEqual(500);
  expect(calls[1]?.budget).toBeLessThanOrEqual(500);
  expect(Date.now() - started).toBeLessThan(2000);

  // In a drain, that inbox is kept for a later one rather than deleted.
  const s = store();
  write({ event: "prompt_submitted" });
  const paneDir = join(inboxDir(), inboxKey(SERVER, ROOT));
  const stuck = tmuxInboxHost({
    socketDirectory: dir,
    own: [],
    cache: null,
    probe: () => new Map(),
  });
  expect(drainInbox(s, { host: { ...stuck, isAlive: () => true }, mux: fakeMux() })).toMatchObject({
    applied: 0,
    removed: 0,
  });
  expect(existsSync(paneDir)).toBe(true);
});

test("a hinted socket that never answers does not starve another lookup's directory scan", () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-probe-starve-"));
  for (const name of ["a", "b"]) writeFileSync(join(dir, name), "");
  const calls: (readonly string[])[] = [];
  const h = tmuxInboxHost({
    socketDirectory: dir,
    own: [],
    cache: loadSocketCache(null),
    probeBudgetMs: 1000,
    probe: (sockets, budget) => {
      calls.push(sockets);
      // The hinted socket accepts and never answers; `b` is a live server.
      if (sockets.includes("/wedged/hint")) nap(budget);
      return new Map(
        sockets
          .filter((socket) => socket !== "/wedged/hint")
          .map((s) => [s, s.endsWith("b") ? 111 : null]),
      );
    },
  });
  // The wedged server's inbox comes first, as readdir order may put it.
  expect(h.serverFor(333, { tmux: "/wedged/hint,333,0", socket: null })).toBeNull();
  // An inbox with no hint at all is still placed, in the same drain.
  expect(h.serverFor(111, { tmux: null, socket: null })).toEqual({
    kind: "path",
    value: join(dir, "b"),
  });
  expect(calls).toEqual([["/wedged/hint"], ["a", "b"].map((name) => join(dir, name))]);
});

test("a probe killed at the budget is not cached as silent: the next drain asks it again", () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-probe-slow-"));
  writeFileSync(join(dir, "slow"), "");
  const slow = join(dir, "slow");
  // One cache across both drains, as the file carries it from one process to
  // the next.
  const cache = loadSocketCache(null);
  let loaded = true;
  const calls: (readonly string[])[] = [];
  const host = () =>
    tmuxInboxHost({
      socketDirectory: dir,
      own: [],
      cache,
      probeBudgetMs: 200,
      // A live server under load: too slow for the first drain's budget.
      probe: (sockets, budget) => {
        calls.push(sockets);
        if (loaded) {
          nap(budget);
          return new Map();
        }
        return new Map(sockets.map((socket) => [socket, 555]));
      },
    });
  expect(host().serverFor(555, { tmux: null, socket: null })).toBeNull();
  const stat = statSync(slow);
  expect(cache.skip(slow, { ino: stat.ino, mtime: stat.mtimeMs }, 555, () => true)).toBe(false);
  loaded = false;
  expect(host().serverFor(555, { tmux: null, socket: null })).toEqual({
    kind: "path",
    value: slow,
  });
  expect(calls).toEqual([[slow], [slow]]);
});

test("a drain limited to some keys leaves every other inbox alone, unlocated", () => {
  const s = store();
  write({ event: "prompt_submitted" });
  const other = event({ server_pid: SERVER + 1, root_pid: 99 });
  expect(writeInboxEvent(other)).toBe(true);
  const asked: number[] = [];
  const h = host();
  const summary = drainInbox(s, {
    host: {
      ...h,
      serverFor: (pid, hints) => {
        asked.push(pid);
        return h.serverFor(pid, hints);
      },
    },
    mux: fakeMux({ panesInWindow: () => [asPaneId("%1")] }),
    keys: [inboxKey(SERVER, ROOT)],
  });
  expect(summary).toMatchObject({ applied: 1, removed: 0 });
  // Only the asked-for inbox was located: the other's server was never looked for.
  expect(asked).toEqual([SERVER]);
  expect(readdirSync(join(inboxDir(), inboxKey(SERVER + 1, 99)))).toHaveLength(1);
  // A key with no inbox drains nothing and asks nothing.
  expect(drainInbox(s, { host: h, keys: ["0".repeat(32)] })).toMatchObject({ applied: 0 });
});

test("an event's socket hint is validated, and a bad one costs only the hint", () => {
  expect(parseServerSocket({ kind: "default" })).toEqual({ kind: "default" });
  expect(parseServerSocket({ kind: "label", value: "mule" })).toEqual({
    kind: "label",
    value: "mule",
  });
  expect(parseServerSocket({ kind: "path", value: "/tmp/rig/s" })).toEqual({
    kind: "path",
    value: "/tmp/rig/s",
  });
  // A label is a name in the reader's socket directory, never a way out of it.
  expect(parseServerSocket({ kind: "label", value: "../../etc/x" })).toBeNull();
  expect(parseServerSocket({ kind: "path", value: "relative/s" })).toBeNull();
  expect(parseServerSocket({ kind: "label", value: "" })).toBeNull();
  expect(parseServerSocket({ kind: "socket", value: "/x" })).toBeNull();
  expect(parseServerSocket("default")).toBeNull();
  expect(parseServerSocket(undefined)).toBeNull();

  const s = store();
  write({ server_socket: { kind: "label", value: "../x" } });
  expect(drain(s)).toMatchObject({ applied: 1, malformed: 0 });
});
