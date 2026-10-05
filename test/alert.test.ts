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
import type { AttentionKind, Location, Snapshot } from "../src/types.js";
import { paneViews } from "../src/view.js";
import { fakeMux } from "./helpers/fake-mux.js";

const IDENTITY = { host_id: "LOCAL", display_name: "here" };
const NOW = 100_000_000;
let store: Store;

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-alert-"));
  store = openStore();
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

function ask(pane: string, kind: Exclude<AttentionKind, "crashed">, at = NOW, message = "") {
  store.requestAttention({ kind, location: location(pane), message, source: "pi", now: at });
}

function recorder(): { run: (hook: string, event: AlertEvent) => void; fired: AlertEvent[] } {
  const fired: AlertEvent[] = [];
  return { fired, run: (_hook, event) => void fired.push(event) };
}

test("each attention event fires once, across repeated and concurrent readers", () => {
  ask("%1", "done");
  ask("%2", "error", NOW, "529 overloaded");
  const r = recorder();

  fireAlerts(store, paneViews(store, IDENTITY, NOW), NOW, "/hook", r.run);
  fireAlerts(store, paneViews(store, IDENTITY, NOW), NOW + 1, "/hook", r.run);
  // A second process on the same database is the status bar beside the dash.
  const other = openStore();
  fireAlerts(other, paneViews(other, IDENTITY, NOW), NOW + 2, "/hook", r.run);
  other.close();

  expect(r.fired.map((event) => [event.pane, event.kind, event.message]).sort()).toEqual([
    ["%1", "done", ""],
    ["%2", "error", "529 overloaded"],
  ]);
});

test("a request raised again after it was acknowledged is a new event", () => {
  ask("%1", "done", NOW);
  const r = recorder();
  fireAlerts(store, paneViews(store, IDENTITY, NOW), NOW, "/hook", r.run);

  store.acknowledgePane(location("%1"));
  ask("%1", "done", NOW + 5_000);
  fireAlerts(store, paneViews(store, IDENTITY, NOW + 5_000), NOW + 5_000, "/hook", r.run);

  expect(r.fired).toHaveLength(2);
});

test("old news does not fire: the backlog on first install stays quiet", () => {
  ask("%1", "blocked", NOW - ALERT_WINDOW_MS - 1);
  const r = recorder();
  fireAlerts(store, paneViews(store, IDENTITY, NOW), NOW, "/hook", r.run);
  expect(r.fired).toEqual([]);
});

test("no hook installed means no event and no claim, so installing one later still fires", () => {
  ask("%1", "done");
  const r = recorder();
  expect(fireAlerts(store, paneViews(store, IDENTITY, NOW), NOW, null, r.run)).toEqual([]);
  fireAlerts(store, paneViews(store, IDENTITY, NOW), NOW, "/hook", r.run);
  expect(r.fired).toHaveLength(1);
});

test("collect fires for a remote peer's events and a crash it found locally", async () => {
  // Remote: a done on another node, arriving in its snapshot.
  store.addPeer("dev", "dev");
  const remote: Snapshot = {
    murmur_snapshot: 5,
    host_id: "REMOTE",
    display_name: "Remote",
    murmur_version: "x",
    generated_at: NOW,
    panes: [
      {
        ...location("%9"),
        agent: null,
        attention: [{ kind: "error", message: "boom", source: "pi", requested_at: NOW }],
      },
    ],
  };
  // Local: a running agent whose pid is gone, which only reconcile can see.
  store.claimAgent({
    location: location("%1"),
    owner_pid: 999_999_999,
    meta: {
      agent_name: "worker",
      pi_session: null,
      workstream: null,
      role: null,
      cli: "pi",
      driver: "human",
    },
    now: NOW,
    isAlive: () => true,
  });
  const claimed = store.localPanes()[0]?.agent?.agent_id ?? "";
  store.setActivity({
    agent_id: claimed,
    owner_pid: 999_999_999,
    activity: "running",
    location: location("%1"),
    now: NOW,
  });

  const r = recorder();
  await collect(store, { exec: async () => JSON.stringify(remote) }, NOW, {
    mux: fakeMux({ livePanes: () => new Set([asPaneId("%1")]) }),
    alerts: { hook: "/hook", run: r.run, identity: IDENTITY },
  });

  expect(r.fired.map((event) => [event.host, event.agent, event.kind]).sort()).toEqual([
    ["dev", "w", "error"],
    ["here", "worker", "crashed"],
  ]);
});

test("the hook runs with the event in its environment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-hook-"));
  const out = join(dir, "out");
  const hook = join(dir, "on-attention");
  writeFileSync(
    hook,
    `#!/bin/sh\nprintf '%s|%s|%s|%s|%s|%s' "$MURMUR_KIND" "$MURMUR_AGENT" "$MURMUR_MESSAGE" "$MURMUR_HOST_COLOR" "$MURMUR_GLYPH" "$MURMUR_KIND_COLOR" > '${out}'\n`,
  );
  chmodSync(hook, 0o755);
  expect(alertHook(dir)).toBe(hook);

  ask("%1", "error", NOW, "429 rate limit");
  const [event] = fireAlerts(store, paneViews(store, IDENTITY, NOW), NOW, hook, runHook);
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
