import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { InputDelivery } from "../src/dash-input.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { readPaneCtlSocket } from "../src/pane-process.js";
import { type Capture, parseStateLine, type StopBounds, stopPane } from "../src/stop.js";
import type { Store } from "../src/store.js";
import type { PaneView } from "../src/view.js";
import { rexWalk } from "./helpers/rex.js";

/** Small bounds so a pane that stays working ends the test quickly. */
const bounds: StopBounds = { totalMs: 400, intervalMs: 20, probeMs: 200, ctlMs: 500 };

function pane(local: boolean, over: Partial<PaneView> = {}): PaneView {
  return {
    host_id: local ? "LOCAL" : "remote-host",
    host: local ? "here" : "dev",
    local,
    server: { kind: "default" },
    pane: asPaneId("%9"),
    session: asSessionId("$1"),
    window: asWindowId("@1"),
    session_name: "work",
    window_name: "agent",
    activity: "running",
    attention: [],
    freshness: "fresh",
    agent_name: "worker-1",
    workstream: null,
    role: null,
    cli: "pi",
    harness: "pi",
    driver: "orchestrated",
    pending: null,
    updated_at: 1,
    snapshot_at: null,
    fetched_at: null,
    attached_pane: null,
    pane_title: null,
    title: null,
    message: null,
    progress: null,
    blocked_kind: null,
    resume_command: null,
    resume_cwd: null,
    cwd: null,
    focused: false,
    runs_on: null,
    ...over,
  };
}

const rexBlock = (local: boolean) =>
  pane(local, {
    server: { kind: "rex" },
    pane: asPaneId("block:b1"),
    session: asSessionId("session:s1"),
    window: asWindowId("window:w1"),
  });

function store(rexHost: string | null = null): Store {
  return {
    peers: () => [
      { name: "dev", target: "dev.example", host_id: "remote-host", rex_host: rexHost },
    ],
  } as unknown as Store;
}

type Call = { command: string; args: string[] };

/** A capture answering each read from `answer`, recording every call. */
function recorder(answer: (call: Call, n: number) => string | Error) {
  const calls: Call[] = [];
  const capture: Capture = async (command, args) => {
    const call = { command, args };
    calls.push(call);
    const reply = answer(call, calls.length);
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { calls, capture };
}

function escapes() {
  const sent: InputDelivery[] = [];
  return {
    sent,
    run: async (delivery: InputDelivery) => {
      sent.push(delivery);
    },
  };
}

/** A Rex walk reply holding block:b1 in `state`, as `rex do --json` prints it. */
async function walkReply(state: string): Promise<string> {
  const { call } = rexWalk([
    {
      session_id: "session:s1",
      label: "work",
      blocks: { "block:b1": { status: { records: [{ state, app: "pi" }] }, process: {} } },
    },
  ]);
  return JSON.stringify(await call(""));
}

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** A fake mu pi extension: answers `abort` the way protocol v1 does, recording requests. */
async function ctlServer(): Promise<{ sock: string; requests: unknown[] }> {
  const sock = join(mkdtempSync(join(tmpdir(), "murmur-ctl-")), "ctl.sock");
  const requests: unknown[] = [];
  const server = createServer((conn) => {
    conn.setEncoding("utf8");
    conn.on("data", (line: string) => {
      requests.push(JSON.parse(line));
      conn.end(`${JSON.stringify({ v: 1, ok: true, wasBusy: true })}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(sock, resolve));
  return { sock, requests };
}

test("a pi pane with a ctl socket is aborted over ctl, and confirmed once it leaves working", async () => {
  const { sock, requests } = await ctlServer();
  const { run, sent } = escapes();
  // Still working on the first read, idle on the next.
  const { calls, capture } = recorder((_, n) => (n === 1 ? "0||working|\n" : "0||idle|\n"));
  const outcome = await stopPane(store(), pane(true), {
    run,
    capture,
    ctlSocket: async () => sock,
    bounds,
  });
  expect(outcome).toMatchObject({ delivered: true, via: "ctl", stopped: true, state: "idle" });
  expect(requests).toEqual([{ op: "abort" }]);
  expect(sent).toEqual([]);
  expect(calls[0]?.command).toBe("tmux");
  expect(calls[0]?.args).toEqual(expect.arrayContaining(["display-message", "-t", "%9"]));
  expect(calls[0]?.args).toContain("-L");
});

test("an Escape-only pane that stays working is stopped:false with its state, within the bound", async () => {
  const { run, sent } = escapes();
  const { capture } = recorder(() => "0||working|\n");
  const started = Date.now();
  const outcome = await stopPane(store(), pane(true), {
    run,
    capture,
    ctlSocket: async () => null,
    bounds,
  });
  expect(Date.now() - started).toBeLessThan(bounds.totalMs + 300);
  expect(outcome).toMatchObject({
    delivered: true,
    via: "escape",
    stopped: false,
    state: "running",
  });
  expect(sent[0]?.args.slice(-4)).toEqual(["send-keys", "-t", "%9", "Escape"]);
});

test("a ctl socket nothing answers on falls back to Escape", async () => {
  const { run, sent } = escapes();
  const { capture } = recorder(() => "0||idle|\n");
  const dead = join(mkdtempSync(join(tmpdir(), "murmur-ctl-")), "none.sock");
  const outcome = await stopPane(store(), pane(true), {
    run,
    capture,
    ctlSocket: async () => dead,
    bounds,
  });
  expect(outcome).toMatchObject({ via: "escape", stopped: true, state: "idle" });
  expect(sent).toHaveLength(1);
});

test("a pane that vanished after the interrupt is stopped, state gone", async () => {
  const { run } = escapes();
  const { capture } = recorder(() => new Error("can't find pane: %9"));
  const outcome = await stopPane(store(), pane(true), {
    run,
    capture,
    ctlSocket: async () => null,
    bounds,
  });
  expect(outcome).toMatchObject({ stopped: true, state: "gone" });
});

test("a local Rex block is read back by the collector's one rex walk", async () => {
  const { run, sent } = escapes();
  const [working, idle] = [await walkReply("working"), await walkReply("idle")];
  const { calls, capture } = recorder((_, n) => (n === 1 ? working : idle));
  const outcome = await stopPane(store(), rexBlock(true), { run, capture, bounds });
  expect(outcome).toMatchObject({ via: "escape", stopped: true, state: "idle" });
  expect(sent[0]?.command).toBe("sh");
  expect(calls[0]?.command).toBe("rex");
  expect(calls[0]?.args.slice(0, 2)).toEqual(["--autostart=false", "--timeout"]);
  expect(calls[0]?.args).toContain("do");
  expect(calls).toHaveLength(2);
});

test("a remote Rex block is read through rex -S, then the peer's ssh when that fails", async () => {
  const { run } = escapes();
  const working = await walkReply("working");
  const { calls, capture } = recorder((call) =>
    call.command === "rex" ? new Error("connecting to Rex server timed out") : working,
  );
  const outcome = await stopPane(store("me@dev"), rexBlock(false), { run, capture, bounds });
  expect(outcome).toMatchObject({ stopped: false, state: "running" });
  expect(calls[0]?.args.slice(0, 2)).toEqual(["-S", "me@dev"]);
  expect(calls[1]?.command).toBe("ssh");
  expect(calls[1]?.args).toContain("dev.example");
  expect(calls[1]?.args.at(-1)).toMatch(/^'rex' '--autostart=false' '--timeout' '2s' 'do' '-e' /);
});

test("a remote tmux pane is read over the peer's ssh on its own server", async () => {
  const { run } = escapes();
  const { calls, capture } = recorder(() => "0||done|\n");
  const outcome = await stopPane(
    store(),
    pane(false, { server: { kind: "label", value: "work" } }),
    { run, capture, bounds },
  );
  expect(outcome).toMatchObject({ stopped: true, state: "done" });
  expect(calls[0]?.command).toBe("ssh");
  const args = calls[0]?.args ?? [];
  expect(args.slice(args.indexOf("dev.example"))).toEqual([
    "dev.example",
    "tmux",
    "-L",
    "'work'",
    "'display-message'",
    "'-p'",
    "'-t'",
    "'%9'",
    "'#{pane_dead}|#{pane_dead_status}|#{pane_program_state}|#{pane_program_id}'",
  ]);
});

test("a remote pane whose state cannot be read is stopped:null with the reason", async () => {
  const { run } = escapes();
  const { capture } = recorder(() => new Error("ssh: connect to host dev.example: refused"));
  const outcome = await stopPane(store(), pane(false), { run, capture, bounds });
  expect(outcome).toMatchObject({ delivered: true, via: "escape", stopped: null, state: null });
  expect(outcome.message).toContain("could not read its state: ssh: connect");
});

test("a failed Escape is no delivery and reads nothing back", async () => {
  const { calls, capture } = recorder(() => "0||idle|\n");
  const outcome = await stopPane(store(), pane(true), {
    run: async () => {
      throw new Error("no server running");
    },
    capture,
    ctlSocket: async () => null,
    bounds,
  });
  expect(outcome).toEqual({ delivered: false, message: "no server running" });
  expect(calls).toEqual([]);
});

test("the state line reads as the collector reads list-panes", () => {
  expect(parseStateLine("0||working|\n")).toBe("running");
  expect(parseStateLine("0||working|mu/delegates\n")).toBe("waiting");
  expect(parseStateLine("1|1|working|\n")).toBe("crashed");
  expect(parseStateLine("0|||\n")).toBe("idle");
});

test("MU_CTL_SOCK is read from the pane process's environment", () => {
  const proc = mkdtempSync(join(tmpdir(), "murmur-proc-"));
  mkdirSync(join(proc, "42"));
  writeFileSync(join(proc, "42", "cmdline"), "pi\0");
  writeFileSync(join(proc, "42", "environ"), "SECRET=x\0MU_CTL_SOCK=/tmp/mu/w.sock\0");
  expect(readPaneCtlSocket("42", "linux", proc)).toBe("/tmp/mu/w.sock");
  writeFileSync(join(proc, "42", "environ"), "SECRET=x\0");
  expect(readPaneCtlSocket("42", "linux", proc)).toBeNull();
  expect(readPaneCtlSocket("4; rm", "linux", proc)).toBeNull();
});
