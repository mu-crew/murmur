import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { render } from "ink";
import { createElement } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "../src/cli/dash.js";
import { loadDashPrefs } from "../src/dash-prefs.js";
import { openDashStore } from "../src/dash-store.js";
import { dashRows } from "../src/dash-view.js";
import { createIdentity } from "../src/identity.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { status } from "../src/status.js";
import type { TmuxServer } from "../src/types.js";
import { recordedPanes } from "./helpers/panes.js";

// The dashboard App itself, driven by keys, against two real private tmux
// servers that each have a %0. Helper-level tests cannot see App stop calling
// the helpers, or call them with the wrong row: this selects the SECOND row
// with `j`, opens its composer with `i`, and asserts which server's %0 was
// acknowledged.

/** The stdin ink reads keys from: `readable`, then `read()` until null. */
class KeyStdin extends EventEmitter {
  isTTY = true;
  private pending: string | null = null;
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read() {
    const chunk = this.pending;
    this.pending = null;
    return chunk;
  }
  press(chunk: string) {
    this.pending = chunk;
    this.emit("readable");
  }
}

class FrameStdout extends EventEmitter {
  columns = 120;
  rows = 30;
  frames: string[] = [];
  write(chunk?: unknown) {
    this.frames.push(String(chunk));
    return true;
  }
}

let root: string;
// The "default" server is named by its explicit socket path under the private
// TMUX_TMPDIR: the same socket murmur's `-L default` resolves there, and never
// the developer's own default server.
let servers: string[][] = [];
const tmuxOn = (server: string[], ...args: string[]) =>
  execFileSync("tmux", [...server, "-f", "/dev/null", ...args], {
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TMUX_TMPDIR: root, TMUX: "" },
  }).trim();

beforeEach(() => {
  // Short, for the unix socket length limit; both servers live under it.
  root = mkdtempSync("/tmp/murmur-dash-app-");
  vi.stubEnv("TMUX_TMPDIR", root);
  const directory = join(root, `tmux-${process.getuid?.() ?? 0}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  servers = [
    ["-S", join(directory, "default")],
    ["-S", join(directory, "private")],
  ];
  for (const server of servers) tmuxOn(server, "new-session", "-d", "-s", "work", "sleep 300");
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const server of servers) {
    try {
      tmuxOn(server, "kill-server");
    } catch {
      // Already gone.
    }
  }
  rmSync(root, { recursive: true, force: true });
});

/** Poll until `done()`; the deadline only bounds a hang, it is not a pacing delay. */
async function until(done: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await sleep(10);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("opening the composer on the second of two %0s acknowledges that server's %0 only", async () => {
  const identity = createIdentity("here");
  const dashStore = openDashStore();
  const { store } = dashStore;
  const DEFAULT: TmuxServer = { kind: "default" };
  const PRIVATE: TmuxServer = { kind: "label", value: "private" };
  // The private %0 crashed later and so sorts second (crashes are oldest
  // first), which is the row a selection by host and pane id alone, or a
  // clear without its server (the dash's own server is the default), would
  // both get wrong. Explicit times: two crashes in one millisecond would tie
  // and fall back to address order.
  const now = Date.now();
  for (const [server, at] of [
    [PRIVATE, now - 1_000],
    [DEFAULT, now - 2_000],
  ] as const) {
    store.recordCrash(
      {
        server,
        session: asSessionId("$0"),
        window: asWindowId("@0"),
        pane: asPaneId("%0"),
        session_name: null,
        window_name: null,
      },
      at,
    );
  }
  const initial = status(store, identity, recordedPanes(store), Date.now());
  const rows = dashRows(initial.panes, loadDashPrefs(), Date.now());
  expect(rows.map((row) => [row.server.kind, row.pane])).toEqual([
    ["default", "%0"],
    ["label", "%0"],
  ]);

  const stdin = new KeyStdin();
  const stdout = new FrameStdout();
  const instance = render(createElement(App, { dashStore, initial }), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: new FrameStdout() as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  const attention = () =>
    Object.fromEntries(
      store.localPanes().map((pane) => [pane.server.kind, pane.attention.map((a) => a.kind)]),
    );
  let left: Record<string, string[]> = {};
  try {
    // First frame drawn, then the key's redraw, before the next key.
    await until(() => stdout.frames.some((frame) => frame.includes("crashed")));
    const drawn = stdout.frames.length;
    stdin.press("j");
    await until(() => stdout.frames.length > drawn);
    stdin.press("i");
    const deadline = Date.now() + 5_000;
    const total = () => Object.values(attention()).flat().length;
    while (Date.now() < deadline && total() === 2) {
      await sleep(50);
    }
    // Let the composer's follow-up redraw land before reading and closing.
    const settled = stdout.frames.length;
    await until(() => stdout.frames.length > settled, 1_000);
    left = attention();
  } finally {
    instance.unmount();
    // An in-flight refresh still reads the store after unmount.
    await sleep(500);
    store.close();
  }
  // Acknowledged: the private row has no attention left (and, with no agent,
  // no row); the default %0 keeps its own.
  expect({ ...left, label: left.label ?? [] }).toEqual({ default: ["crashed"], label: [] });
}, 20_000);
