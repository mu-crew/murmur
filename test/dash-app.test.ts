import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
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
  write() {
    return true;
  }
}

let root: string;
const servers: string[][] = [[], ["-L", "private"]];
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("opening the composer on the second of two %0s acknowledges that server's %0 only", async () => {
  const identity = createIdentity("here");
  const dashStore = openDashStore();
  const { store } = dashStore;
  const DEFAULT: TmuxServer = { kind: "default" };
  const PRIVATE: TmuxServer = { kind: "label", value: "private" };
  // The private %0 is requested first and so sorts second, which is the row
  // a selection by host and pane id alone, or a clear without its server (the
  // dash's own server is the default), would both get wrong.
  for (const server of [PRIVATE, DEFAULT]) {
    store.requestAttention({
      kind: "done",
      location: {
        server,
        session: asSessionId("$0"),
        window: asWindowId("@0"),
        pane: asPaneId("%0"),
        session_name: null,
        window_name: null,
      },
      message: "",
      source: "pi",
      driver: "human",
    });
  }
  const initial = status(store, identity, Date.now());
  const rows = dashRows(initial.panes, loadDashPrefs(), Date.now());
  expect(rows.map((row) => [row.server.kind, row.pane])).toEqual([
    ["default", "%0"],
    ["label", "%0"],
  ]);

  const stdin = new KeyStdin();
  const instance = render(createElement(App, { dashStore, initial }), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: new FrameStdout() as unknown as NodeJS.WriteStream,
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
    await sleep(200);
    stdin.press("j");
    await sleep(200);
    stdin.press("i");
    const deadline = Date.now() + 5_000;
    const total = () => Object.values(attention()).flat().length;
    while (Date.now() < deadline && total() === 2) {
      await sleep(50);
    }
    // Let the composer's follow-up redraw land before reading and closing.
    await sleep(300);
    left = attention();
  } finally {
    instance.unmount();
    // An in-flight refresh still reads the store after unmount.
    await sleep(500);
    store.close();
  }
  // Acknowledged: the private row has no attention left (and, with no agent,
  // no row); the default %0 keeps its own.
  expect({ ...left, label: left.label ?? [] }).toEqual({ default: ["done"], label: [] });
}, 20_000);
