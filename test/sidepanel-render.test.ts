import { renderToString } from "ink";
import { createElement } from "react";
import { expect, test, vi } from "vitest";
import { App } from "../src/cli/sidepanel.js";
import { DEFAULT_DASH_PREFS } from "../src/dash-prefs.js";
import type { DashStore } from "../src/dash-store.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import type { Status } from "../src/status.js";
import type { PaneView } from "../src/view.js";

function pane(over: Partial<PaneView> = {}): PaneView {
  return {
    host_id: "here",
    host: "here",
    local: true,
    server: { kind: "default" },
    pane: asPaneId("%1"),
    session: asSessionId("$1"),
    window: asWindowId("@1"),
    session_name: "work",
    window_name: null,
    activity: "running",
    attention: [],
    freshness: "fresh",
    agent_id: "agent-1",
    agent_name: "worker-1",
    pi_session: null,
    workstream: "murmur",
    role: null,
    cli: "pi",
    driver: "human",
    model: null,
    provider: null,
    effort: null,
    provider_effort: null,
    context_pct: null,
    context_tokens: null,
    context_window: null,
    usage: null,
    updated_at: 1,
    snapshot_at: null,
    fetched_at: null,
    attached_pane: null,
    ...over,
  };
}

const counts = { crashed: 0, blocked: 0, done: 0, running: 0, idle: 0 };
const dashStore = {
  store: {},
  generation: { dev: 0n, ino: 0n },
} as unknown as DashStore;
const origin = { window: asWindowId("@1"), pane: asPaneId("%9") };

function view(panes: PaneView[]): Status {
  return { counts, orchestrated_counts: counts, panes, peers: [] };
}

function render(initial: Status): string {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    return renderToString(
      createElement(App, {
        dashStore,
        initial,
        origin,
        initialPrefs: DEFAULT_DASH_PREFS,
        now: 120_001,
        dimensions: { columns: 40, rows: 12 },
      }),
    );
  } finally {
    stderr.mockRestore();
  }
}

test("the first frame renders local and remote agent facts", () => {
  const output = render(
    view([
      pane(),
      pane({
        host_id: "remote",
        host: "devbox",
        local: false,
        pane: asPaneId("%2"),
        agent_name: "reviewer-1",
        activity: "stopped",
        workstream: "sidepanel",
      }),
    ]),
  );

  expect(output).toContain("murmur · 2 agents");
  expect(output).toContain("worker-1");
  expect(output).toContain("running · here · 2m");
  expect(output).toContain("murmur");
  expect(output).toContain("reviewer-1");
  expect(output).toContain("idle · devbox · 2m");
  expect(output).toContain("sidepanel");
  expect(output).toContain("j/k move · ↵ jump · a crew · q close");
});

test("the first frame renders the empty state", () => {
  const output = render(view([]));

  expect(output).toContain("murmur · 0 agents");
  expect(output).toContain("No visible agents");
});
