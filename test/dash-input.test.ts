import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { expect, test } from "vitest";
import { SSH_OPTIONS } from "../src/channel.js";
import {
  acknowledgeAttention,
  buildClearDelivery,
  buildEscapeDelivery,
  buildPromptDelivery,
  dashFilter,
  editComposer,
  emptyComposer,
  emptyFilter,
  type InputDelivery,
  sendEscape,
  sendPrompt,
} from "../src/dash-input.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import type { Store } from "../src/store.js";
import type { PaneView } from "../src/view.js";

test("composer inserts and edits text at the cursor", () => {
  let state = editComposer(emptyComposer(), { type: "insert", text: "helo" });
  state = editComposer(state, { type: "left" });
  state = editComposer(state, { type: "insert", text: "l" });
  expect(state).toEqual({ text: "hello", cursor: 4 });

  state = editComposer(state, { type: "backspace" });
  state = editComposer(state, { type: "delete" });
  expect(state).toEqual({ text: "hel", cursor: 3 });
});

test("composer moves across a Unicode glyph without splitting it", () => {
  let state = editComposer(emptyComposer(), { type: "insert", text: "a🙂b" });
  state = editComposer(state, { type: "left" });
  state = editComposer(state, { type: "left" });
  state = editComposer(state, { type: "delete" });
  expect(state).toEqual({ text: "ab", cursor: 1 });
});

test("composer moves to either end and preserves pasted newlines", () => {
  let state = editComposer(emptyComposer(), { type: "insert", text: "one\ntwo" });
  state = editComposer(state, { type: "home" });
  state = editComposer(state, { type: "insert", text: ">" });
  state = editComposer(state, { type: "end" });
  state = editComposer(state, { type: "insert", text: "<" });
  expect(state).toEqual({ text: ">one\ntwo<", cursor: 9 });
});

function pane(local: boolean, id = "%9"): PaneView {
  return {
    host_id: local ? "LOCAL" : "remote-host",
    host: local ? "here" : "dev",
    local,
    server: { kind: "default" },
    pane: asPaneId(id),
    session: asSessionId("$1"),
    window: asWindowId("@1"),
    session_name: "work",
    window_name: "agent",
    activity: "running",
    attention: [],
    freshness: "fresh",
    agent_id: "agent-1",
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
    runs_on: null,
  };
}

test("local prompt delivery keeps prompt bytes on stdin", () => {
  const delivery = buildPromptDelivery(pane(true), "hello 'remote'\nsecond", null, "input-1");
  expect(delivery).toEqual({
    command: "tmux",
    // `-L default`: a bare tmux follows $TMUX, so a dash inside another server
    // would deliver to that server's `%9`.
    args: [
      "-L",
      "default",
      "load-buffer",
      "-b",
      "input-1",
      "-",
      ";",
      "paste-buffer",
      "-b",
      "input-1",
      "-t",
      "%9",
      "-p",
      "-d",
      ";",
      "send-keys",
      "-t",
      "%9",
      "Enter",
    ],
    input: "hello 'remote'\nsecond",
  });
});

test("remote prompt delivery wraps tmux in ssh and quotes the pane", () => {
  const delivery = buildPromptDelivery(pane(false, "%9'bad"), "secret", "dev", "input-1");
  expect(delivery.command).toBe("ssh");
  expect(delivery.args).toContain("dev");
  expect(delivery.args).toContain("'%9'\\''bad'");
  expect(delivery.args.filter((arg) => arg === "\\;")).toHaveLength(2);
  expect(delivery.args).not.toContain("secret");
  expect(delivery.input).toBe("secret");
});

test("Escape delivery has no prompt input", () => {
  expect(buildEscapeDelivery(pane(true), null)).toEqual({
    command: "tmux",
    args: ["-L", "default", "send-keys", "-t", "%9", "Escape"],
    input: "",
  });
});

test("delivery reports runner failures", async () => {
  const store = { peers: () => [] } as unknown as Store;
  await expect(
    sendPrompt(store, pane(true), "keep me", async () => {
      throw new Error("tmux pane is gone");
    }),
  ).resolves.toEqual({ ok: false, message: "tmux pane is gone" });
});

test("remote delivery refuses an unresolved peer", async () => {
  const store = { peers: () => [] } as unknown as Store;
  await expect(sendPrompt(store, pane(false), "keep me")).resolves.toEqual({
    ok: false,
    message: "no peer for dev",
  });
});

/**
 * The filter editor seam.
 *
 * A pure reducer so the `/` transitions are assertable without rendering a
 * dash: the query is session-local state in `dash.tsx`, and the only thing
 * worth testing about it is which key does what to it.
 */

test("slash opens filter editing and printable text lands in the query", () => {
  let state = emptyFilter();
  expect(state).toEqual({ editing: false, query: emptyComposer() });

  state = dashFilter(state, { type: "open" });
  expect(state.editing).toBe(true);

  state = dashFilter(state, { type: "edit", edit: { type: "insert", text: "work" } });
  expect(state.query.text).toBe("work");
});

test("Backspace and Delete edit the query, and typing is ignored when closed", () => {
  let state = dashFilter(emptyFilter(), { type: "open" });
  state = dashFilter(state, { type: "edit", edit: { type: "insert", text: "worker" } });
  state = dashFilter(state, { type: "edit", edit: { type: "backspace" } });
  expect(state.query.text).toBe("worke");

  state = dashFilter(state, { type: "edit", edit: { type: "left" } });
  state = dashFilter(state, { type: "edit", edit: { type: "delete" } });
  expect(state.query.text).toBe("work");

  const closed = dashFilter(state, { type: "accept" });
  expect(dashFilter(closed, { type: "edit", edit: { type: "insert", text: "x" } })).toEqual(closed);
});

test("Enter keeps the query and leaves editing; slash resumes it", () => {
  let state = dashFilter(emptyFilter(), { type: "open" });
  state = dashFilter(state, { type: "edit", edit: { type: "insert", text: "dash" } });
  state = dashFilter(state, { type: "accept" });
  expect(state).toEqual({ editing: false, query: { text: "dash", cursor: 4 } });

  // `/` re-enters with the query intact rather than starting over.
  expect(dashFilter(state, { type: "open" })).toEqual({
    editing: true,
    query: { text: "dash", cursor: 4 },
  });
});

test("Escape clears the query, whether editing or navigating", () => {
  let state = dashFilter(emptyFilter(), { type: "open" });
  state = dashFilter(state, { type: "edit", edit: { type: "insert", text: "dash" } });
  expect(dashFilter(state, { type: "cancel" })).toEqual(emptyFilter());

  const kept = dashFilter(state, { type: "accept" });
  expect(dashFilter(kept, { type: "cancel" })).toEqual(emptyFilter());
});

test("acknowledging a local pane runs the focus-hook clear, not ssh", async () => {
  const store = { peers: () => [] } as unknown as Store;
  const cleared: string[] = [];
  const target = {
    ...pane(true),
    attention: [{ kind: "done" as const, requested_at: 1, message: "" }],
  };
  const result = await acknowledgeAttention(
    store,
    target,
    (id) => cleared.push(id),
    async () => {
      throw new Error("must not run");
    },
  );
  expect(result).toEqual({ ok: true });
  expect(cleared).toEqual(["%9"]);
});

test("acknowledging a pane with no attention does nothing", async () => {
  const store = { peers: () => [] } as unknown as Store;
  const cleared: string[] = [];
  const result = await acknowledgeAttention(
    store,
    pane(false),
    (id) => cleared.push(id),
    async () => {
      throw new Error("must not run");
    },
  );
  expect(result).toEqual({ ok: true });
  expect(cleared).toEqual([]);
});

test("acknowledging a remote pane runs murmur clear on its node", async () => {
  const store = {
    peers: () => [{ host_id: "remote-host", name: "dev", target: "dev" }],
  } as unknown as Store;
  const target = {
    ...pane(false, "%9'bad"),
    attention: [{ kind: "done" as const, requested_at: 1, message: "" }],
  };
  const runs: unknown[] = [];
  const result = await acknowledgeAttention(
    store,
    target,
    () => {
      throw new Error("must not clear locally");
    },
    async (delivery) => void runs.push(delivery),
  );
  expect(result).toEqual({ ok: true });
  expect(runs).toEqual([buildClearDelivery(target, "dev")]);
  expect(buildClearDelivery(target, "dev").args.slice(-5)).toEqual([
    "dev",
    "murmur",
    "clear",
    "--pane",
    "'%9'\\''bad'",
  ]);
});

test("prompt and Escape reach only the selected server's pane, locally and over ssh", async () => {
  // Two real servers, each with a `%0`. Deliveries that ignored the server sent
  // to whichever `%0` a bare tmux found. The non-target must receive nothing.
  //
  // Private sockets under a short TMUX_TMPDIR (macOS's per-user $TMPDIR is too
  // long for a unix socket path), torn down on every exit path.
  const root = mkdtempSync("/tmp/murmur-dash-");
  const labels = [`murmur-dash-a-${process.pid}`, `murmur-dash-b-${process.pid}`];
  const previous = process.env.TMUX_TMPDIR;
  process.env.TMUX_TMPDIR = root;
  const tmux = (label: string, ...args: string[]) =>
    execFileSync("tmux", ["-L", label, "-f", "/dev/null", ...args], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const screen = (label: string) => tmux(label, "capture-pane", "-p", "-t", "%0");
  // ssh's remote half: the words after the target, joined, run by a shell.
  const viaSsh = (delivery: InputDelivery) => {
    if (delivery.command !== "ssh") throw new Error("expected ssh");
    execFileSync("sh", ["-c", delivery.args.slice(SSH_OPTIONS.length + 1).join(" ")], {
      input: delivery.input,
      timeout: 10_000,
      stdio: ["pipe", "ignore", "pipe"],
    });
    return Promise.resolve();
  };
  const settle = (predicate: () => boolean) => {
    const deadline = Date.now() + 5_000;
    while (!predicate() && Date.now() < deadline) execFileSync("sleep", ["0.05"]);
  };
  try {
    for (const label of labels) tmux(label, "new-session", "-d", "-x", "80", "-y", "10", "cat");
    for (const label of labels) {
      expect(tmux(label, "list-panes", "-a", "-F", "#{pane_id}").trim()).toBe("%0");
    }
    const [a, b] = labels as [string, string];
    const on = (label: string, local: boolean): PaneView => ({
      ...pane(local, "%0"),
      server: { kind: "label", value: label },
    });
    const store = {
      peers: () => [{ host_id: "remote-host", name: "dev", target: "dev" }],
    } as unknown as Store;

    await expect(sendPrompt(store, on(b, true), "local-to-b")).resolves.toEqual({ ok: true });
    await expect(sendPrompt(store, on(a, false), "remote-to-a", viaSsh)).resolves.toEqual({
      ok: true,
    });
    await expect(sendEscape(store, on(b, false), viaSsh)).resolves.toEqual({ ok: true });
    settle(() => screen(a).includes("remote-to-a") && screen(b).includes("^["));

    expect(screen(b)).toContain("local-to-b");
    expect(screen(b)).toContain("^[");
    expect(screen(a)).toContain("remote-to-a");
    expect(screen(a)).not.toContain("local-to-b");
    expect(screen(a)).not.toContain("^[");
    expect(screen(b)).not.toContain("remote-to-a");
  } finally {
    for (const label of labels) {
      try {
        tmux(label, "kill-server");
      } catch {
        // Never started.
      }
    }
    if (previous === undefined) delete process.env.TMUX_TMPDIR;
    else process.env.TMUX_TMPDIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("acknowledging names the pane's server, locally and on its node", async () => {
  const server = { kind: "path" as const, value: "/tmp/private sock" };
  const attention = [{ kind: "done" as const, requested_at: 1, message: "" }];
  const store = {
    peers: () => [{ host_id: "remote-host", name: "dev", target: "dev" }],
  } as unknown as Store;
  const cleared: unknown[] = [];
  await acknowledgeAttention(
    store,
    { ...pane(true), server, attention },
    (id, named) => cleared.push([id, named]),
    async () => {
      throw new Error("must not run");
    },
  );
  expect(cleared).toEqual([["%9", server]]);
  expect(buildClearDelivery({ ...pane(false), server }, "dev").args.slice(-6)).toEqual([
    "murmur",
    "clear",
    "--pane",
    "'%9'",
    "-S",
    "'/tmp/private sock'",
  ]);
});
