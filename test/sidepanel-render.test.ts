import { PassThrough } from "node:stream";
import { render as renderInk, renderToString } from "ink";
import { createElement } from "react";
import { expect, test, vi } from "vitest";
import { App, SidepanelRefreshTracker, settleSidepanelRenderer } from "../src/cli/sidepanel.js";
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

function renderFrame(initial: Status, compact = false): string {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    return renderToString(
      createElement(App, {
        dashStore,
        initial,
        origin,
        initialPrefs: { ...DEFAULT_DASH_PREFS, compact },
        now: 120_001,
        dimensions: { columns: 40, rows: 12 },
      }),
    );
  } finally {
    stderr.mockRestore();
  }
}

test("the first frame renders local and remote agent facts", () => {
  const output = renderFrame(
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
  expect(output).toContain("? help");
  expect(output).not.toContain("j/k move");
});

test("compact mode renders each agent on one line", () => {
  const output = renderFrame(view([pane()]), true);

  expect(output).toContain(`▸ ${String.fromCodePoint(0xf04b)} worker-1 · running · here · 2m`);
  expect(output.split("\n").filter((line) => line.includes("worker-1"))).toHaveLength(1);
});

test("the first frame renders the empty state", () => {
  const output = renderFrame(view([]));

  expect(output).toContain("murmur · 0 agents");
  expect(output).toContain("No visible agents");
});

test("question mark toggles the keys overlay", async () => {
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  const output = new PassThrough() as unknown as NodeJS.WriteStream;
  const writes: Buffer[] = [];
  Object.assign(input, {
    isTTY: true,
    setRawMode: () => input,
    ref: () => undefined,
    unref: () => undefined,
  });
  Object.assign(output, { isTTY: true, columns: 40, rows: 12 });
  output.on("data", (chunk: Buffer) => writes.push(chunk));
  const instance = renderInk(
    createElement(App, {
      dashStore,
      initial: view([pane()]),
      origin,
      initialPrefs: DEFAULT_DASH_PREFS,
      dimensions: { columns: 40, rows: 12 },
      deps: { refresh: async () => view([pane()]) },
    }),
    { stdin: input, stdout: output, patchConsole: false },
  );

  // Ink attaches its input listener after the first frame; a key written
  // before that is dropped. Wait for the list to render first. 5s, not the 1s
  // default: a CI runner took just over a second to paint this.
  const settle = { timeout: 5_000 };
  await vi.waitFor(() => expect(Buffer.concat(writes).toString()).toContain("worker-1"), settle);
  const beforeOpen = writes.length;
  input.write("?");
  await vi.waitFor(
    () => expect(Buffer.concat(writes.slice(beforeOpen)).toString()).toContain("shortcuts"),
    settle,
  );
  const beforeClose = writes.length;
  input.write("?");
  await vi.waitFor(
    () => expect(Buffer.concat(writes.slice(beforeClose)).toString()).toContain("worker-1"),
    settle,
  );
  await instance.unmount();
});

test("a failed close after activation keeps the renderer mounted", async () => {
  const events: string[] = [];
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  const output = new PassThrough() as unknown as NodeJS.WriteStream;
  Object.assign(input, {
    isTTY: true,
    setRawMode: () => input,
    ref: () => undefined,
    unref: () => undefined,
  });
  Object.assign(output, { isTTY: true, columns: 40, rows: 12 });
  const instance = renderInk(
    createElement(App, {
      dashStore,
      initial: view([pane()]),
      origin,
      initialPrefs: DEFAULT_DASH_PREFS,
      dimensions: { columns: 40, rows: 12 },
      deps: {
        refresh: async () => view([pane()]),
        jump: () => {
          events.push("jump");
          return { ok: true as const };
        },
        close: () => {
          events.push("close");
          return { ok: false as const, message: "layout failed" };
        },
      },
    }),
    { stdin: input, stdout: output, patchConsole: false },
  );
  let exited = false;
  void instance.waitUntilExit().then(() => {
    exited = true;
  });

  input.write("\r");
  await vi.waitFor(() => expect(events).toEqual(["jump", "close"]));
  await new Promise((resolve) => setImmediate(resolve));
  expect(exited).toBe(false);
  await instance.unmount();
});

test("an in-flight refresh settles before the store closes after unmount", async () => {
  let resolveRefresh: ((status: Status) => void) | undefined;
  const pending = new Promise<Status>((resolve) => {
    resolveRefresh = resolve;
  });
  const events: string[] = [];
  const writes: Buffer[] = [];
  const tracker = new SidepanelRefreshTracker();
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  const output = new PassThrough() as unknown as NodeJS.WriteStream;
  Object.assign(input, {
    isTTY: true,
    setRawMode: () => input,
    ref: () => undefined,
    unref: () => undefined,
  });
  Object.assign(output, { isTTY: true, columns: 40, rows: 12 });
  output.on("data", (chunk: Buffer) => writes.push(chunk));
  const instance = renderInk(
    createElement(App, {
      dashStore,
      initial: view([pane()]),
      origin,
      initialPrefs: DEFAULT_DASH_PREFS,
      dimensions: { columns: 40, rows: 12 },
      refreshTracker: tracker,
      deps: {
        refresh: () => {
          events.push("refresh");
          return pending;
        },
        close: () => ({ ok: true as const }),
      },
    }),
    { stdin: input, stdout: output, patchConsole: false },
  );

  await vi.waitFor(() => expect(events).toEqual(["refresh"]));
  input.write(Buffer.from("\x03"));
  await instance.waitUntilExit();
  const closing = settleSidepanelRenderer(tracker, () => events.push("closed"));
  events.push("unmounted");
  await Promise.resolve();
  const writesAfterUnmount = writes.length;
  expect(events).toEqual(["refresh", "unmounted"]);

  resolveRefresh?.(view([]));
  await closing;
  await new Promise((resolve) => setImmediate(resolve));
  expect(events).toEqual(["refresh", "unmounted", "closed"]);
  expect(writes).toHaveLength(writesAfterUnmount);
});
