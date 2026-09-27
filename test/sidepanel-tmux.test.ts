import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { afterAll, expect, test } from "vitest";
import { asPaneId, asWindowId, type PaneId, type WindowId } from "../src/ids.js";
import {
  closeSidepanel,
  openSidepanel,
  SIDEPANEL_ROLE,
  SIDEPANEL_ROLE_OPTION,
  type SidepanelTmux,
  toggleSidepanel,
} from "../src/sidepanel-controller.js";

const SOCKET = `murmur-sidepanel-geometry-${process.pid}`;
const PREFIX = ["-L", SOCKET, "-f", "/dev/null"];
let sequence = 0;
let socketPath: string | null = null;

type PaneGeometry = {
  id: PaneId;
  left: number;
  top: number;
  width: number;
  height: number;
  role: string;
};

function rig(...args: string[]): string {
  return execFileSync("tmux", [...PREFIX, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const tmux: SidepanelTmux = {
  run(args) {
    try {
      return { ok: true, stdout: rig(...args), error: "" };
    } catch (error) {
      const failure = error as Error & { stderr?: Buffer | string };
      return {
        ok: false,
        stdout: "",
        error:
          (typeof failure.stderr === "string"
            ? failure.stderr
            : failure.stderr?.toString()
          )?.trim() || failure.message,
      };
    }
  },
};

function session(): { name: string; window: WindowId; source: PaneId } {
  const name = `sidepanel-${process.pid}-${sequence++}`;
  rig("new-session", "-d", "-s", name, "-x", "120", "-y", "40", "sleep 300");
  return {
    name,
    window: asWindowId(rig("display-message", "-t", name, "-p", "#{window_id}")),
    source: asPaneId(rig("list-panes", "-t", name, "-F", "#{pane_id}")),
  };
}

function split(target: PaneId, direction: "-h" | "-v"): PaneId {
  return asPaneId(
    rig("split-window", direction, "-d", "-t", target, "-P", "-F", "#{pane_id}", "sleep 300"),
  );
}

function panes(window: WindowId): PaneGeometry[] {
  const output = rig(
    "list-panes",
    "-t",
    window,
    "-F",
    `#{pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\t#{${SIDEPANEL_ROLE_OPTION}}`,
  );
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, left, top, width, height, role = ""] = line.split("\t");
      if (!id || !left || !top || !width || !height) throw new Error(`bad pane row: ${line}`);
      return {
        id: asPaneId(id),
        left: Number(left),
        top: Number(top),
        width: Number(width),
        height: Number(height),
        role,
      };
    });
}

function dimensions(window: WindowId): { width: number; height: number } {
  const [width, height] = rig(
    "display-message",
    "-t",
    window,
    "-p",
    "#{window_width}\t#{window_height}",
  )
    .split("\t")
    .map(Number);
  if (!width || !height) throw new Error("missing window dimensions");
  return { width, height };
}

function open(window: WindowId, source: PaneId): PaneId {
  const result = openSidepanel({ window, pane: source }, ["sleep", "300"], tmux);
  if (!result.ok) throw new Error(result.message);
  return result.panel;
}

function assertFullWidth(window: WindowId, rows = panes(window)): void {
  const { width } = dimensions(window);
  expect(Math.min(...rows.map((pane) => pane.left))).toBe(0);
  expect(Math.max(...rows.map((pane) => pane.left + pane.width))).toBe(width);
}

function assertNoOverlap(rows: PaneGeometry[]): void {
  for (let left = 0; left < rows.length; left += 1) {
    for (let right = left + 1; right < rows.length; right += 1) {
      const a = rows[left];
      const b = rows[right];
      if (!a || !b) continue;
      const overlaps =
        a.left < b.left + b.width &&
        b.left < a.left + a.width &&
        a.top < b.top + b.height &&
        b.top < a.top + a.height;
      expect(overlaps).toBe(false);
    }
  }
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

test("one pane opens a marked full-height left panel and queued close restores width", () => {
  const { window, source } = session();
  const panel = open(window, source);
  const opened = panes(window);
  const panelGeometry = opened.find((pane) => pane.id === panel);
  expect(panelGeometry).toMatchObject({ left: 0, top: 0, height: 40, role: SIDEPANEL_ROLE });

  expect(closeSidepanel(window, panel, tmux)).toEqual({ ok: true });
  const closed = panes(window);
  expect(closed.map((pane) => pane.id)).toEqual([source]);
  expect(closed[0]).toMatchObject({ left: 0, top: 0, width: 120, height: 40, role: "" });
});

test("vertical source panes keep their heights beside the full-height panel", () => {
  const { window, source } = session();
  const lower = split(source, "-v");
  const before = new Map(panes(window).map((pane) => [pane.id, pane.height]));
  const panel = open(window, source);
  const opened = panes(window);

  expect(opened.find((pane) => pane.id === panel)).toMatchObject({ top: 0, height: 40 });
  expect(opened.find((pane) => pane.id === source)?.height).toBe(before.get(source));
  expect(opened.find((pane) => pane.id === lower)?.height).toBe(before.get(lower));
});

test("horizontal source panes survive and scale across the content width", () => {
  const { window, source } = session();
  const right = split(source, "-h");
  open(window, source);
  const content = panes(window).filter((pane) => pane.role !== SIDEPANEL_ROLE);

  expect(new Set(content.map((pane) => pane.id))).toEqual(new Set([source, right]));
  expect(content.every((pane) => pane.width > 0)).toBe(true);
  expect(Math.max(...content.map((pane) => pane.left + pane.width))).toBe(120);
});

test("nested source layout keeps every pane, does not overlap, and reaches the right edge", () => {
  const { window, source } = session();
  const right = split(source, "-h");
  const lowerRight = split(right, "-v");
  const panel = open(window, source);
  const opened = panes(window);

  expect(new Set(opened.map((pane) => pane.id))).toEqual(
    new Set([source, right, lowerRight, panel]),
  );
  expect(opened.find((pane) => pane.id === panel)).toMatchObject({ top: 0, height: 40 });
  assertNoOverlap(opened);
  expect(Math.max(...opened.map((pane) => pane.left + pane.width))).toBe(120);
});

test("a panel split while open is pruned into valid full-window geometry", () => {
  const { window, source } = session();
  const panel = open(window, source);
  const added = split(panel, "-v");

  expect(closeSidepanel(window, panel, tmux)).toEqual({ ok: true });
  const survivors = panes(window);
  expect(new Set(survivors.map((pane) => pane.id))).toEqual(new Set([source, added]));
  assertFullWidth(window, survivors);
  expect(Math.min(...survivors.map((pane) => pane.top))).toBe(0);
  expect(Math.max(...survivors.map((pane) => pane.top + pane.height))).toBe(40);
  assertNoOverlap(survivors);
});

test("a pane split while open survives queued close and fills the window", () => {
  const { window, source } = session();
  const panel = open(window, source);
  const added = split(source, "-v");

  expect(closeSidepanel(window, panel, tmux)).toEqual({ ok: true });
  const survivors = panes(window);
  expect(new Set(survivors.map((pane) => pane.id))).toEqual(new Set([source, added]));
  assertFullWidth(window, survivors);
});

test("survivors fill the window after a content pane is killed while open", () => {
  const { window, source } = session();
  const doomed = split(source, "-v");
  const panel = open(window, source);
  rig("kill-pane", "-t", doomed);

  expect(closeSidepanel(window, panel, tmux)).toEqual({ ok: true });
  const survivors = panes(window);
  expect(survivors.map((pane) => pane.id)).toEqual([source]);
  assertFullWidth(window, survivors);
});

test("toggle twice affects only the invoking window", () => {
  const first = session();
  const secondWindow = asWindowId(
    rig("new-window", "-d", "-t", first.name, "-P", "-F", "#{window_id}", "sleep 300"),
  );
  const secondBefore = panes(secondWindow);
  const env = { TMUX_PANE: first.source };

  expect(toggleSidepanel(["sleep", "300"], env, tmux)).toEqual({ ok: true });
  expect(panes(first.window)).toHaveLength(2);
  expect(panes(secondWindow)).toEqual(secondBefore);
  expect(toggleSidepanel(["sleep", "300"], env, tmux)).toEqual({ ok: true });
  expect(panes(first.window).map((pane) => pane.id)).toEqual([first.source]);
  expect(panes(secondWindow)).toEqual(secondBefore);
});

test("exact role matching closes only the marked panel", () => {
  const { window, source } = session();
  const unmarked = split(source, "-v");
  rig("set-option", "-p", "-t", unmarked, SIDEPANEL_ROLE_OPTION, "side-panel");
  const panel = open(window, source);

  expect(closeSidepanel(window, panel, tmux)).toEqual({ ok: true });
  const survivors = panes(window);
  expect(new Set(survivors.map((pane) => pane.id))).toEqual(new Set([source, unmarked]));
  expect(survivors.find((pane) => pane.id === unmarked)?.role).toBe("side-panel");
});
