import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { DASH_PANE_OPTION } from "../src/goto.js";
import { asPaneId } from "../src/ids.js";
import { chosenWindowName } from "../src/local.js";
import {
  chainArg,
  chainedTmuxCalls,
  conventionalTmuxDirectory,
  deriveTmuxServer,
  pidAlive,
  procArgv,
  tmux,
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

test.each([
  [";", "\\;"],
  ["worker;", "worker\\;"],
  ["a ; b", "a ; b"],
])("a value %j cannot split the chain", (value, sent) => {
  tmuxCalls.length = 0;

  tmux.run(
    [
      ["set-option", "-gq", "@murmur_count_working", value],
      ["set-option", "-gqu", "@murmur_count_idle"],
    ],
    { kind: "label", value: "mule" },
  );

  const [call] = tmuxCalls;
  expect(call?.slice(0, 2)).toEqual(["-L", "mule"]);
  expect(call).toContain(sent);
  // Two commands and the repaint: two separators.
  expect(call?.filter((arg) => arg === ";")).toHaveLength(2);
  expect(call?.slice(-2)).toEqual(["refresh-client", "-S"]);
});

test("listPanes is ONE list-panes -a on the named server, one row per pane", () => {
  tmuxCalls.length = 0;
  tmuxReplies.length = 0;
  tmuxReplies.push("%1|working|a~1b\n%2||\n");
  expect(
    tmux.listPanes(["#{pane_id}", "#{pane_program_state}", "#{@mu_agent}"], {
      kind: "path",
      value: "/tmp/x.sock",
    }),
  ).toEqual([
    ["%1", "working", "a|b"],
    ["%2", "", ""],
  ]);
  expect(tmuxCalls).toEqual([
    [
      "-S",
      "/tmp/x.sock",
      "list-panes",
      "-a",
      "-F",
      "#{pane_id}|#{pane_program_state}|#{@mu_agent}",
    ],
  ]);
});

test("listPanes: no server running is no panes, any other failure is unknown", () => {
  // `[]` retires the panes a previous collect saw on that server; null keeps
  // them, because a timeout says nothing about whether they exist.
  tmuxReplies.length = 0;
  tmuxReplies.push("THROW:no server running on /tmp/tmux-1000/mule");
  expect(tmux.listPanes(["#{pane_id}"], { kind: "label", value: "mule" })).toEqual([]);
  tmuxReplies.push("THROW:error connecting to /tmp/tmux-1000/x (Permission denied)");
  expect(tmux.listPanes(["#{pane_id}"], { kind: "label", value: "x" })).toBeNull();
});

test("serverInfo reads vtmux's version and both OSC options, and only on vtmux", () => {
  tmuxCalls.length = 0;
  tmuxReplies.length = 0;
  tmuxReplies.push("3.8-rc3|3.8", "on", "off");
  expect(tmux.serverInfo({ kind: "default" })).toEqual({
    vtmux: "3.8-rc3",
    version: "3.8",
    programStatus: "on",
    programResume: "off",
  });
  expect(tmuxCalls).toEqual([
    ["-L", "default", "display-message", "-p", "#{vtmux_version}|#{version}"],
    ["-L", "default", "show-options", "-sqv", "vtmux-program-status"],
    ["-L", "default", "show-options", "-sqv", "vtmux-program-resume"],
  ]);

  // Stock tmux has neither option, and is not asked for them.
  tmuxCalls.length = 0;
  tmuxReplies.push("|3.8");
  expect(tmux.serverInfo({ kind: "default" })).toEqual({
    vtmux: null,
    version: "3.8",
    programStatus: null,
    programResume: null,
  });
  expect(tmuxCalls).toHaveLength(1);

  tmuxReplies.push("THROW:no server running");
  expect(tmux.serverInfo({ kind: "default" })).toBeNull();
});

test("chainArg escapes only a trailing semicolon", () => {
  expect(chainArg(";")).toBe("\\;");
  expect(chainArg("worker;")).toBe("worker\\;");
  expect(chainArg("a;b")).toBe("a;b");
  expect(chainArg("")).toBe("");
});

test("a chain too long for one tmux command splits, with the repaint last", () => {
  const commands = Array.from({ length: 400 }, (_, index) => [
    "set-option",
    "-pq",
    "-t",
    `%${index}`,
    "@murmur_pane_label",
    "x".repeat(40),
  ]);

  const calls = chainedTmuxCalls(commands);

  expect(calls.length).toBeGreaterThan(1);
  for (const call of calls) {
    expect(call.join(" ").length).toBeLessThan(16_000);
    expect(call.at(-1)).not.toBe(";");
  }
  expect(calls.flat().filter((arg) => arg === "@murmur_pane_label")).toHaveLength(400);
  expect(calls.at(-1)?.slice(-2)).toEqual(["refresh-client", "-S"]);
  expect(calls.flat().filter((arg) => arg === "refresh-client")).toHaveLength(1);
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

function fakeProc(entries: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "murmur-proc-"));
  for (const [pid, cmdline] of Object.entries(entries)) {
    mkdirSync(join(root, pid));
    writeFileSync(join(root, pid, "cmdline"), cmdline);
  }
  return root;
}

test("procArgv joins NUL-separated argv with single spaces", () => {
  const root = fakeProc({ "42": "ssh\0-t\0host\0mu attach\0", "43": "pi\0\0\0" });
  expect(procArgv("42", root)).toBe("ssh -t host mu attach");
  expect(procArgv("43", root)).toBe("pi");
});

test("procArgv skips a gone pid and an empty cmdline", () => {
  const root = fakeProc({ "7": "" });
  expect(procArgv("7", root)).toBeNull();
  expect(procArgv("999", root)).toBeNull();
});

// Uses the real /proc with this test's own pid, so it runs only where /proc exists.
test.skipIf(!existsSync(`/proc/${process.pid}/cmdline`))(
  "localPaneProcesses reads argv from /proc on Linux, without ps",
  () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux" });
    tmuxCalls.length = 0;
    tmuxReplies.length = 0;
    tmuxReplies.push(`%1|node|${process.pid}\n%2|zsh|999999999\n`);
    try {
      expect(tmux.localPaneProcesses()).toEqual([
        {
          pane: asPaneId("%1"),
          current_command: "node",
          arguments: procArgv(String(process.pid)),
        },
      ]);
      // The tmux read only: no `ps` call.
      expect(tmuxCalls).toHaveLength(1);
    } finally {
      if (platform) Object.defineProperty(process, "platform", platform);
    }
  },
);

function asDarwin<T>(body: () => T): T {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    return body();
  } finally {
    if (platform) Object.defineProperty(process, "platform", platform);
  }
}

test("localPaneProcesses runs no ps when no pane's command is a candidate", () => {
  tmuxCalls.length = 0;
  tmuxReplies.length = 0;
  tmuxReplies.push("%1|zsh|11\n%2|python|12\n");
  expect(asDarwin(() => tmux.localPaneProcesses(new Set(["ssh"])))).toEqual([]);
  expect(tmuxCalls).toHaveLength(1);
});

test("localPaneProcesses runs ps once per candidate pid, only for candidates", () => {
  tmuxCalls.length = 0;
  tmuxReplies.length = 0;
  tmuxReplies.push("%1|ssh|11\n%2|zsh|12\n%3|ssh|13\n", "11 ssh dev -t a\n", "13 ssh dev -t b\n");
  expect(asDarwin(() => tmux.localPaneProcesses(new Set(["ssh"])))).toEqual([
    { pane: asPaneId("%1"), current_command: "ssh", arguments: "ssh dev -t a" },
    { pane: asPaneId("%3"), current_command: "ssh", arguments: "ssh dev -t b" },
  ]);
  expect(tmuxCalls.slice(1)).toEqual([
    ["ww", "-o", "pid=,command=", "11"],
    ["ww", "-o", "pid=,command=", "13"],
  ]);
});

test("localPaneProcesses batches one ps for many candidates, and unfiltered keeps every pane", () => {
  tmuxCalls.length = 0;
  tmuxReplies.length = 0;
  const rows = [1, 2, 3, 4, 5].map((n) => `%${n}|ssh|${n}0`).join("\n");
  tmuxReplies.push(rows, "10 a\n20 b\n30 c\n40 d\n50 e\n");
  expect(asDarwin(() => tmux.localPaneProcesses())).toHaveLength(5);
  expect(tmuxCalls).toHaveLength(2);
  expect(tmuxCalls[1]).toEqual(["ww", "-o", "pid=,command=", "10", "20", "30", "40", "50"]);
});

test("servers lists every socket in tmux's directory, and the one $TMUX names", async () => {
  // A stale socket is listed too: asking it is how a dead server reads as an
  // empty one. A plain file is not a server.
  const { createServer } = await import("node:net");
  const root = mkdtempSync("/tmp/mmx-");
  vi.stubEnv("TMUX_TMPDIR", root);
  const directory = conventionalTmuxDirectory();
  mkdirSync(directory, { recursive: true });
  const listeners = ["default", "mule", join(root, "elsewhere.sock")].map((name) => {
    const server = createServer();
    const listening = new Promise<void>((resolve) => server.once("listening", resolve));
    server.listen(name.startsWith("/") ? name : join(directory, name));
    return { server, listening };
  });
  try {
    await Promise.all(listeners.map((listener) => listener.listening));
    writeFileSync(join(directory, "notes"), "");
    vi.stubEnv("TMUX", `${join(root, "elsewhere.sock")},123,0`);
    expect(tmux.servers()).toEqual([
      { kind: "default" },
      { kind: "label", value: "mule" },
      { kind: "path", value: join(root, "elsewhere.sock") },
    ]);
  } finally {
    for (const listener of listeners) listener.server.close();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
