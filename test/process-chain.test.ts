import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { anchorLookup } from "../src/anchors.js";
import { harnessFromArgv } from "../src/harnesses.js";
import {
  ancestry,
  outerHarness,
  type ProcessRow,
  parseProcessTable,
  placeEvent,
  readProcessTable,
  treeRuns,
} from "../src/process-chain.js";

/**
 * Placing a hook event by its process chain, over the chain shapes recorded
 * from real harnesses in real tmux panes. The table is synthetic so each rule
 * is pinned on its own; argv strings follow the recorded shapes with paths
 * shortened.
 *
 * Read child first: `chain(hook, ..., server)` builds a table where each entry
 * is the parent of the one before it.
 */

const SERVER_ARGS = "tmux new-session -d -s work -c /home/u/work";

function chain(...argvs: string[]): { table: Map<number, ProcessRow>; pids: number[] } {
  const table = new Map<number, ProcessRow>();
  const pids = argvs.map((_, index) => 1000 + index);
  argvs.forEach((args, index) => {
    const pid = pids[index] as number;
    const ppid = pids[index + 1] ?? 1;
    table.set(pid, { pid, ppid, started: 1_700_000_000 + index, args });
  });
  table.set(1, { pid: 1, ppid: 0, started: 1, args: "/sbin/launchd" });
  return { table, pids };
}

const HOOK = "node /usr/local/lib/node_modules/@mu-crew/murmur/dist/cli.js hook claude";

test("a launcher and the binary it starts count as one harness", () => {
  // claude < claude, as recorded: the launcher, then its native binary.
  const claude = chain(
    HOOK,
    "/opt/claude/native/claude --settings {}",
    "/opt/claude/bin/claude",
    "-zsh",
    SERVER_ARGS,
  );
  expect(placeEvent(claude.table, claude.pids[0] as number)).toEqual({
    kind: "local",
    server_pid: claude.pids[4],
    root_pid: claude.pids[3],
    // The run's member nearest the hook: the binary, which is what CLAUDE_PID names.
    owner_pid: claude.pids[1],
    harness: "claude",
    anchor: null,
  });

  // codex.real < codex (a wrapper with its own argv) < codex: three, still one.
  const codex = chain(
    "python3 hook.py",
    "/opt/codex/libexec/codex.real -c x=1",
    "/opt/codex/bin/codex --foreground /opt/codex/libexec/codex.real",
    "codex",
    "-zsh",
    SERVER_ARGS,
  );
  const placed = placeEvent(codex.table, codex.pids[0] as number);
  expect(placed).toMatchObject({ kind: "local", harness: "codex", owner_pid: codex.pids[1] });

  // muse.real < muse, behind the shell the harness runs hooks through.
  const muse = chain(
    "python3 hook.py",
    "/bin/zsh -c murmur hook muse",
    "/opt/muse/bin/muse.real",
    "muse",
    "-zsh",
    SERVER_ARGS,
  );
  expect(placeEvent(muse.table, muse.pids[0] as number)).toMatchObject({
    kind: "local",
    harness: "muse",
    root_pid: muse.pids[4],
  });
});

test("an event from a harness nested under pi is dropped", () => {
  // pi's bash tool runs `claude -p`: the walk meets claude, a shell, then pi.
  const nested = chain(
    HOOK,
    "/opt/claude/native/claude -p reply",
    "/opt/claude/bin/claude -p reply",
    "/bin/bash -c claude -p reply",
    "node /usr/local/bin/pi",
    "-zsh",
    SERVER_ARGS,
  );
  expect(placeEvent(nested.table, nested.pids[0] as number)).toEqual({
    kind: "drop",
    reason: "nested",
  });
});

test("a nested run of the same harness behind a shell is a second harness", () => {
  // `claude -p` from inside claude: two claude runs, separated by a shell.
  const nested = chain(
    HOOK,
    "/opt/claude/native/claude --settings {}",
    "/opt/claude/bin/claude -p NESTED",
    "/bin/zsh -c source snapshot.sh && claude -p NESTED",
    "/opt/claude/native/claude --settings {}",
    "/opt/claude/bin/claude",
    "-zsh",
    SERVER_ARGS,
  );
  expect(placeEvent(nested.table, nested.pids[0] as number)).toEqual({
    kind: "drop",
    reason: "nested",
  });
});

test("a chain that never reaches a tmux server is dropped, even with $TMUX set", () => {
  // claude's detached `plugin update`, reparented to launchd, fires SessionEnd
  // with the pane's $TMUX still in its environment.
  const detached = chain(
    HOOK,
    "/opt/claude/native/claude --settings {}",
    "/opt/claude/bin/claude plugin update",
    "/bin/sh -c ( claude plugin update ) &",
  );
  expect(
    placeEvent(detached.table, detached.pids[0] as number, {
      tmuxEnv: "/tmp/tmux-501/default,999,22",
    }),
  ).toEqual({ kind: "drop", reason: "no-server" });
});

test("$TMUX names the server when the hook has it, and argv finds it when not", () => {
  // A hook with a cleared environment has no $TMUX, so the tmux argv is the signal.
  const plain = chain(HOOK, "/opt/claude/bin/claude", "-zsh", SERVER_ARGS);
  expect(placeEvent(plain.table, plain.pids[0] as number)).toMatchObject({
    kind: "local",
    server_pid: plain.pids[3],
  });
  // With $TMUX, its pid field decides, so a server spelled oddly in ps still counts.
  const odd = chain(HOOK, "/opt/claude/bin/claude", "-zsh", "/opt/odd/multiplexer");
  expect(
    placeEvent(odd.table, odd.pids[0] as number, {
      tmuxEnv: `/tmp/tmux-501/default,${odd.pids[3]},3`,
    }),
  ).toMatchObject({ kind: "local", server_pid: odd.pids[3], root_pid: odd.pids[2] });
});

test("a chain with no harness in it is dropped", () => {
  const none = chain(HOOK, "/bin/zsh", "-zsh", SERVER_ARGS);
  expect(placeEvent(none.table, none.pids[0] as number)).toEqual({
    kind: "drop",
    reason: "no-harness",
  });
});

test("the anchor names the agent, only when its start time matches", () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-anchors-"));
  const claude = chain(HOOK, "/opt/claude/bin/claude", "-zsh", SERVER_ARGS);
  const harness = claude.table.get(claude.pids[1] as number) as ProcessRow;
  writeFileSync(
    join(dir, `${harness.pid}.json`),
    JSON.stringify({
      start_time: harness.started,
      agent_name: "worker-1",
      workstream: "ws",
      cli: "claude",
      orchestrator: false,
    }),
  );
  expect(
    placeEvent(claude.table, claude.pids[0] as number, { anchor: anchorLookup(dir) }),
  ).toMatchObject({
    kind: "local",
    anchor: { agent_name: "worker-1", workstream: "ws", cli: "claude", remote_key: null },
  });

  // A reused pid: the file outlived the agent that wrote it.
  writeFileSync(
    join(dir, `${harness.pid}.json`),
    JSON.stringify({ start_time: (harness.started ?? 0) - 3600, agent_name: "stranger" }),
  );
  expect(
    placeEvent(claude.table, claude.pids[0] as number, { anchor: anchorLookup(dir) }),
  ).toMatchObject({ kind: "local", anchor: null });
});

test("an anchor's remote key routes the event away from the inbox", () => {
  // A remote worker under plain ssh: the chain ends at sshd, not tmux.
  const dir = mkdtempSync(join(tmpdir(), "murmur-anchors-"));
  const remote = chain(HOOK, "/opt/claude/bin/claude", "sshd: u@notty");
  const harness = remote.table.get(remote.pids[1] as number) as ProcessRow;
  writeFileSync(
    join(dir, `${harness.pid}.json`),
    JSON.stringify({ start_time: harness.started, remote_key: "origin/abc" }),
  );
  expect(
    placeEvent(remote.table, remote.pids[0] as number, { anchor: anchorLookup(dir) }),
  ).toMatchObject({ kind: "remote", remote_key: "origin/abc", owner_pid: harness.pid });
});

test("harnesses are matched by argv, never by process name", () => {
  expect(harnessFromArgv("node /usr/local/bin/pi")).toBe("pi");
  expect(harnessFromArgv("bun /opt/pi/bin/pi --model x")).toBe("pi");
  expect(harnessFromArgv("node /usr/lib/node_modules/pi-coding-agent/dist/cli.js")).toBe("pi");
  expect(harnessFromArgv("/home/u/.local/share/cursor-agent/versions/1/node index.js")).toBe(
    "cursor-agent",
  );
  expect(harnessFromArgv("/opt/cursor/bin/cursor-agent --use-system-ca")).toBe("cursor-agent");
  expect(harnessFromArgv("/opt/codex/libexec/codex.real -c x")).toBe("codex");
  // A shell whose command string runs a harness is a shell.
  expect(harnessFromArgv("/bin/zsh -c claude -p hi")).toBeNull();
  // murmur's own hook process is not a harness, whatever it was asked about.
  expect(harnessFromArgv("node /usr/local/bin/murmur hook claude")).toBeNull();
  expect(harnessFromArgv("node")).toBeNull();
});

test("the process table parses ps output and walks the real chain", () => {
  const parsed = parseProcessTable(
    "  501   1 Wed Nov  5 10:00:00 2026 tmux new-session -d\n" +
      "  502 501 Wed Nov  5 10:00:01 2026 -zsh\n" +
      "garbage line\n",
  );
  expect([...parsed.keys()]).toEqual([501, 502]);
  expect(parsed.get(502)).toMatchObject({ ppid: 501, args: "-zsh" });
  expect((parsed.get(502)?.started ?? 0) - (parsed.get(501)?.started ?? 0)).toBe(1);

  // The real table: this process's ancestry includes its parent.
  const real = readProcessTable();
  expect(real).not.toBeNull();
  const mine = ancestry(real as Map<number, ProcessRow>, process.pid);
  expect(mine.has(process.pid)).toBe(true);
  expect(mine.has(process.ppid)).toBe(true);
});

test("treeRuns finds a harness anywhere under a pane root", () => {
  const { table, pids } = chain("node /usr/local/bin/pi", "/bin/zsh", "-zsh", SERVER_ARGS);
  // pids[2] is the pane root; pi runs two levels below it.
  expect(treeRuns(table, pids[2] as number, "pi")).toBe(true);
  expect(treeRuns(table, pids[2] as number, "claude")).toBe(false);
});

test("treeRuns skips the subtree it is told to", () => {
  // claude runs a pi of its own: that pi is claude's nested agent.
  const { table, pids } = chain(
    "node /usr/local/bin/pi",
    "/bin/zsh -c pi",
    "claude",
    "-zsh",
    SERVER_ARGS,
  );
  expect(treeRuns(table, pids[3] as number, "pi", pids[2])).toBe(false);
  // A pi beside claude, not under it, still counts.
  table.set(2000, { pid: 2000, ppid: pids[3] as number, started: 1, args: "pi" });
  expect(treeRuns(table, pids[3] as number, "pi", pids[2])).toBe(true);
});

test("outerHarness finds the live hook harness a pi runs inside, below the server", () => {
  const nested = chain(
    "node /usr/local/lib/node_modules/pi-coding-agent/dist/cli.js",
    "pi",
    "/bin/zsh -c pi",
    "/opt/codex/libexec/codex.real",
    "codex",
    "-zsh",
    SERVER_ARGS,
  );
  const server = nested.pids[6] as number;
  // pi's own launcher run is skipped; the nearest other harness is codex.real.
  expect(outerHarness(nested.table, nested.pids[0] as number, server)).toBe(nested.pids[3]);

  // A pi straight in its pane, or inside another pi, is not nested here.
  const plain = chain("pi", "-zsh", SERVER_ARGS);
  expect(outerHarness(plain.table, plain.pids[0] as number, plain.pids[2] as number)).toBeNull();
  const inPi = chain("pi", "/bin/zsh -c pi", "pi", "-zsh", SERVER_ARGS);
  expect(outerHarness(inPi.table, inPi.pids[0] as number, inPi.pids[4] as number)).toBeNull();

  // A walk that never meets the named server cannot tell, and reads as not nested.
  expect(outerHarness(nested.table, nested.pids[0] as number, 99_999)).toBeNull();
});
