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
  agent_name: "worker-1",
  workstream: "murmur",
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

test("claude and codex are tagged with their report, cursor-agent is tagged cursor", () => {
  const claude = dashFrame([{ ...pane, harness: "claude", message: "editing view.ts" }], 80);
  expect(claude).toContain(" claude");
  expect(claude).toContain("editing view.ts");
  const codex = dashFrame([{ ...pane, harness: "codex", title: "gpt-5" }], 80);
  expect(codex).toContain(" codex");
  expect(codex).toContain("gpt-5");
  expect(codex).not.toContain("·  ");
  expect(dashFrame([{ ...pane, harness: "cursor-agent" }], 80)).toContain(" cursor");
});

test("a null harness has no tag", () => {
  const frame = dashFrame([{ ...pane, harness: null, message: "m" }], 80);
  for (const name of ["claude", "codex", "cursor", "muse"]) expect(frame).not.toContain(name);
});

test("a mu remote worker's card names the host it runs on, via here", () => {
  // Human-driven only so the default crew filter shows the card: the host line
  // reads runs_on whoever drives the row.
  const frame = dashFrame([{ ...pane, runs_on: "linuxpc" }], 80);
  expect(frame).toContain("linuxpc via here");
  expect(dashFrame([pane], 80)).not.toContain("via here");
});
