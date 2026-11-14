import { renderToString } from "ink";
import { createElement } from "react";
import { expect, test, vi } from "vitest";
import { App } from "../src/cli/dash.js";
import type { DashStore } from "../src/dash-store.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import type { Status } from "../src/status.js";
import type { PaneView } from "../src/view.js";

const pane: PaneView = {
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
};
const counts = { crashed: 0, error: 0, blocked: 0, done: 0, running: 1, waiting: 0, idle: 0 };
const initial: Status = {
  counts,
  orchestrated_counts: {
    crashed: 0,
    error: 0,
    blocked: 0,
    done: 0,
    running: 0,
    waiting: 0,
    idle: 0,
  },
  panes: [pane],
  peers: [],
};

/** First render is the seam that catches same-scope temporal-dead-zone errors. */
test("dash renders its first frame", () => {
  const dashStore = {
    store: {},
    generation: { dev: 0n, ino: 0n },
  } as unknown as DashStore;

  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    expect(() => renderToString(createElement(App, { dashStore, initial }))).not.toThrow();
  } finally {
    stderr.mockRestore();
  }
});

function dashFrame(panes: PaneView[], columns: number): string {
  const dashStore = {
    store: {},
    generation: { dev: 0n, ino: 0n },
  } as unknown as DashStore;
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    return renderToString(createElement(App, { dashStore, initial: { ...initial, panes } }), {
      columns,
    });
  } finally {
    stderr.mockRestore();
  }
}

test("a dash card carries a dim harness tag and the pi card is otherwise unchanged", () => {
  const plain = dashFrame([pane], 80);
  const tagged = dashFrame([{ ...pane, harness: "pi" }], 80);
  const squash = (text: string) => text.replace(/ +/g, " ");
  expect(plain).not.toMatch(/ pi\b/);
  const header = tagged.split("\n").find((line) => line.includes("worker-1")) ?? "";
  expect(header).toMatch(/ pi\b/);
  // Byte-identical once the tag is taken out (column padding aside).
  expect(squash(tagged.replace(/ pi\b/, ""))).toBe(squash(plain));
});

test("claude shows model and effort, codex model only, cursor-agent is tagged cursor", () => {
  const claude = dashFrame([{ ...pane, harness: "claude", model: "opus-4", effort: "medium" }], 80);
  expect(claude).toContain(" claude");
  expect(claude).toContain("opus-4 · medium");
  const codex = dashFrame([{ ...pane, harness: "codex", model: "gpt-5" }], 80);
  expect(codex).toContain(" codex");
  expect(codex).toContain("gpt-5");
  expect(codex).not.toContain("·  ");
  expect(dashFrame([{ ...pane, harness: "cursor-agent" }], 80)).toContain(" cursor");
});

test("a null harness has no tag", () => {
  const frame = dashFrame([{ ...pane, harness: null, model: "m" }], 80);
  for (const name of ["claude", "codex", "cursor", "muse"]) expect(frame).not.toContain(name);
});

test("a narrow dash (30 columns) lays out as it does without a tag", () => {
  const width = (frame: string) => Math.max(...frame.split("\n").map((line) => line.length));
  const tagged = dashFrame([{ ...pane, harness: "claude", model: "opus-4", effort: "medium" }], 30);
  expect(tagged).toContain("worker-1");
  expect(width(tagged)).toBe(width(dashFrame([pane], 30)));
});
