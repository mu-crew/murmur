import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { afterAll, expect, test } from "vitest";
import { asPaneId, asWindowId } from "../src/ids.js";
import {
  closeSidepanel,
  findSidepanel,
  openSidepanel,
  SIDEPANEL_ROLE,
  SIDEPANEL_ROLE_OPTION,
  type SidepanelTmux,
  sidepanelOrigin,
  toggleSidepanel,
} from "../src/sidepanel-controller.js";

type Result = ReturnType<SidepanelTmux["run"]>;

function ok(stdout = ""): Result {
  return { ok: true, stdout, error: "" };
}

function fail(error: string): Result {
  return { ok: false, stdout: "", error };
}

function scriptedTmux(results: Result[]): SidepanelTmux & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run(args) {
      calls.push(args);
      return results.shift() ?? fail("unexpected tmux call");
    },
  };
}

const origin = { window: asWindowId("@1"), pane: asPaneId("%2") };
const splitLayout = "0000,120x40,0,0{25x40,0,0,9,94x40,26,0,2}";
const openLayout = "ea71,120x40,0,0{30x40,0,0,9,89x40,31,0,2}";

test("origin prefers TMUX_PANE and resolves its exact window and pane", () => {
  const outside = scriptedTmux([]);
  expect(sidepanelOrigin({}, outside)).toBeNull();
  expect(outside.calls).toEqual([]);

  const tmux = scriptedTmux([ok("@7\t%2")]);
  expect(sidepanelOrigin({ TMUX: "socket,1,0", TMUX_PANE: "%2" }, tmux)).toEqual({
    window: asWindowId("@7"),
    pane: asPaneId("%2"),
  });
  expect(tmux.calls).toEqual([["display-message", "-t", "%2", "-p", "#{window_id}\t#{pane_id}"]]);
});

test("origin asks tmux for the invoking client's active pane under run-shell", () => {
  const tmux = scriptedTmux([ok("%4"), ok("@7\t%4")]);

  expect(sidepanelOrigin({ TMUX: "socket,1,0" }, tmux)).toEqual({
    window: asWindowId("@7"),
    pane: asPaneId("%4"),
  });
  expect(tmux.calls).toEqual([
    ["display-message", "-p", "#{pane_id}"],
    ["display-message", "-t", "%4", "-p", "#{window_id}\t#{pane_id}"],
  ]);
});

test("origin rejects failed, malformed, or retargeted pane resolution", () => {
  expect(sidepanelOrigin({ TMUX_PANE: "%2" }, scriptedTmux([fail("gone")]))).toBeNull();
  expect(sidepanelOrigin({ TMUX_PANE: "%2" }, scriptedTmux([ok("@1")]))).toBeNull();
  expect(sidepanelOrigin({ TMUX_PANE: "%2" }, scriptedTmux([ok("@1\t%3")]))).toBeNull();
});

test("findSidepanel searches only the target window for the exact role", () => {
  const tmux = scriptedTmux([ok("%2\tother\n%9\tsidepanel")]);
  expect(findSidepanel(asWindowId("@1"), tmux)).toBe(asPaneId("%9"));
  expect(tmux.calls).toEqual([["list-panes", "-t", "@1", "-F", "#{pane_id}\t#{@murmur_role}"]]);

  expect(findSidepanel(asWindowId("@2"), scriptedTmux([ok("%8\tside-panel")]))).toBeNull();
});

test("duplicate marked panes fail safely instead of choosing one", () => {
  const tmux = scriptedTmux([ok("@1\t%2"), ok("%8\tsidepanel\n%9\tsidepanel")]);
  expect(toggleSidepanel(["node", "cli"], { TMUX_PANE: "%2" }, tmux)).toEqual({
    ok: false,
    message: "multiple side panels found in window @1",
  });
  expect(tmux.calls).toHaveLength(2);
});

test.each([
  [100, "25"],
  [320, "32"],
  [500, "40"],
])("open passes clamped width for a %i-column window", (windowWidth, expected) => {
  const tmux = scriptedTmux([ok(String(windowWidth)), ok("%9"), ok(), ok(splitLayout), ok(), ok()]);

  expect(openSidepanel(origin, ["node", "cli", "argument with spaces"], tmux)).toEqual({
    ok: true,
    panel: asPaneId("%9"),
  });
  expect(tmux.calls[1]).toEqual([
    "split-window",
    "-hbf",
    "-l",
    expected,
    "-t",
    "%2",
    "-d",
    "-P",
    "-F",
    "#{pane_id}",
    "--",
    "node",
    "cli",
    "argument with spaces",
  ]);
  expect(tmux.calls[2]).toEqual([
    "set-option",
    "-p",
    "-t",
    "%9",
    SIDEPANEL_ROLE_OPTION,
    SIDEPANEL_ROLE,
  ]);
  expect(tmux.calls[3]).toEqual(["display-message", "-t", "@1", "-p", "#{window_layout}"]);
  expect(tmux.calls[4]?.slice(0, 3)).toEqual(["select-layout", "-t", "@1"]);
  expect(tmux.calls[5]).toEqual(["select-pane", "-t", "%9"]);
});

test("open rejects an unusable width before splitting", () => {
  for (const rawWidth of ["25", "not-a-number"]) {
    const tmux = scriptedTmux([ok(rawWidth)]);
    expect(openSidepanel(origin, ["node"], tmux).ok).toBe(false);
    expect(tmux.calls).toHaveLength(1);
  }
});

test("open never kills a malformed pane target returned by tmux", () => {
  const tmux = scriptedTmux([ok("120"), ok("not-a-pane")]);

  expect(openSidepanel(origin, ["node"], tmux)).toEqual({
    ok: false,
    message: "tmux returned an invalid side panel pane id",
  });
  expect(tmux.calls.some((args) => args[0] === "kill-pane")).toBe(false);
});

test("open rolls back only the new pane when marking fails", () => {
  const tmux = scriptedTmux([ok("120"), ok("%9"), fail("mark denied"), ok()]);
  expect(openSidepanel(origin, ["node"], tmux)).toEqual({
    ok: false,
    message: "could not mark side panel: mark denied",
  });
  expect(tmux.calls.at(-1)).toEqual(["kill-pane", "-t", "%9"]);
});

test.each([
  ["malformed layout", [ok("120"), ok("%9"), ok(), ok("bad"), ok()]],
  [
    "layout application failure",
    [ok("120"), ok("%9"), ok(), ok(splitLayout), fail("bad layout"), ok()],
  ],
] as const)("open rolls back on %s", (_name, results) => {
  const tmux = scriptedTmux([...results]);
  expect(openSidepanel(origin, ["node"], tmux).ok).toBe(false);
  expect(tmux.calls.at(-1)).toEqual(["kill-pane", "-t", "%9"]);
});

test("focus failure reports the error but leaves the valid marked panel open", () => {
  const tmux = scriptedTmux([
    ok("120"),
    ok("%9"),
    ok(),
    ok(splitLayout),
    ok(),
    fail("focus denied"),
  ]);
  expect(openSidepanel(origin, ["node"], tmux)).toEqual({
    ok: false,
    message: "side panel opened but could not be focused: focus denied",
  });
  expect(tmux.calls.some((args) => args[0] === "kill-pane")).toBe(false);
});

test("close verifies the panel role and window before reading layout", () => {
  const wrongWindow = scriptedTmux([ok("@2\t%9\tsidepanel")]);
  expect(closeSidepanel(asWindowId("@1"), asPaneId("%9"), wrongWindow).ok).toBe(false);
  expect(wrongWindow.calls).toHaveLength(1);

  const wrongRole = scriptedTmux([ok("@1\t%9\tother")]);
  expect(closeSidepanel(asWindowId("@1"), asPaneId("%9"), wrongRole).ok).toBe(false);
  expect(wrongRole.calls).toHaveLength(1);
});

test("close reads the live layout then queues kill before layout application", () => {
  const tmux = scriptedTmux([ok("@1\t%9\tsidepanel"), ok(openLayout), ok()]);
  expect(closeSidepanel(asWindowId("@1"), asPaneId("%9"), tmux)).toEqual({ ok: true });
  expect(tmux.calls[2]).toEqual([
    "kill-pane",
    "-t",
    "%9",
    ";",
    "select-layout",
    "-t",
    "@1",
    "aaff,120x40,0,0,2",
  ]);
});

test("close leaves the panel open when layout read or parsing fails", () => {
  for (const layoutResult of [fail("read denied"), ok("bad")]) {
    const tmux = scriptedTmux([ok("@1\t%9\tsidepanel"), layoutResult]);
    expect(closeSidepanel(asWindowId("@1"), asPaneId("%9"), tmux).ok).toBe(false);
    expect(tmux.calls.some((args) => args[0] === "kill-pane")).toBe(false);
  }
});

test("a failed queued close reports tmux's error", () => {
  const tmux = scriptedTmux([ok("@1\t%9\tsidepanel"), ok(openLayout), fail("layout rejected")]);
  expect(closeSidepanel(asWindowId("@1"), asPaneId("%9"), tmux)).toEqual({
    ok: false,
    message: "could not close side panel: layout rejected",
  });
});

test("toggle opens when absent and closes the marked panel when present", () => {
  const opening = scriptedTmux([
    ok("@1\t%2"),
    ok("%2\t"),
    ok("120"),
    ok("%9"),
    ok(),
    ok(splitLayout),
    ok(),
    ok(),
  ]);
  expect(toggleSidepanel(["node"], { TMUX_PANE: "%2" }, opening)).toEqual({ ok: true });

  const closing = scriptedTmux([
    ok("@1\t%2"),
    ok("%2\t\n%9\tsidepanel"),
    ok("@1\t%9\tsidepanel"),
    ok(openLayout),
    ok(),
  ]);
  expect(toggleSidepanel(["node"], { TMUX_PANE: "%2" }, closing)).toEqual({ ok: true });
});

const SOCKET = `murmur-sidepanel-${process.pid}`;
const TMUX = ["-L", SOCKET, "-f", "/dev/null"];
let socketPath: string | null = null;

function rig(...args: string[]): string {
  return execFileSync("tmux", [...TMUX, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

afterAll(() => {
  try {
    socketPath = rig("display-message", "-p", "#{socket_path}");
  } catch {}
  try {
    rig("kill-server");
  } catch {}
  if (socketPath) rmSync(socketPath, { force: true });
});

test("a real tmux accepts queued removal after the panel is killed", () => {
  rig("new-session", "-d", "-s", "sidepanel-close", "-x", "120", "-y", "40", "sleep 300");
  const window = asWindowId(rig("display-message", "-t", "sidepanel-close", "-p", "#{window_id}"));
  const panel = asPaneId(
    rig(
      "split-window",
      "-t",
      window,
      "-hbf",
      "-l",
      "30",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "sleep 300",
    ),
  );
  rig("set-option", "-p", "-t", panel, SIDEPANEL_ROLE_OPTION, SIDEPANEL_ROLE);
  const tmux: SidepanelTmux = {
    run: (args) => {
      try {
        return ok(rig(...args));
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };

  expect(closeSidepanel(window, panel, tmux)).toEqual({ ok: true });
  expect(rig("list-panes", "-t", window, "-F", "#{pane_id}").split("\n")).toHaveLength(1);
});
