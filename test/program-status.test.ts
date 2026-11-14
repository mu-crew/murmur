import { expect, test } from "vitest";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import {
  diffRecords,
  fleetRecords,
  formatClear,
  formatRecord,
  paneRecord,
  recordId,
  reported,
  rootRecord,
} from "../src/program-status.js";
import type { Status } from "../src/status.js";
import { emptyCounts, type PaneView } from "../src/view.js";

function pane(over: Partial<PaneView> = {}): PaneView {
  return {
    host_id: "H",
    host: "linuxpc",
    local: false,
    server: { kind: "default" },
    pane: asPaneId("%3"),
    session: asSessionId("$0"),
    window: asWindowId("@0"),
    session_name: "mu-auth",
    window_name: null,
    activity: "running",
    attention: [],
    freshness: "fresh",
    agent_id: "a",
    agent_name: "worker-1",
    pi_session: null,
    workstream: null,
    role: null,
    cli: "pi",
    harness: null,
    driver: "human",
    model: null,
    provider: null,
    effort: null,
    provider_effort: null,
    context_pct: null,
    context_tokens: null,
    context_window: null,
    usage: null,
    pending: null,
    updated_at: 1,
    snapshot_at: null,
    fetched_at: null,
    attached_pane: null,
    ...over,
  };
}

const blocked = [{ kind: "blocked" as const, requested_at: 1, message: "pick a migration" }];

function view(panes: PaneView[]): Status {
  return { counts: emptyCounts(), orchestrated_counts: emptyCounts(), panes, peers: [] };
}

/** Decode a report's pairs, base64 values decoded, for assertions. */
function pairs(seq: string): Record<string, string> {
  expect(seq.startsWith("\x1b]7501;") && seq.endsWith("\x1b\\")).toBe(true);
  const body = seq.slice("\x1b]7501;".length, -2);
  return Object.fromEntries(
    body.split(":").map((p) => {
      const at = p.indexOf("=");
      const k = p.slice(0, at);
      const v = p.slice(at + 1);
      return [k, k === "title" || k === "msg" ? Buffer.from(v, "base64").toString("utf8") : v];
    }),
  );
}

test("the pill's rule: humans unless idle, crew only when a human is needed", () => {
  expect(reported(pane())).toBe(true);
  expect(reported(pane({ activity: "stopped" }))).toBe(false);
  expect(reported(pane({ driver: "orchestrated" }))).toBe(false);
  expect(reported(pane({ driver: "orchestrated", attention: blocked }))).toBe(true);
  expect(
    reported(
      pane({ driver: "orchestrated", attention: [{ kind: "done", requested_at: 1, message: "" }] }),
    ),
  ).toBe(false);
});

test("a blocked remote agent reads as blocked, titled host and name, with its message", () => {
  const r = pairs(formatRecord(paneRecord(pane({ attention: blocked }))));
  expect(r).toMatchObject({
    state: "blocked",
    kind: "question",
    app: "murmur",
    title: "linuxpc · worker-1",
    msg: "pick a migration",
  });
  expect(r.id).toMatch(/^crew\/[0-9a-f]{8}$/);
});

test("crashed is an error, waiting is working, and a local agent has no host in its title", () => {
  const crashed = [{ kind: "crashed" as const, requested_at: 1, message: "" }];
  expect(paneRecord(pane({ attention: crashed })).state).toBe("error");
  expect(paneRecord(pane({ activity: "stopped", pending: 2 })).state).toBe("working");
  expect(paneRecord(pane({ local: true })).title).toBe("worker-1");
});

test("record ids are stable per pane and differ across hosts and servers", () => {
  const a = recordId(pane());
  expect(recordId(pane({ activity: "stopped" }))).toBe(a);
  expect(recordId(pane({ host_id: "OTHER" }))).not.toBe(a);
  expect(recordId(pane({ server: { kind: "label", value: "mule" } }))).not.toBe(a);
});

test("the root names the most urgent state and counts", () => {
  const records = fleetRecords(
    view([
      pane({ attention: blocked }),
      pane({ pane: asPaneId("%4") }),
      pane({ pane: asPaneId("%5") }),
    ]),
  );
  expect(records[0]).toEqual({
    id: null,
    state: "blocked",
    kind: "question",
    msg: "1 blocked, 2 working",
  });
  expect(rootRecord([])).toEqual({ id: null, state: "idle", msg: "nothing needs you" });
});

test("control characters never reach a report, and long titles are cut to the limit", () => {
  const r = pairs(
    formatRecord({ id: null, state: "done", title: "é".repeat(200), msg: "line one\nline two" }),
  );
  expect(r.msg).toBe("line one\uFFFDline two");
  expect(Buffer.byteLength(r.title ?? "", "utf8")).toBeLessThanOrEqual(192);
});

test("the diff sends only changed records and clears the ones that went away", () => {
  const first = diffRecords(new Map(), fleetRecords(view([pane({ attention: blocked })])));
  expect(first.writes).toHaveLength(2);
  const same = diffRecords(first.now, fleetRecords(view([pane({ attention: blocked })])));
  expect(same.writes).toEqual([]);
  const gone = diffRecords(first.now, fleetRecords(view([])));
  const id = recordId(pane());
  expect(gone.writes).toContain(formatClear(id));
  expect(pairs(gone.writes[0] as string)).toMatchObject({
    state: "idle",
    msg: "nothing needs you",
  });
});
