import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ALERT_WINDOW_MS, type AlertEvent, alertHook, fireAlerts, runHook } from "../src/alert.js";
import { collect } from "../src/collector.js";
import { DASH_COLOR, DASH_GLYPH, hostColor } from "../src/dash-paint.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { openStore, type Store } from "../src/store.js";
import type { AttentionKind, LocalPane, Location, Snapshot } from "../src/types.js";
import { paneViews } from "../src/view.js";
import { localPane, vtmuxMux, vtmuxRow } from "./helpers/panes.js";

const IDENTITY = { host_id: "LOCAL", display_name: "here" };
const NOW = 100_000_000;
let store: Store;

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-alert-"));
  store = openStore();
  local = [];
});

afterEach(() => store.close());

function location(pane: string): Location {
  return {
    server: { kind: "default" },
    pane: asPaneId(pane),
    session: asSessionId("$0"),
    window: asWindowId("@0"),
    session_name: "hacking/murmur",
    window_name: "w",
  };
}

/** This node's live panes, as a local read would answer them. */
let local: LocalPane[] = [];

/** A local pane whose program reports `kind`, entered at `at`. */
function ask(
  pane: string,
  kind: Exclude<AttentionKind, "crashed">,
  at = NOW,
  message = "",
  focused = false,
) {
  local = local.filter((entry) => entry.pane !== pane);
  local.push(
    localPane({
      ...location(pane),
      focused,
      agent: { activity: "stopped", updated_at: at },
      attention: [{ kind, message, source: "pi", driver: "human", requested_at: at }],
    }),
  );
}

const views = (now = NOW, from: Store = store) => paneViews(from, IDENTITY, local, now);

function recorder(): { run: (hook: string, event: AlertEvent) => void; fired: AlertEvent[] } {
  const fired: AlertEvent[] = [];
  return { fired, run: (_hook, event) => void fired.push(event) };
}

test("each attention event fires once, across repeated and concurrent readers", () => {
  ask("%1", "done");
  ask("%2", "error", NOW, "529 overloaded");
  const r = recorder();

  fireAlerts(store, views(), NOW, "/hook", r.run);
  fireAlerts(store, views(), NOW + 1, "/hook", r.run);
  // A second process on the same database is the status bar beside the dash.
  const other = openStore();
  fireAlerts(other, views(NOW, other), NOW + 2, "/hook", r.run);
  other.close();

  expect(r.fired.map((event) => [event.pane, event.kind, event.message]).sort()).toEqual([
    ["%1", "done", ""],
    ["%2", "error", "529 overloaded"],
  ]);
});

test("a state entered again is a new event; one that holds is not", () => {
  // The key carries `requested_at`, which is when the pane entered its state
  // (`pane_program_state_time`): a `done` that holds across collects is one
  // event, a pane that worked again and finished again is a second.
  ask("%1", "done", NOW);
  const r = recorder();
  fireAlerts(store, views(), NOW, "/hook", r.run);
  fireAlerts(store, views(NOW + 1_000), NOW + 1_000, "/hook", r.run);
  expect(r.fired).toHaveLength(1);

  ask("%1", "done", NOW + 5_000);
  fireAlerts(store, views(NOW + 5_000), NOW + 5_000, "/hook", r.run);

  expect(r.fired).toHaveLength(2);
});

test("an event on the pane the operator is looking at is claimed, not announced", () => {
  // They already see it. Claimed, so looking away later does not announce
  // something they watched happen.
  ask("%1", "done", NOW, "", true);
  ask("%2", "blocked", NOW, "needs permission", false);
  const r = recorder();
  const fired = fireAlerts(store, views(), NOW, "/hook", r.run);
  expect(fired.map((event) => event.pane)).toEqual(["%2"]);
  expect(r.fired.map((event) => event.pane)).toEqual(["%2"]);

  ask("%1", "done", NOW, "", false);
  fireAlerts(store, views(NOW + 1_000), NOW + 1_000, "/hook", r.run);
  expect(r.fired.map((event) => event.pane)).toEqual(["%2"]);
});

test("focus is local: a remote pane's event always fires", () => {
  // A peer's focus says nothing about this operator; the wire does not even
  // carry it.
  store.addPeer("dev", "dev");
  store.replacePeerSnapshot("dev", {
    ok: true,
    at: NOW,
    snapshot: {
      murmur_snapshot: 8,
      host_id: "REMOTE",
      display_name: "Remote",
      murmur_version: "x",
      generated_at: NOW,
      panes: [
        {
          ...location("%9"),
          agent: null,
          attention: [
            { kind: "done", message: "", source: "pi", driver: "human", requested_at: NOW },
          ],
        },
      ],
    },
  });
  const [event] = fireAlerts(store, views(), NOW, "/hook", recorder().run);
  expect(event).toMatchObject({ pane: "%9", local: false, focused: false });
});

test("old news does not fire: the backlog on first install stays quiet", () => {
  ask("%1", "blocked", NOW - ALERT_WINDOW_MS - 1);
  const r = recorder();
  fireAlerts(store, views(), NOW, "/hook", r.run);
  expect(r.fired).toEqual([]);
});

test("no hook installed means no event and no claim, so installing one later still fires", () => {
  ask("%1", "done");
  const r = recorder();
  expect(fireAlerts(store, views(), NOW, null, r.run)).toEqual([]);
  fireAlerts(store, views(), NOW, "/hook", r.run);
  expect(r.fired).toHaveLength(1);
});

test("collect fires for a remote peer's events and a crash it found locally", async () => {
  // Remote: a done on another node, arriving in its snapshot.
  store.addPeer("dev", "dev");
  const remote: Snapshot = {
    murmur_snapshot: 8,
    host_id: "REMOTE",
    display_name: "Remote",
    murmur_version: "x",
    generated_at: NOW,
    panes: [
      {
        ...location("%9"),
        agent: null,
        attention: [
          { kind: "error", message: "boom", source: "pi", driver: "human", requested_at: NOW },
        ],
      },
    ],
  };
  // Local: a working agent whose pane vanishes, which only the local read's
  // memory can see, and a program that reports `done` itself.
  const rows = [
    vtmuxRow({ pane: "%1", state: "working", app: "pi", pane_title: "worker" }),
    vtmuxRow({ pane: "%2", state: "working", app: "claude", pane_title: "reviewer" }),
  ];
  const mux = vtmuxMux(rows);
  const r = recorder();
  const options = {
    mux,
    rex: false as const,
    alerts: { hook: "/hook", run: r.run, identity: IDENTITY },
  };
  await collect(store, { exec: async () => JSON.stringify(remote) }, NOW, options);
  expect(r.fired.map((event) => [event.host, event.agent, event.kind])).toEqual([
    ["dev", "w", "error"],
  ]);

  rows.splice(
    0,
    rows.length,
    vtmuxRow({
      pane: "%2",
      state: "done",
      app: "claude",
      pane_title: "reviewer",
      message: "review posted",
      state_time: String(Math.floor((NOW + 500) / 1000)),
    }),
  );
  await collect(store, { exec: async () => JSON.stringify(remote) }, NOW + 1_000, options);

  expect(
    r.fired.map((event) => [event.host, event.agent, event.kind, event.message]).sort(),
  ).toEqual([
    ["dev", "w", "error", "boom"],
    ["here", "reviewer", "done", "review posted"],
    ["here", "worker", "crashed", "pane vanished while working"],
  ]);
});

test("collect claims but does not announce an event on the focused pane", async () => {
  // `#{pane_active}` of the active window of an attached session: the
  // operator is looking at it.
  const rows = [vtmuxRow({ pane: "%1", state: "done", focused: "1", pane_title: "worker" })];
  const r = recorder();
  const options = {
    mux: vtmuxMux(rows),
    rex: false as const,
    alerts: { hook: "/hook", run: r.run, identity: IDENTITY },
  };
  await collect(store, { exec: async () => "" }, NOW, options);
  expect(r.fired).toEqual([]);

  // Looking away does not announce what they watched happen.
  rows.splice(0, 1, vtmuxRow({ pane: "%1", state: "done", focused: "0", pane_title: "worker" }));
  await collect(store, { exec: async () => "" }, NOW + 1_000, options);
  expect(r.fired).toEqual([]);
});

test("the hook runs with the event in its environment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-hook-"));
  const out = join(dir, "out");
  const hook = join(dir, "on-attention");
  writeFileSync(
    hook,
    `#!/bin/sh\nprintf '%s|%s|%s|%s|%s|%s' "$MURMUR_KIND" "$MURMUR_AGENT" "$MURMUR_MESSAGE" "$MURMUR_HOST_COLOR" "$MURMUR_GLYPH" "$MURMUR_KIND_COLOR" > '${out}.tmp' && mv '${out}.tmp' '${out}'\n`,
  );
  chmodSync(hook, 0o755);
  expect(alertHook(dir)).toBe(hook);

  ask("%1", "error", NOW, "429 rate limit");
  const [event] = fireAlerts(store, views(), NOW, hook, runHook);
  expect(event?.agent).toBe("w");

  for (let i = 0; i < 200 && !existsSync(out); i += 1) await new Promise((r) => setTimeout(r, 10));
  expect(readFileSync(out, "utf8")).toBe(
    `error|w|429 rate limit|${hostColor("here")}|${DASH_GLYPH.error}|${DASH_COLOR.error}`,
  );
});

test("a hook that is missing or not executable is no hook", () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-hook-"));
  expect(alertHook(dir)).toBeNull();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "on-attention"), "#!/bin/sh\n");
  chmodSync(join(dir, "on-attention"), 0o644);
  expect(alertHook(dir)).toBeNull();
});
