import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { InputDelivery } from "../src/dash-input.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { readPaneCtlSocket } from "../src/pane-process.js";
import {
  type Capture,
  ctlRequest,
  paneCtlSocket,
  parseStateLine,
  type StopBounds,
  stopPane,
} from "../src/stop.js";
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
    workstream: "crew",
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
  vi.useRealTimers();
  for (const server of servers.splice(0)) server.close();
});

/** A fake mu pi extension for `agent` in `workstream`: answers protocol v1, recording requests. */
async function ctlServer(
  agent = "worker-1",
  workstream = "crew",
): Promise<{ sock: string; requests: unknown[] }> {
  const sock = join(mkdtempSync(join(tmpdir(), "murmur-ctl-")), "ctl.sock");
  const requests: unknown[] = [];
  const server = createServer((conn) => {
    conn.setEncoding("utf8");
    conn.on("data", (line: string) => {
      const request = JSON.parse(line) as { op: string };
      requests.push(request);
      const reply =
        request.op === "hello"
          ? { v: 1, ok: true, agent, workstream, incarnation: "i1", ops: ["hello", "abort"] }
          : { v: 1, ok: true, wasBusy: true };
      conn.end(`${JSON.stringify(reply)}\n`);
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
  expect(outcome).toMatchObject({
    delivered: true,
    via: "ctl",
    ctl_fallback: null,
    stopped: true,
    state: "idle",
  });
  expect(requests).toEqual([{ op: "hello" }, { op: "abort" }]);
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
  expect(outcome).toMatchObject({
    via: "escape",
    ctl_fallback: "no_answer",
    stopped: true,
    state: "idle",
  });
  expect(sent).toHaveLength(1);
});

test("an inherited socket of another agent is never aborted: Escape, identity_mismatch", async () => {
  for (const [agent, workstream] of [
    ["boss", "crew"],
    ["worker-1", "other"],
  ] as const) {
    const { sock, requests } = await ctlServer(agent, workstream);
    const { run, sent } = escapes();
    const { capture } = recorder(() => "0||idle|\n");
    const outcome = await stopPane(store(), pane(true), {
      run,
      capture,
      ctlSocket: async () => sock,
      bounds,
    });
    expect(outcome).toMatchObject({ via: "escape", ctl_fallback: "identity_mismatch" });
    expect(requests).toEqual([{ op: "hello" }]);
    expect(sent).toHaveLength(1);
  }
});

test("only a pi pane with a mu identity is offered ctl; the socket is not even asked otherwise", async () => {
  const cases: [Partial<PaneView>, string][] = [
    [{ harness: "claude" }, "not_pi"],
    [{ harness: null }, "not_pi"],
    [{ agent_name: null }, "no_identity"],
    [{ workstream: null }, "no_identity"],
  ];
  for (const [over, why] of cases) {
    const { sock, requests } = await ctlServer();
    const { run, sent } = escapes();
    const { capture } = recorder(() => "0||idle|\n");
    const outcome = await stopPane(store(), pane(true, over), {
      run,
      capture,
      ctlSocket: async () => sock,
      bounds,
    });
    expect(outcome).toMatchObject({ via: "escape", ctl_fallback: why });
    expect(requests).toEqual([]);
    expect(sent).toHaveLength(1);
  }
});

test("an unreadable state reply is unconfirmed, never idle", async () => {
  for (const reply of ["", "\n", "Welcome to dev\n0||idle|\n", "0||idl", "0|", "x||idle|\n"]) {
    const { run } = escapes();
    const { capture } = recorder(() => reply);
    const outcome = await stopPane(store(), pane(true), {
      run,
      capture,
      ctlSocket: async () => null,
      bounds,
    });
    expect(outcome).toMatchObject({ delivered: true, stopped: null, state: null });
  }
});

test("a Rex error that reads like tmux's is not taken for a gone pane", async () => {
  const { run } = escapes();
  const { capture } = recorder(() => new Error("can't find pane: block:b1"));
  const outcome = await stopPane(store(), rexBlock(true), { run, capture, bounds });
  expect(outcome).toMatchObject({ stopped: null, state: null });
});

test("a remote Rex read with both legs hanging stays within probeMs per probe and totalMs overall", async () => {
  const { run } = escapes();
  const timeouts: number[] = [];
  // rex -S gives up at 120ms of its 200; ssh hangs for as long as it is let.
  const calls: string[] = [];
  const hang: Capture = (command, _args, ms) => {
    calls.push(command);
    timeouts.push(ms);
    const after = command === "rex" ? Math.min(ms, 120) : ms;
    return new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), after));
  };
  const slow: StopBounds = { totalMs: 300, intervalMs: 20, probeMs: 200, ctlMs: 100 };
  // A fake clock: Date.now and setTimeout advance together, so no real-time
  // jitter or event-loop pause can change what each leg is given.
  vi.useFakeTimers();
  const started = Date.now();
  const pending = stopPane(store("me@dev"), rexBlock(false), {
    run,
    capture: hang,
    bounds: slow,
  });
  await vi.advanceTimersByTimeAsync(slow.totalMs + 100);
  const outcome = await pending;
  const elapsed = Date.now() - started;
  vi.useRealTimers();
  expect(elapsed).toBeLessThanOrEqual(slow.totalMs + 100);
  expect(outcome).toMatchObject({ stopped: null, state: null });
  // The first probe's two legs share its 200ms: the ssh leg gets only the rest.
  expect(calls.slice(0, 2)).toEqual(["rex", "ssh"]);
  expect(timeouts[0]).toBe(200);
  expect(timeouts[1]).toBeGreaterThan(0);
  expect(timeouts[1]).toBeLessThanOrEqual(slow.probeMs - 120);
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
  expect(parseStateLine("0||working|a|b\n")).toBe("running");
  for (const bad of ["", "0||idle", "2||idle|", "0|x|idle|", "banner\n0||idle|\n"])
    expect(parseStateLine(bad)).toBeNull();
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

/** A unix socket answering every connection with `write(conn)`. */
async function replyServer(write: (conn: Socket) => void): Promise<string> {
  const sock = join(mkdtempSync(join(tmpdir(), "murmur-ctl-")), "ctl.sock");
  const server = createServer((conn) => {
    conn.on("error", () => {});
    conn.once("data", () => write(conn));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(sock, resolve));
  return sock;
}

test("ctlRequest answers only a v1 ok reply, whole or in chunks", async () => {
  const reply = JSON.stringify({ v: 1, ok: true, agent: "a" });
  const whole = await replyServer((conn) => conn.end(`${reply}\n`));
  expect(await ctlRequest(whole, { op: "hello" }, 1_000)).toMatchObject({ agent: "a" });
  const chunked = await replyServer((conn) => {
    conn.write(reply.slice(0, 5));
    setTimeout(() => conn.end(`${reply.slice(5)}\n`), 10);
  });
  expect(await ctlRequest(chunked, { op: "hello" }, 1_000)).toMatchObject({ agent: "a" });
});

test.each([
  ["ok:false", `${JSON.stringify({ v: 1, ok: false })}\n`],
  ["a wrong protocol version", `${JSON.stringify({ v: 2, ok: true })}\n`],
  ["malformed JSON", "{nope\n"],
  ["a reply that is not an object", "null\n"],
  ["a reply closed without a newline", JSON.stringify({ v: 1, ok: true })],
  ["an oversized line", "x".repeat(70 * 1024)],
])("ctlRequest: %s is no answer", async (_name, body) => {
  const sock = await replyServer((conn) => conn.end(body));
  expect(await ctlRequest(sock, { op: "abort" }, 1_000)).toBeNull();
});

test("ctlRequest: a socket that never answers times out, and a missing one is no answer", async () => {
  const hung = await replyServer(() => {});
  expect(await ctlRequest(hung, { op: "hello" }, 50)).toBeNull();
  expect(await ctlRequest(join(tmpdir(), "murmur-no-such.sock"), { op: "hello" }, 50)).toBeNull();
});

test("paneCtlSocket asks only a local tmux pane, and a failed read is no socket", async () => {
  const { calls, capture } = recorder(() => "not-a-pid\n");
  expect(await paneCtlSocket(pane(false), capture, 100)).toBeNull();
  expect(await paneCtlSocket(rexBlock(true), capture, 100)).toBeNull();
  expect(calls).toEqual([]);
  expect(await paneCtlSocket(pane(true), capture, 100)).toBeNull();
  expect(calls).toHaveLength(1);
  expect(calls[0]?.args).toContain("#{pane_pid}");
  const failing = recorder(() => new Error("no server"));
  expect(await paneCtlSocket(pane(true), failing.capture, 100)).toBeNull();
});
