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
import { fakeMux } from "./helpers/fake-mux.js";

// The dashboard's own selection and acknowledge wiring, with two panes that
// share a host and a pane id and differ only in tmux server. The helpers they
// call are tested elsewhere; these pin that App uses them with the server.

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
    agent_id: `agent-${server.kind}`,
    agent_name: null,
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
  for (const server of [DEFAULT, PRIVATE]) {
    store.requestAttention({
      kind: "done",
      location: at(server, "%0"),
      message: "",
      source: "pi",
      driver: "human",
    });
  }
  const asked: TmuxServer[] = [];
  const mux = fakeMux({
    // The dash runs on the default server: a clear that dropped the server
    // resolves there and clears the wrong %0.
    currentView: () => null,
    currentWindow: () => at(DEFAULT, "%7"),
    windowForPane: (_pane, server) => {
      asked.push(server ?? DEFAULT);
      return asWindowId("@0");
    },
    panesInWindow: () => [asPaneId("%0")],
  });

  await expect(acknowledgeDashPane(store, row(PRIVATE), mux)).resolves.toEqual({ ok: true });

  expect(asked).toEqual([PRIVATE]);
  const left = store
    .localPanes()
    .map((pane) => [pane.server.kind, pane.attention.map((entry) => entry.kind)]);
  expect(left).toEqual([["default", ["done"]]]);
});
