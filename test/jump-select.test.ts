import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createIdentity, loadIdentity, type NodeIdentity } from "../src/identity.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { runJump } from "../src/jump-select.js";
import { jumpTarget } from "../src/jump-target.js";
import type { Mux } from "../src/mux.js";
import { openStore, type Store } from "../src/store.js";
import type { AgentMeta, Driver, Location } from "../src/types.js";
import { isVisible, type PaneView } from "../src/view.js";

let store: Store;

beforeEach(() => {
  vi.stubEnv("MURMUR_STATE_DIR", mkdtempSync(join(tmpdir(), "murmur-jump-select-")));
  createIdentity("here");
  store = openStore();
});

afterEach(() => {
  store.close();
  vi.unstubAllEnvs();
  process.exitCode = 0;
});

/** The `jump_target` `status --json` prints for a default-server pane. */
function key(host: string, pane: string): string {
  return jumpTarget({ host_id: host, server: { kind: "default" }, pane: asPaneId(pane) });
}

/** This node's host_id, which is half of every row key fzf hands back. */
function here(): string {
  return loadIdentity()?.host_id ?? "";
}

function identity(): NodeIdentity {
  const loaded = loadIdentity();
  if (!loaded) throw new Error("no identity");
  return loaded;
}

function location(pane: string): Location {
  return {
    server: { kind: "default" },
    session: asSessionId("$0"),
    window: asWindowId("@1"),
    pane: asPaneId(pane),
    session_name: "dev",
    window_name: pane,
  };
}

function meta(driver: Driver, agentName: string | null = null): AgentMeta {
  return {
    agent_name: agentName,
    pi_session: null,
    workstream: "murmur",
    role: null,
    cli: "pi",
    driver,
  };
}

/** A local pane with a running agent. */
function agent(pane: string, driver: Driver = "human", agentName: string | null = null): void {
  const claim = store.claimAgent({
    location: location(pane),
    owner_pid: process.pid,
    meta: meta(driver, agentName),
  });
  store.setActivity({
    agent_id: "agent_id" in claim ? claim.agent_id : "",
    owner_pid: process.pid,
    activity: "running",
    location: location(pane),
  });
}

function remotePane(pane: string) {
  return {
    server: { kind: "default" as const },
    pane: asPaneId(pane),
    session: asSessionId("$9"),
    window: asWindowId("@9"),
    session_name: "far",
    window_name: "remote",
    agent: {
      agent_id: "remote-agent",
      activity: "running" as const,
      agent_name: "remote-worker",
      pi_session: null,
      workstream: null,
      role: null,
      cli: "pi",
      harness: null,
      driver: "human" as const,
      model: null,
      provider: null,
      context_tokens: null,
      context_window: null,
      provider_effort: null,
      usage: null,
      pending: null,
      effort: null,
      context_pct: null,
      claimed_at: 1,
      updated_at: 1,
    },
    attention: [],
  };
}

test("enter focuses an attached local pane instead of opening another remote session", async () => {
  agent("%1", "human", "worker-1");
  store.addPeer("dev", "dev.example", "et dev -c 'tmux attach -t {pane}'");
  store.replacePeerSnapshot("dev", {
    ok: true,
    at: Date.now(),
    snapshot: {
      murmur_snapshot: 7,
      host_id: "REMOTE",
      display_name: "dev",
      murmur_version: "0.2.0",
      generated_at: 1,
      panes: [
        {
          server: { kind: "default" },
          pane: asPaneId("%9"),
          session: asSessionId("$9"),
          window: asWindowId("@9"),
          session_name: "far",
          window_name: "remote",
          agent: {
            agent_id: "remote-agent",
            activity: "running",
            agent_name: "worker-1",
            pi_session: null,
            workstream: "murmur",
            role: null,
            cli: "pi",
            harness: null,
            driver: "human",
            model: null,
            provider: null,
            context_tokens: null,
            context_window: null,
            provider_effort: null,
            usage: null,
            pending: null,
            effort: null,
            context_pct: null,
            claimed_at: 1,
            updated_at: 1,
          },
          attention: [],
        },
      ],
    },
  });

  const attached = asPaneId("%12");
  const mux = {
    localPaneProcesses: () => [
      {
        pane: attached,
        current_command: "et",
        arguments: "MU_AGENT_NAME=worker-1 MU_WORKSTREAM=murmur et dev",
      },
    ],
    attach: vi.fn(() => true),
  } as unknown as Mux;
  let jumped = false;

  runJump(store, identity(), key("REMOTE", "%9"), {
    fzf: () => "",
    jump: () => {
      jumped = true;
      return { ok: true };
    },
    mux,
  });

  expect(mux.attach).toHaveBeenCalledWith(attached);
  expect(jumped).toBe(false);

  expect(mux.attach).toHaveBeenCalledTimes(1);
  expect(jumped).toBe(false);
});

test("a cold remote jump warns and still proceeds when confirmed", async () => {
  agent("%1");
  store.addPeer("dev", "dev.example");
  store.replacePeerSnapshot("dev", {
    ok: true,
    at: Date.now(),
    snapshot: {
      murmur_snapshot: 7,
      host_id: "REMOTE",
      display_name: "dev",
      murmur_version: "0.2.0",
      generated_at: 1,
      panes: [remotePane("%9")],
    },
  });
  store.replacePeerSnapshot("dev", {
    ok: false,
    at: Date.now(),
    error: "Permission denied (keyboard-interactive).",
  });
  const warnings: string[] = [];
  let jumped = false;

  runJump(store, identity(), key("REMOTE", "%9"), {
    fzf: (args, _input) => {
      if (args.some((arg) => arg.includes("hardware token"))) {
        warnings.push(args.join("\n"));
        return "jump";
      }
      return "";
    },
    jump: () => {
      jumped = true;
      return { ok: true };
    },
    warm: () => false,
  });

  expect(warnings).toHaveLength(1);
  expect(jumped).toBe(true);
});

test("a cold remote jump can be cancelled after the warning", async () => {
  agent("%1");
  store.addPeer("dev", "dev.example");
  store.replacePeerSnapshot("dev", {
    ok: true,
    at: Date.now(),
    snapshot: {
      murmur_snapshot: 7,
      host_id: "REMOTE",
      display_name: "dev",
      murmur_version: "0.2.0",
      generated_at: 1,
      panes: [remotePane("%9")],
    },
  });
  store.replacePeerSnapshot("dev", {
    ok: false,
    at: Date.now(),
    error: "Permission denied (keyboard-interactive).",
  });
  let jumped = false;
  let warned = false;

  runJump(store, identity(), key("REMOTE", "%9"), {
    fzf: (args) => {
      if (args.some((arg) => arg.includes("hardware token"))) {
        warned = true;
        return "";
      }
      return "";
    },
    jump: () => {
      jumped = true;
      return { ok: true };
    },
    warm: () => false,
  });

  expect(warned).toBe(true);
  expect(jumped).toBe(false);
});

test("a crew pane hidden from the default view can still be jumped to", async () => {
  // A selection is resolved against the FULL list, never the rows a caller
  // displayed: filtering is presentation and must not gate the action. A picker
  // that reveals crew rows on demand hands back a key for a pane its launch
  // view hid, and resolving against the filtered list made enter a dead key.
  agent("%1");
  agent("%9", "orchestrated");

  // Precondition: this pane really is filtered out of the default view, so the
  // test exercises the gap rather than a coincidence.
  expect(isVisible({ driver: "orchestrated", attention: [] } as unknown as PaneView)).toBe(false);

  expect(await jumpWith(key(here(), "%9"))).toEqual(["%9"]);
  expect(process.exitCode).not.toBe(1);
});

test("an attention-only pane is jumpable, which keying on an agent id would break", async () => {
  // A codex pane has no agent row and therefore no agent id. Keying a jump on
  // one would make exactly the rows that need a human unreachable -- and those
  // rows are the reason the notify verb exists.
  store.requestAttention({
    kind: "blocked",
    location: location("%7"),
    message: "needs input",
    source: "codex",
    driver: "human",
  });

  expect(await jumpWith(key(here(), "%7"))).toEqual(["%7"]);
});

test("a selection is resolved on host AND pane, not on the pane alone", async () => {
  // Pane ids are unique per NODE, so two machines routinely hold a `%1`. The
  // jump target carries both for exactly this reason, and it is the whole
  // address -- matching on the pane alone jumped to whichever `%1` the sort put
  // first, which is a local window switch standing in for an ssh.
  agent("%1");
  store.addPeer("bubba", "bubba.example");
  store.replacePeerSnapshot("bubba", {
    ok: true,
    at: Date.now(),
    snapshot: {
      murmur_snapshot: 7,
      host_id: "REMOTE",
      display_name: "container-id",
      murmur_version: "0.2.0",
      generated_at: 1,
      panes: [
        {
          server: { kind: "default" },
          pane: asPaneId("%1"),
          session: asSessionId("$9"),
          window: asWindowId("@9"),
          session_name: "far",
          window_name: "remote",
          agent: {
            agent_id: "remote-agent",
            activity: "running",
            agent_name: "remote-worker",
            pi_session: null,
            workstream: null,
            role: null,
            cli: "pi",
            harness: null,
            driver: "human",
            model: null,
            provider: null,
            context_tokens: null,
            context_window: null,
            provider_effort: null,
            usage: null,
            pending: null,
            effort: null,
            context_pct: null,
            claimed_at: 1,
            updated_at: 1,
          },
          attention: [],
        },
      ],
    },
  });

  const jumped: PaneView[] = [];
  runJump(store, identity(), key("REMOTE", "%1"), {
    fzf: () => "",
    jump: (_store, pane: PaneView) => {
      jumped.push(pane);
      return { ok: true };
    },
    warm: () => true,
  });

  expect(jumped.map((pane) => pane.host_id)).toEqual(["REMOTE"]);
  expect(jumped[0]?.local).toBe(false);
});

// --- tokens straight from `status --json`, as `murmur jump` takes them ---

async function jumpWith(token: string, deps: Partial<Parameters<typeof runJump>[3]> = {}) {
  const identity = loadIdentity();
  if (!identity) throw new Error("no identity");
  const jumped: string[] = [];
  runJump(store, identity, token, {
    fzf: () => "",
    jump: (_store, pane: PaneView) => {
      jumped.push(pane.pane);
      return { ok: true };
    },
    ...deps,
  });
  return jumped;
}

test("jump resolves a local agent's jump_target", async () => {
  agent("%7");
  const token = jumpTarget({
    host_id: here(),
    server: { kind: "default" },
    pane: asPaneId("%7"),
  });
  expect(await jumpWith(token)).toEqual(["%7"]);
  expect(process.exitCode ?? 0).toBe(0);
});

test("jump on a pane that is gone fails with one line and exit 1", async () => {
  const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const token = jumpTarget({
    host_id: here(),
    server: { kind: "default" },
    pane: asPaneId("%404"),
  });
  expect(await jumpWith(token)).toEqual([]);
  expect(process.exitCode).toBe(1);
  expect(write).toHaveBeenCalledWith("%404 is no longer here.\n");
  write.mockRestore();
});

test("jump rejects a token that is not a jump target", async () => {
  const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  expect(await jumpWith("%7")).toEqual([]);
  expect(process.exitCode).toBe(1);
  write.mockRestore();
});

test("jump matches the tmux server, not only host and pane", async () => {
  // Same host, same pane id, a different server: the old host+pane match jumped
  // to whichever the sort put first.
  agent("%3");
  const token = jumpTarget({
    host_id: here(),
    server: { kind: "label", value: "private" },
    pane: asPaneId("%3"),
  });
  const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  expect(await jumpWith(token)).toEqual([]);
  expect(process.exitCode).toBe(1);
  write.mockRestore();
});

function stderrLines(run: () => unknown): string[] {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return writes.join("").split("\n").slice(0, -1);
}

test("a multi-line jump failure reaches stderr as exactly one line", async () => {
  agent("%7");
  const token = jumpTarget({ host_id: here(), server: { kind: "default" }, pane: asPaneId("%7") });
  const lines = stderrLines(() =>
    jumpWith(token, {
      jump: () => ({
        ok: false,
        reason: "unsupported_server",
        message:
          "murmur: dev's jump command uses {pane}\n\nupdate it:\n  murmur peer set dev --jump-command 'x'",
      }),
    }),
  );
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("update it:");
  expect(lines[0]).toContain("murmur peer set dev");
  expect(process.exitCode).toBe(1);
});

test("a stale target whose pane holds a newline still prints one line", async () => {
  const token = jumpTarget({
    host_id: "missing",
    server: { kind: "default" },
    pane: asPaneId("%123\nsecond line"),
  });
  const lines = stderrLines(() => jumpWith(token));
  expect(lines).toHaveLength(1);
  expect(process.exitCode).toBe(1);
});

test("Unicode line separators in a message do not make a second line", async () => {
  agent("%7");
  const token = jumpTarget({ host_id: here(), server: { kind: "default" }, pane: asPaneId("%7") });
  const lines = stderrLines(() =>
    jumpWith(token, {
      jump: () => ({ ok: false, reason: "attach_failed", message: "a\u2028b\u2029c\u0085d\re" }),
    }),
  );
  expect(lines).toHaveLength(1);
  expect(lines[0]).not.toMatch(/[\u2028\u2029\u0085\r]/);
});
