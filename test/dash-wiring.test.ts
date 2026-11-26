import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { acknowledgeDashPane, selectedPaneIndex } from "../src/cli/dash.js";
import { dashPaneKey } from "../src/dash-tick.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { openStore, type Store } from "../src/store.js";
import type { TmuxServer } from "../src/types.js";
import type { PaneView } from "../src/view.js";

// The dashboard's selection and acknowledge helpers, with two panes that share
// a host and a pane id and differ only in tmux server. That App calls them, with
// the selected row, is pinned through App itself in dash-app.test.ts.

const DEFAULT = { kind: "default" } as const;
const at = (server: TmuxServer, pane: string) => ({
  server,
  session: asSessionId("$0"),
  window: asWindowId("@0"),
  pane: asPaneId(pane),
  session_name: null,
  window_name: null,
});
const PRIVATE = { kind: "label", value: "private" } as const;

function row(server: TmuxServer): PaneView {
  return {
    host_id: "LOCAL",
    host: "here",
    local: true,
    server,
    pane: asPaneId("%0"),
    session: asSessionId("$0"),
    window: asWindowId("@0"),
    session_name: "work",
    window_name: null,
    activity: "running",
    attention: [{ kind: "done", requested_at: 1, message: "" }],
    freshness: "fresh",
    agent_name: null,
    workstream: null,
    role: null,
    cli: "pi",
    harness: null,
    driver: "human",
    pending: null,
    updated_at: 1,
    snapshot_at: null,
    fetched_at: null,
    attached_pane: null,
    pane_title: null,
    title: null,
    message: null,
    progress: null,
    blocked_kind: null,
    resume_command: null,
    resume_cwd: null,
    cwd: null,
    focused: false,
    runs_on: null,
  };
}

let store: Store;

beforeEach(() => {
  vi.stubEnv("MURMUR_STATE_DIR", mkdtempSync(join(tmpdir(), "murmur-dash-wiring-")));
  store = openStore();
});

afterEach(() => {
  store.close();
  vi.unstubAllEnvs();
});

test("the dash selects the second of two equal pane ids on one host as itself", () => {
  const panes = [row(DEFAULT), row(PRIVATE)];
  expect(selectedPaneIndex(panes, dashPaneKey(row(PRIVATE)))).toBe(1);
  expect(selectedPaneIndex(panes, dashPaneKey(row(DEFAULT)))).toBe(0);
});

test("opening the composer on one %0 acknowledges only that server's %0", async () => {
  for (const server of [DEFAULT, PRIVATE]) store.recordCrash(at(server, "%0"));

  await expect(acknowledgeDashPane(store, row(PRIVATE))).resolves.toEqual({ ok: true });

  const left = store
    .localPanes()
    .map((pane) => [pane.server.kind, pane.attention.map((entry) => entry.kind)]);
  expect(left).toEqual([["default", ["crashed"]]]);
});

test("acknowledging a pane with no attention touches nothing", async () => {
  store.recordCrash(at(DEFAULT, "%0"));
  await expect(acknowledgeDashPane(store, { ...row(DEFAULT), attention: [] })).resolves.toEqual({
    ok: true,
  });
  expect(store.localPanes()).toHaveLength(1);
});
