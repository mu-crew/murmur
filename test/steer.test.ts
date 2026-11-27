import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { jumpToAgent } from "../src/agents.js";
import type { InputDelivery } from "../src/dash-input.js";
import { createIdentity, loadIdentity, type NodeIdentity } from "../src/identity.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { runJump } from "../src/jump-select.js";
import { jumpTarget } from "../src/jump-target.js";
import type { Mux } from "../src/mux.js";
import { promptAgent, stopAgent } from "../src/steer.js";
import { openStore, type Store } from "../src/store.js";
import type { PaneView } from "../src/view.js";
import { localPane, vtmuxMux, vtmuxRow } from "./helpers/panes.js";

let store: Store;

beforeEach(() => {
  vi.stubEnv("MURMUR_STATE_DIR", mkdtempSync(join(tmpdir(), "murmur-steer-")));
  createIdentity("here");
  store = openStore();
});

/** pane %1 working, as vtmux lists it: the one local pane every test resolves. */
function live(over: Partial<Mux> = {}): Mux {
  return vtmuxMux(
    [
      vtmuxRow({
        pane: "%1",
        session: "$0",
        window: "@1",
        session_name: "dev",
        window_name: "w",
        state: "working",
        app: "pi",
        pane_title: "a",
      }),
    ],
    over,
  );
}

afterEach(() => {
  store.close();
  vi.unstubAllEnvs();
  process.exitCode = 0;
  vi.restoreAllMocks();
});

function identity(): NodeIdentity {
  const loaded = loadIdentity();
  if (!loaded) throw new Error("no identity");
  return loaded;
}

function target(pane = "%1"): string {
  return jumpTarget({
    host_id: identity().host_id,
    server: { kind: "default" },
    pane: asPaneId(pane),
  });
}

const deps = (log: InputDelivery[]) => ({
  mux: live(),
  warm: () => true,
  rex: false as const,
  run: async (delivery: InputDelivery) => {
    log.push(delivery);
  },
});

test("promptAgent pastes the text into the resolved pane and presses Enter", async () => {
  const log: InputDelivery[] = [];
  const result = await promptAgent(store, identity(), target(), "-fix it", deps(log));
  expect(result).toEqual({ ok: true, action: "prompt", jump_target: target() });
  expect(log).toHaveLength(1);
  expect(log[0]?.command).toBe("tmux");
  expect(log[0]?.input).toBe("-fix it");
  expect(log[0]?.args).toContain("paste-buffer");
  expect(log[0]?.args).toContain("%1");
  expect(log[0]?.args.at(-1)).toBe("Enter");
});

test("stopAgent sends Escape to the resolved pane", async () => {
  const log: InputDelivery[] = [];
  const result = await stopAgent(store, identity(), target(), deps(log));
  expect(result).toEqual({ ok: true, action: "stop", jump_target: target() });
  expect(log[0]?.args.slice(-4)).toEqual(["send-keys", "-t", "%1", "Escape"]);
});

test("steering reports an invalid, vanished or empty target without delivering", async () => {
  const log: InputDelivery[] = [];
  expect(await stopAgent(store, identity(), "nope", deps(log))).toMatchObject({
    ok: false,
    reason: "invalid_target",
  });
  expect(await stopAgent(store, identity(), target("%99"), deps(log))).toMatchObject({
    ok: false,
    reason: "not_found",
  });
  expect(await promptAgent(store, identity(), target(), "  \n", deps(log))).toMatchObject({
    ok: false,
    reason: "empty_prompt",
  });
  expect(log).toEqual([]);
});

test("a failed delivery is reported, not thrown", async () => {
  const result = await stopAgent(store, identity(), target(), {
    ...deps([]),
    run: async () => {
      throw new Error("no server running");
    },
  });
  expect(result).toEqual({ ok: false, reason: "delivery_failed", message: "no server running" });
});

test("jump --client forwards the client to tmux attach, even outside tmux", async () => {
  const attach = vi.fn(() => true);
  const mux = live({ attach, livePanes: () => new Set([asPaneId("%1")]) });
  let view: PaneView | undefined;
  await runJump(
    store,
    identity(),
    target(),
    {
      fzf: () => "",
      mux,
      rex: false,
      jump: (s, agent, client) => {
        view = agent;
        return jumpToAgent(s, agent, mux, undefined, {}, client);
      },
    },
    { client: "/dev/ttys004" },
  );
  expect(view?.pane).toBe("%1");
  expect(attach).toHaveBeenCalledWith("%1", { kind: "default" }, "/dev/ttys004");
  expect(process.exitCode ?? 0).toBe(0);
});

test("jump --json prints a success object", async () => {
  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  await runJump(
    store,
    identity(),
    target(),
    { fzf: () => "", mux: live(), rex: false, jump: () => ({ ok: true }) },
    { json: true, client: "c" },
  );
  expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toEqual({
    ok: true,
    jump_target: target(),
  });
});

test("jump --json reports failures as JSON on stdout with exit 1", async () => {
  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  await runJump(
    store,
    identity(),
    "bad",
    { fzf: () => "", mux: live(), rex: false },
    { json: true },
  );
  expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({
    ok: false,
    reason: "invalid_target",
  });
  expect(process.exitCode).toBe(1);
  expect(err).not.toHaveBeenCalled();
});

test("jump --json outside tmux and Rex without a terminal is a clear no_tty error", async () => {
  vi.stubEnv("TMUX", "");
  vi.stubEnv("TERM_PROGRAM", "");
  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const jump = vi.fn(() => ({ ok: true as const }));
  await runJump(
    store,
    identity(),
    target(),
    { fzf: () => "", mux: live(), rex: false, jump, interactive: () => false },
    { json: true },
  );
  expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({
    ok: false,
    reason: "no_tty",
  });
  expect(jump).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});

test("a rex j1 token is a valid target: absent is not_found, not invalid_target", async () => {
  const log: InputDelivery[] = [];
  const rexToken = jumpTarget({
    host_id: identity().host_id,
    server: { kind: "rex" },
    pane: asPaneId("%99"),
  });
  expect(await stopAgent(store, identity(), rexToken, deps(log))).toMatchObject({
    ok: false,
    reason: "not_found",
  });
  expect(await promptAgent(store, identity(), rexToken, "hi", deps(log))).toMatchObject({
    ok: false,
    reason: "not_found",
  });
  expect(log).toEqual([]);
});

/** A Rex block as a peer's snapshot carries it: the local-only keys dropped. */
const {
  focused: _focused,
  runs_on: _runsOn,
  ...wirePane
} = localPane({
  server: { kind: "rex" },
  pane: asPaneId("block:b1"),
  session: asSessionId("session:s1"),
  window: asWindowId("window:w1"),
});

/** A peer `far` whose cached snapshot holds one Rex block, `{ kind: "rex" }` on the wire. */
function remoteRexToken(rexHost: string | null): string {
  store.addPeer("far", "far.example");
  if (rexHost !== null) store.setPeerRexHost("far", rexHost);
  store.replacePeerSnapshot("far", {
    ok: true,
    at: Date.now(),
    snapshot: {
      murmur_snapshot: 8,
      host_id: "FAR",
      display_name: "far",
      murmur_version: "3.0.2",
      generated_at: Date.now(),
      panes: [wirePane],
    },
  });
  return jumpTarget({ host_id: "FAR", server: { kind: "rex" }, pane: asPaneId("block:b1") });
}

test("prompt and stop reach a remote Rex pane: rex -S with a Rex host, its ssh without", async () => {
  const log: InputDelivery[] = [];
  const token = remoteRexToken("me@far");
  expect(await promptAgent(store, identity(), token, "go on", deps(log))).toEqual({
    ok: true,
    action: "prompt",
    jump_target: token,
  });
  expect(log[0]?.command).toBe("sh");
  expect(log[0]?.args.slice(3, 6)).toEqual(["me@far", "session:s1", "block:b1"]);
  expect(log[0]?.args).toContain("far.example");
  expect(log[0]?.input).toBe("go on");

  store.setPeerRexHost("far", null);
  expect(await stopAgent(store, identity(), token, deps(log))).toMatchObject({ ok: true });
  expect(log[1]?.command).toBe("ssh");
  expect(log[1]?.args.slice(-2)).toEqual([
    "far.example",
    "'rex' '--autostart=false' 'send-key' '-s' 'session:s1' '-b' 'block:b1' 'escape'",
  ]);
});

test("jump --json to a Rex pane needs no terminal: it runs the Rex jump", async () => {
  vi.stubEnv("TMUX", "");
  vi.stubEnv("TERM_PROGRAM", "");
  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const jump = vi.fn(() => ({ ok: true as const }));
  await runJump(
    store,
    identity(),
    remoteRexToken("me@far"),
    { fzf: () => "", mux: live(), rex: false, jump, interactive: () => false },
    { json: true },
  );
  expect(jump).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({ ok: true });
});
