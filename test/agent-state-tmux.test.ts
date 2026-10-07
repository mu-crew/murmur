import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { publishAgentStates } from "../src/agent-state.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { tmux } from "../src/mux.js";
import { openStore } from "../src/store.js";
import type { Location, TmuxServer } from "../src/types.js";

// A private server: publishing writes global options, which must never reach
// the user's own tmux.
const SOCKET = `murmur-agent-state-${process.pid}`;
const SERVER: TmuxServer = { kind: "label", value: SOCKET };

function rig(...args: string[]): string {
  return execFileSync("tmux", ["-L", SOCKET, "-f", "/dev/null", ...args], {
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

afterAll(() => {
  let socketPath: string | null = null;
  try {
    socketPath = rig("display-message", "-p", "#{socket_path}");
  } catch {}
  try {
    rig("kill-server");
  } catch {}
  if (socketPath) rmSync(socketPath, { force: true });
});

test("a publish to a real tmux server writes every option in one pass", () => {
  rig("new-session", "-d", "-s", "publish", "-x", "120", "-y", "40", "sleep 300");
  rig("split-window", "-d", "-t", "publish", "sleep 300");
  const rows = rig("list-panes", "-t", "publish", "-F", "#{session_id}\t#{window_id}\t#{pane_id}")
    .split("\n")
    .map((line) => line.split("\t"));
  const [session = "", window = "", agent = ""] = rows[0] ?? [];
  const shell = rows[1]?.[2] ?? "";

  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-agent-state-tmux-"));
  const store = openStore();
  const location: Location = {
    server: SERVER,
    session: asSessionId(session),
    window: asWindowId(window),
    pane: asPaneId(agent),
    session_name: null,
    window_name: null,
  };
  try {
    const claim = store.claimAgent({
      location,
      owner_pid: process.pid,
      meta: {
        // A label ending in `;` would split an unescaped chain.
        agent_name: "worker;",
        pi_session: null,
        workstream: null,
        role: null,
        cli: "pi",
        driver: "orchestrated",
      },
    });
    if (claim.outcome === "refused") throw new Error("claim refused");
    store.setActivity({
      agent_id: claim.agent_id,
      owner_pid: process.pid,
      activity: "running",
      location,
    });
    rig("set-option", "-pq", "-t", shell, "@murmur_pane_state", "stale");

    expect(publishAgentStates(asWindowId(window), tmux, store, SERVER)).toBe(true);
  } finally {
    store.close();
  }

  const show = (...args: string[]) => rig("show-options", "-qv", ...args);
  expect(show("-p", "-t", agent, "@murmur_pane_state")).toBe("working");
  expect(show("-p", "-t", agent, "@murmur_pane_label")).toBe("worker;");
  expect(show("-p", "-t", agent, "@murmur_pane_since")).toMatch(/^\d+$/);
  expect(show("-p", "-t", shell, "@murmur_pane_state")).toBe("");
  expect(show("-w", "-t", window, "@murmur_window_state")).toBe("working");
  expect(show("-w", "-t", window, "@murmur_window_has_agent")).toBe("1");
  expect(show("-t", session, "@murmur_session_state")).toBe("working");
  // A crew agent's running is in the crew total, not the human counts.
  expect(show("-g", "@murmur_count_crew")).toBe("1");
  expect(show("-g", "@murmur_count_working")).toBe("");
});
