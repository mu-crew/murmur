import { expect, test, vi } from "vitest";
import { DASH_PANE_OPTION } from "../src/goto.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import {
  chosenWindowName,
  conventionalTmuxDirectory,
  deriveTmuxServer,
  pidAlive,
  tmux,
  tmuxAgentState,
  tmuxArgs,
  tmuxServerAbsent,
} from "../src/mux.js";

const tmuxCalls = vi.hoisted(() => [] as string[][]);
// Queued answers, because a call that DEPENDS on what tmux said cannot be
// asserted against a fake that only ever says "".
const tmuxReplies = vi.hoisted(() => [] as string[]);
vi.mock("node:child_process", () => ({
  execFileSync: (_file: string, args: string[]) => {
    tmuxCalls.push(args);
    const reply = tmuxReplies.shift() ?? "";
    if (reply.startsWith("THROW:")) {
      throw Object.assign(new Error("tmux failed"), { stderr: reply.slice(6) });
    }
    return reply;
  },
}));

test.each([
  ["/tmp/tmux-501/default", { kind: "default" }],
  ["/tmp/tmux-501/mule", { kind: "label", value: "mule" }],
  ["/var/run/private.sock", { kind: "path", value: "/var/run/private.sock" }],
  ["/var/run/private,one.sock", { kind: "path", value: "/var/run/private,one.sock" }],
])("derives the tmux server from socket path %s", (socketPath, expected) => {
  expect(deriveTmuxServer(socketPath, "/tmp/tmux-501")).toEqual(expected);
});

test("tmux argv selects default, label, and path servers without a shell", () => {
  expect(tmuxArgs({ kind: "default" }, ["list-panes", "-a"])).toEqual([
    "-L",
    "default",
    "list-panes",
    "-a",
  ]);
  expect(tmuxArgs(undefined, ["list-panes", "-a"])).toEqual(["list-panes", "-a"]);
  expect(tmuxArgs({ kind: "label", value: "mule" }, ["list-panes", "-a"])).toEqual([
    "-L",
    "mule",
    "list-panes",
    "-a",
  ]);
  expect(tmuxArgs({ kind: "path", value: "/tmp/a,b.sock" }, ["list-panes", "-a"])).toEqual([
    "-S",
    "/tmp/a,b.sock",
    "list-panes",
    "-a",
  ]);
});

test("currentWindow records the socket-derived server", () => {
  const socket = `${conventionalTmuxDirectory()}/mule`;
  tmuxReplies.push(`$1\t@2\twork\treviewer\t0\t${socket}`);
  process.env.TMUX_PANE = "%34";
  try {
    expect(tmux.currentWindow()).toMatchObject({
      pane: "%34",
      server: { kind: "label", value: "mule" },
    });
  } finally {
    delete process.env.TMUX_PANE;
  }
});

test("a missing tmux server means no panes, other failures mean unknown", () => {
  expect(tmuxServerAbsent("no server running on /tmp/tmux-1000/default\n")).toBe(true);
  expect(
    tmuxServerAbsent("error connecting to /tmp/tmux-1000/mule (No such file or directory)\n"),
  ).toBe(true);
  expect(tmuxServerAbsent("error connecting to /tmp/tmux-1000/x (Permission denied)\n")).toBe(
    false,
  );
  expect(tmuxServerAbsent("")).toBe(false);
});

test("livePanes answers an empty set when no tmux server is running", () => {
  tmuxReplies.push("THROW:no server running on /tmp/tmux-1000/default");
  expect(tmux.livePanes()).toEqual(new Set());
  tmuxReplies.push("THROW:error connecting to /tmp/tmux-1000/x (Permission denied)");
  expect(tmux.livePanes()).toBe(null);
});

test("pidAlive is true for self and false for an unused pid", () => {
  expect(pidAlive(process.pid)).toBe(true);
  expect(pidAlive(2 ** 22)).toBe(false);
});

test("tmux agent states preserve the established working token", () => {
  expect(tmuxAgentState("running")).toBe("working");
  expect(tmuxAgentState("blocked")).toBe("blocked");
});

test("an idle-only agent window keeps its agent marker", () => {
  tmuxCalls.length = 0;

  tmux.setWindowState(asWindowId("@7"), null, undefined, true);

  expect(tmuxCalls).toEqual([
    ["set-window-option", "-qu", "-t", "@7", "@murmur_window_state"],
    ["set-window-option", "-q", "-t", "@7", "@murmur_window_has_agent", "1"],
    ["refresh-client", "-S"],
  ]);
});

test("a window without agents clears both murmur window options", () => {
  tmuxCalls.length = 0;

  tmux.setWindowState(asWindowId("@7"), null);

  expect(tmuxCalls).toEqual([
    ["set-window-option", "-qu", "-t", "@7", "@murmur_window_state"],
    ["set-window-option", "-qu", "-t", "@7", "@murmur_window_has_agent"],
    ["refresh-client", "-S"],
  ]);
});

test("pane state and label use distinct pane-scoped options", () => {
  const dateNow = vi.spyOn(Date, "now").mockReturnValue(1790000000000);
  tmuxCalls.length = 0;

  tmux.setPaneState(asPaneId("%7"), "running");
  tmux.setPaneState(asPaneId("%8"), null);
  tmux.setPaneLabel(asPaneId("%7"), "worker-1");
  tmux.setPaneLabel(asPaneId("%8"), null);

  expect(tmuxCalls).toEqual([
    [
      "if-shell",
      "-F",
      "-t",
      "%7",
      "#{!=:#{@murmur_pane_state},working}",
      "set-option -pq -t %7 @murmur_pane_since 1790000000000",
      "",
    ],
    ["set-option", "-pq", "-t", "%7", "@murmur_pane_state", "working"],
    ["set-option", "-pqu", "-t", "%8", "@murmur_pane_state"],
    ["set-option", "-pqu", "-t", "%8", "@murmur_pane_since"],
    ["set-option", "-pq", "-t", "%7", "@murmur_pane_label", "worker-1"],
    ["set-option", "-pqu", "-t", "%8", "@murmur_pane_label"],
  ]);
  dateNow.mockRestore();
});

test("state reads and writes select the location's private server", () => {
  tmuxCalls.length = 0;
  tmuxReplies.length = 0;
  tmuxReplies.push("%34");

  expect(tmux.panesInWindow(asWindowId("@7"), { kind: "label", value: "mule" })).toEqual(["%34"]);
  tmux.setWindowState(asWindowId("@7"), "done", { kind: "label", value: "mule" });

  expect(tmuxCalls).toEqual([
    ["-L", "mule", "list-panes", "-t", "@7", "-F", "#{pane_id}"],
    ["-L", "mule", "set-window-option", "-q", "-t", "@7", "@murmur_window_state", "done"],
    ["-L", "mule", "set-window-option", "-q", "-t", "@7", "@murmur_window_has_agent", "1"],
    ["-L", "mule", "refresh-client", "-S"],
  ]);
});

test("session state is session-scoped and uses the tmux working token", () => {
  tmuxCalls.length = 0;

  tmux.setSessionState(asSessionId("$3"), "running");
  tmux.setSessionState(asSessionId("$4"), null);

  expect(tmuxCalls).toEqual([
    ["set-option", "-q", "-t", "$3", "@murmur_session_state", "working"],
    ["set-option", "-qu", "-t", "$4", "@murmur_session_state"],
  ]);
});

test("sessionPanes names the window's session and every pane in it", () => {
  tmuxCalls.length = 0;
  tmuxReplies.length = 0;
  tmuxReplies.push("$2\t%1\n$2\t%5\n");

  expect(tmux.sessionPanes(asWindowId("@7"))).toEqual({ session: "$2", panes: ["%1", "%5"] });
  expect(tmuxCalls).toEqual([["list-panes", "-s", "-t", "@7", "-F", "#{session_id}\t#{pane_id}"]]);
});

test("state counts go out in one tmux call, unset at zero", () => {
  tmuxCalls.length = 0;

  tmux.setStateCounts({
    totals: { crashed: 0, blocked: 2, done: 0, running: 1, idle: 3 },
    crew: 4,
  });

  expect(tmuxCalls).toEqual([
    [
      ...["set-option", "-gqu", "@murmur_count_crashed", ";"],
      ...["set-option", "-gq", "@murmur_count_blocked", "2", ";"],
      ...["set-option", "-gqu", "@murmur_count_done", ";"],
      ...["set-option", "-gq", "@murmur_count_working", "1", ";"],
      ...["set-option", "-gq", "@murmur_count_idle", "3", ";"],
      ...["set-option", "-gq", "@murmur_count_crew", "4", ";"],
      ...["refresh-client", "-S"],
    ],
  ]);
});

// The picker's `agent` column showed `Python`, `node` and `zsh` for three real
// pi agents. All three are tmux's `automatic-rename` reporting the foreground
// process, and `agentLabel` prefers a window name over a session name -- so the
// process name shadowed `hacking/murmur`, the string a reader searches on.
test("a dash clears only the marker that names its own pane", () => {
  // Two dashes on one tmux server: the second overwrites the first's marker,
  // and an unconditional unset on exit would leave PREFIX G reporting "no
  // murmur dash is running" while a dash is on screen. The marker is a single
  // server-global option, so the only way the older dash can tell is to read it
  // back and compare before clearing.
  tmuxCalls.length = 0;
  tmuxReplies.length = 0;

  // A newer dash owns the marker: read it, change nothing.
  tmuxReplies.push("%9");
  tmux.unmarkDashPane(asPaneId("%7"));
  expect(tmuxCalls).toEqual([["show-options", "-gqv", DASH_PANE_OPTION]]);

  // The marker is our own: clear it.
  tmuxCalls.length = 0;
  tmuxReplies.push("%7");
  tmux.unmarkDashPane(asPaneId("%7"));
  expect(tmuxCalls).toEqual([
    ["show-options", "-gqv", DASH_PANE_OPTION],
    ["set-option", "-gqu", DASH_PANE_OPTION],
  ]);

  // Already unset, or a tmux that would not answer. Nothing to clear and
  // nothing to guess about.
  tmuxCalls.length = 0;
  tmux.unmarkDashPane(asPaneId("%7"));
  expect(tmuxCalls).toEqual([["show-options", "-gqv", DASH_PANE_OPTION]]);
});

test("a window tmux is auto-renaming contributes no name", () => {
  // The exact triple this bug produced: pi's interpreter, in a window tmux owns.
  expect(chosenWindowName("Python", "1")).toBe(null);
  expect(chosenWindowName("node", "1")).toBe(null);
  expect(chosenWindowName("zsh", "1")).toBe(null);
});

test("a window a human named keeps its name", () => {
  // The whole point of the rule: `automatic-rename` off means someone chose
  // this, whether by `rename-window`, a tmuxinator config, or mu.
  expect(chosenWindowName("reviewer", "0")).toBe("reviewer");
  // Even when what they chose LOOKS like a process name. The flag is the only
  // signal that carries intent; the string cannot.
  expect(chosenWindowName("Python", "0")).toBe("Python");
});

test("a name is absent, not empty, when tmux says nothing", () => {
  // Three spellings of "no answer", because the field is read out of a
  // tab-split and a missing trailing field arrives as undefined while a present
  // but empty one arrives as "". Both must reach the store as null: an empty
  // string is truthy enough for `??` to select it, so `agentLabel` would return
  // one and print a blank cell instead of falling through to the session name.
  expect(chosenWindowName("", "0")).toBe(null);
  expect(chosenWindowName(undefined, "0")).toBe(null);
  expect(chosenWindowName(undefined, undefined)).toBe(null);
});

test("an unparseable automatic-rename flag keeps the name", () => {
  // Fails toward the old behaviour. Only a literal "1" -- what
  // `#{?automatic-rename,1,0}` emits -- suppresses a name, so a tmux that
  // answers differently, or a format string that stops resolving, costs a
  // cosmetic column rather than every agent's name at once.
  expect(chosenWindowName("reviewer", "")).toBe("reviewer");
  expect(chosenWindowName("reviewer", "yes")).toBe("reviewer");
});

test("a capture asks tmux for escape sequences", () => {
  // `-e` is what makes the dash preview show a pane's colours at all. Without
  // it tmux hands back the text with every attribute discarded, and no amount
  // of work downstream can recover which line was the failing one.
  tmuxCalls.length = 0;
  tmuxReplies.length = 0;
  tmuxReplies.push("out");

  expect(tmux.capture(asPaneId("%7"), 40)).toBe("out");

  expect(tmuxCalls).toEqual([["capture-pane", "-p", "-e", "-t", "%7", "-S", "-40"]]);
});
