import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { sshResolver } from "../src/attachment.js";
import type { Channel } from "../src/channel.js";
import { ssh } from "../src/channel.js";
import { createIdentity, type NodeIdentity } from "../src/identity.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { jumpTarget, parseJumpTarget } from "../src/jump-target.js";
import { status, statusJson, statusWithCollect, tmuxStatus } from "../src/status.js";
import { openStore, type Store } from "../src/store.js";
import type {
  AttentionKind,
  Driver,
  LocalPane,
  Location,
  Snapshot,
  SnapshotPane,
} from "../src/types.js";
import { STALENESS_MS } from "../src/view.js";
import { builtArtifact } from "./helpers/built.js";
import { fakeMux } from "./helpers/fake-mux.js";
import { localPane, recordedPanes, vtmuxMux, vtmuxRow } from "./helpers/panes.js";

const stores: Store[] = [];
let store: Store;
/** This node's live panes, as one local read would answer them. */
let local: LocalPane[] = [];

const IDENTITY: NodeIdentity = { host_id: "LOCAL", display_name: "here" };
// Real `ssh -G`, blind to the operator's ssh_config; the suite's ssh refuses
// any argv without `-F` (test/setup.ts).
const isolatedSsh = sshResolver(["-F", "/dev/null"]);

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-status-"));
  store = openStore();
  stores.push(store);
  local = [];
  // Never a real ssh from a unit test: a hung exec is the honest default,
  // because every caller of statusWithCollect must survive one.
  vi.spyOn(ssh, "exec").mockImplementation(async () => await new Promise<string>(() => {}));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const opened of stores.splice(0)) opened.close();
});

function location(pane: string): Location {
  return {
    server: { kind: "default" },
    session: asSessionId("$0"),
    window: asWindowId(`@${pane.slice(1)}`),
    pane: asPaneId(pane),
    session_name: "work",
    window_name: pane,
  };
}

/** A local pane with an agent, optionally running, optionally wanting attention. */
function localAgent(
  pane: string,
  options: {
    activity?: "running" | "stopped";
    driver?: Driver;
    attention?: AttentionKind[];
    message?: string;
    at?: number;
  } = {},
): void {
  const driver = options.driver ?? "human";
  local.push(
    localPane({
      ...location(pane),
      agent: {
        activity: options.activity ?? "stopped",
        workstream: "murmur",
        driver,
        agent_name: driver === "orchestrated" ? `crew${pane}` : null,
        updated_at: options.at ?? 1_000,
      },
      attention: (options.attention ?? []).map((kind) => ({
        kind,
        message: options.message ?? "",
        source: "pi",
        driver,
        requested_at: options.at ?? 1_000,
      })),
    }),
  );
}

function remoteSnapshot(panes: SnapshotPane[], generatedAt = 1_000): Snapshot {
  return {
    murmur_snapshot: 8,
    host_id: "REMOTE",
    display_name: "container-id-nobody-can-type",
    murmur_version: "0.2.0",
    generated_at: generatedAt,
    panes,
  };
}

/** A remote pane whose agent last said something at `updatedAt`. */
function remoteAgentPane(pane: string, updatedAt: number): SnapshotPane {
  const base = remotePane(pane);
  return {
    ...base,
    agent: base.agent === null ? null : { ...base.agent, updated_at: updatedAt },
  };
}

function remotePane(pane: string, over: Partial<SnapshotPane> = {}): SnapshotPane {
  return {
    server: { kind: "default" },
    pane: asPaneId(pane),
    session: asSessionId("$9"),
    window: asWindowId("@9"),
    session_name: "far",
    window_name: pane,
    agent: {
      activity: "running",
      agent_name: null,
      workstream: null,
      role: null,
      cli: "pi",
      harness: null,
      driver: "human",
      pending: null,
      pane_title: null,
      title: null,
      message: null,
      progress: null,
      blocked_kind: null,
      resume_command: null,
      resume_cwd: null,
      cwd: null,
      updated_at: 1,
    },
    attention: [],
    ...over,
  };
}

test("built status --cached reads named peer and local rows without helpers", () => {
  createIdentity("here");
  // A local row the store holds, since the stubbed tmux below answers nothing.
  store.recordCrash(location("%1"));
  store.addPeer("dev", "dev.example", "ssh dev.example {attach}");
  const remote = remotePane("%2");
  if (!remote.agent) throw new Error("expected a remote agent fixture");
  remote.agent.agent_name = "worker";
  store.replacePeerSnapshot("dev", { ok: true, at: 1, snapshot: remoteSnapshot([remote]) });
  store.replacePeerSnapshot("dev", { ok: false, at: 2, error: "Permission denied (publickey)." });

  const bin = mkdtempSync(join(tmpdir(), "murmur-status-helpers-"));
  const log = join(bin, "calls");
  for (const name of ["ssh", "tmux", "ps"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho ${name} >> "$CALLS"\nexit 1\n`, {
      mode: 0o755,
    });
  }
  const result = spawnSync(
    process.execPath,
    [builtArtifact("cli.js"), "status", "--json", "--cached"],
    {
      env: { ...process.env, PATH: bin, CALLS: log },
      encoding: "utf8",
      timeout: 5_000,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    peers: [expect.objectContaining({ needs_session: true })],
    panes: expect.arrayContaining([
      expect.objectContaining({ pane: "%1", local: true, runs_on: null }),
      expect.objectContaining({ pane: "%2", local: false, attached_pane: null }),
    ]),
  });
  expect(existsSync(log)).toBe(false);
});

test("counts group by render state, and attention beats activity", () => {
  localAgent("%1", { activity: "running" });
  localAgent("%2", { activity: "running", attention: ["blocked"] });
  localAgent("%3", { attention: ["crashed"] });
  localAgent("%4", { attention: ["done"] });
  localAgent("%5");
  localAgent("%6", { attention: ["error", "done"] });

  const result = status(store, IDENTITY, local);

  expect(result.counts).toEqual({
    crashed: 1,
    error: 1,
    blocked: 1,
    done: 1,
    running: 1,
    waiting: 0,
    idle: 1,
  });
  // Both facts survive on the row that carries both, which is the point of
  // keeping them separate: a running agent CAN be waiting on a human.
  const blocked = result.panes.find((pane) => pane.pane === "%2");
  expect(blocked).toMatchObject({ activity: "running" });
  expect(blocked?.attention.map((entry) => entry.kind)).toEqual(["blocked"]);
});

test("status --json rows carry the harness: a local pi row says pi, a row without an agent null", () => {
  localAgent("%1");
  localAgent("%2", { attention: ["done"] });
  const rows = JSON.parse(JSON.stringify(status(store, IDENTITY, local))).panes;
  const harness = (pane: string) =>
    rows.find((row: { pane: string }) => row.pane === pane)?.harness;
  expect(harness("%1")).toBe("pi");
  expect(harness("%2")).toBe("pi");
  expect(rows.every((row: { harness: unknown }) => "harness" in row)).toBe(true);
});

test("a remote worker points back to its matching local attachment", () => {
  store.addPeer("dev", "dev", "et dev -c 'tmux attach -t {pane}'");
  store.replacePeerSnapshot("dev", {
    ok: true,
    at: 1_000,
    snapshot: remoteSnapshot([
      remotePane("%50", {
        agent: {
          activity: "running",
          agent_name: "worker-1",
          workstream: "murmur",
          role: null,
          cli: "pi",
          harness: null,
          driver: "orchestrated",
          pending: null,
          pane_title: null,
          title: null,
          message: null,
          progress: null,
          blocked_kind: null,
          resume_command: null,
          resume_cwd: null,
          cwd: null,
          updated_at: 1,
        },
      }),
    ]),
  });

  const result = status(store, IDENTITY, local, 1_000, () => false, undefined, {
    mux: fakeMux({
      localPaneProcesses: () => [
        {
          pane: asPaneId("%7"),
          current_command: "et",
          // Real `ps eww -o command=` argv, captured from a live attach pane.
          // It carries NO environment -- see attachesAgent in src/status.ts.
          arguments: "et dev -c tmux attach -t mu-worker-1",
        },
      ],
    }),
  });

  expect(result.panes.find((pane) => pane.pane === "%50")).toMatchObject({
    agent_name: "worker-1",
    workstream: "murmur",
    attached_pane: asPaneId("%7"),
    pane_title: null,
    title: null,
    message: null,
    progress: null,
    blocked_kind: null,
    resume_command: null,
    resume_cwd: null,
    cwd: null,
    focused: false,
  });
});

test("a remote worker has no back-reference when no local pane matches", () => {
  store.addPeer("dev", "dev", "ssh -t dev tmux attach -t {pane}");
  store.replacePeerSnapshot("dev", {
    ok: true,
    at: 1_000,
    snapshot: remoteSnapshot([
      remotePane("%50", {
        agent: {
          activity: "running",
          agent_name: "worker-1",
          workstream: "murmur",
          role: null,
          cli: "pi",
          harness: null,
          driver: "orchestrated",
          pending: null,
          pane_title: null,
          title: null,
          message: null,
          progress: null,
          blocked_kind: null,
          resume_command: null,
          resume_cwd: null,
          cwd: null,
          updated_at: 1,
        },
      }),
    ]),
  });

  const result = status(store, IDENTITY, local, 1_000, () => false, undefined, {
    mux: fakeMux({
      localPaneProcesses: () => [
        {
          pane: asPaneId("%7"),
          current_command: "ssh",
          arguments: "ssh dev -t tmux attach -t mu-worker-2",
        },
      ],
    }),
  });

  expect(result.panes.find((pane) => pane.pane === "%50")?.attached_pane).toBeNull();
});

function remoteWorkerStore(name: string, jumpCommand = "ssh -t dev tmux attach -t {pane}") {
  store.addPeer("dev", "dev", jumpCommand);
  store.replacePeerSnapshot("dev", {
    ok: true,
    at: 1_000,
    snapshot: remoteSnapshot([
      remotePane("%50", {
        agent: {
          activity: "running",
          agent_name: name,
          workstream: "murmur",
          role: null,
          cli: "pi",
          harness: null,
          driver: "orchestrated",
          pending: null,
          pane_title: null,
          title: null,
          message: null,
          progress: null,
          blocked_kind: null,
          resume_command: null,
          resume_cwd: null,
          cwd: null,
          updated_at: 1,
        },
      }),
    ]),
  });
}

function attachedPaneFor(name: string, argv: string, jumpCommand?: string) {
  remoteWorkerStore(name, jumpCommand);
  const result = status(store, IDENTITY, local, 1_000, () => false, undefined, {
    mux: fakeMux({
      localPaneProcesses: () => [{ pane: asPaneId("%7"), current_command: "ssh", arguments: argv }],
    }),
    resolveSsh: isolatedSsh,
  });
  return result.panes.find((pane) => pane.pane === "%50")?.attached_pane ?? null;
}

// Dogfooded 2026-09-09 against a real worker on a remote host. The detached
// recipe is the one mu recommends for a session-capped host, and it was the one
// that could never match while detection read the environment.
test("the detached-tmux recipe is detected, since mu names the session for the agent", () => {
  expect(attachedPaneFor("remote-1", "ssh dev -t tmux attach -t mu-remote-1")).toBe("%7");
});

test("the direct recipe is detected, where the name is in the remote command", () => {
  expect(
    attachedPaneFor(
      "remote-1",
      "ssh dev -t cd ~/ws/remote-1 && MU_MANAGED_AGENT=1 MU_AGENT_NAME=remote-1 pi --approve",
    ),
  ).toBe("%7");
});

// An env-var PREFIX is consumed by the shell, so it never reaches argv. The
// skill documented repeating the vars on the attach command as a workaround;
// this is the test proving that advice was wrong.
test("an environment prefix is not what makes a match, because ps never returns it", () => {
  expect(attachedPaneFor("remote-1", "ssh dev -t tmux attach -t some-other-session")).toBeNull();
});

// Dogfooded with a real ET jump command configured on a peer:
//   murmur peer set dev --jump-command "et dev -c 'tmux attach -t {pane}'"
// The rendered argv names the PANE and never the agent, so a name-only matcher
// missed the case the back-reference exists for -- a second attach through the
// default ssh jump command is what fails on a session-capped host.
test("a jump through the peer's configured command is detected by its pane id", () => {
  expect(
    attachedPaneFor(
      "remote-1",
      "et dev -c tmux attach -t %50",
      "et dev -c 'tmux attach -t {pane}'",
    ),
  ).toBe("%7");
});

test("a pane id is matched whole, not as a prefix", () => {
  // %50 must not be found inside %500.
  expect(
    attachedPaneFor(
      "remote-1",
      "et dev -c tmux attach -t %500",
      "et dev -c 'tmux attach -t {pane}'",
    ),
  ).toBeNull();
});

test("a longer agent name is not matched by a shorter one's prefix", () => {
  expect(attachedPaneFor("worker-1", "ssh dev -t tmux attach -t mu-worker-10")).toBeNull();
});

test("a remote pane keeps its own node's fields and takes its node's freshness", () => {
  store.addPeer("dev", "dev.example");
  store.replacePeerSnapshot("dev", {
    ok: true,
    at: 1_000,
    snapshot: remoteSnapshot([remotePane("%50")]),
  });

  const result = status(store, IDENTITY, local, 121_001);

  const remote = result.panes.find((pane) => pane.pane === "%50");
  expect(remote).toMatchObject({
    host_id: "REMOTE",
    // The configured peer name, not the machine's self-reported display_name:
    // that can be a container id nobody can type back at `peer remove`.
    host: "dev",
    local: false,
    activity: "running",
    // Freshness is a property of the NODE and never of an agent, and a stale
    // node keeps its last-known fields verbatim rather than being reinterpreted.
    freshness: "stale",
  });
  expect(result.counts.running).toBe(1);
});

test("local panes are always fresh, and no read path probes a pid", () => {
  // A local pane is authored by this node, so there is nothing to be stale
  // about. Freshness answers "how recently did we reach the node that told us",
  // and for our own panes the answer is always "now".
  localAgent("%1", { activity: "running" });

  const result = status(store, IDENTITY, local, Date.now() + 86_400_000);

  expect(result.panes[0]).toMatchObject({ local: true, freshness: "fresh", host: "here" });
  // The whole returned graph, structurally: no pid crosses into a view, so
  // remote liveness inference is unrepresentable rather than merely avoided.
  expect(JSON.stringify(result)).not.toContain("owner_pid");
  expect(JSON.stringify(result)).not.toContain(String(process.pid));
});

test("a crash murmur recorded is a listable row, named as it was last seen", () => {
  // A pane that vanished mid-work has no program left to report it: its row
  // is murmur's own, and it must still be visible and jumpable.
  store.recordCrash(location("%7"), 1_000);
  const result = status(store, IDENTITY, recordedPanes(store));

  expect(result.panes).toHaveLength(1);
  expect(result.panes[0]).toMatchObject({ pane: "%7", activity: "stopped", driver: "human" });
  expect(result.panes[0]?.attention).toEqual([
    { kind: "crashed", requested_at: 1_000, message: "pane vanished while working" },
  ]);
  expect(result.panes[0]?.updated_at).toBe(1_000);
  expect(result.counts.crashed).toBe(1);
});

test("human and orchestrated panes are counted separately but both listed", () => {
  localAgent("%1", { attention: ["blocked"] });
  localAgent("%2", { activity: "running", driver: "orchestrated" });
  localAgent("%3", { activity: "running", driver: "orchestrated" });

  const result = status(store, IDENTITY, local);

  expect(result.counts.blocked).toBe(1);
  expect(result.counts.running).toBe(0);
  expect(result.orchestrated_counts.running).toBe(2);
  expect(result.panes).toHaveLength(3);
});

test("tmux status emits urgent counts and never agent-supplied text", () => {
  const injection = "#(touch /tmp/pwned)";
  localAgent("%1", { attention: ["crashed"] });
  localAgent("%2", { attention: ["blocked"] });
  localAgent("%3", { attention: ["done"] });
  localAgent("%4", { activity: "running" });
  localAgent("%5");
  // A program whose own words are hostile: the claim under test is that NO
  // agent-supplied text reaches the status bar.
  localAgent("%6", { attention: ["blocked"], message: injection });
  store.addPeer(injection, injection);

  const output = tmuxStatus(status(store, IDENTITY, local));

  expect(output).toBe("crashed\t1\nblocked\t2\ndone\t1\nworking\t1\nidle\t1\n");
  expect(output).not.toContain(injection);
});

test("a crew agent that needs a human is counted, one that does not is not", () => {
  // The distinction `driver` exists for, applied per state rather than
  // wholesale. A supervisor consumes a `done` worker's result and nobody has to
  // acknowledge it; a `running` worker asks for nothing. But an orchestrator
  // cannot answer a question meant for a human, and it may never retry a worker
  // that died.
  localAgent("%1", { driver: "orchestrated", attention: ["blocked"] });
  localAgent("%2", { driver: "orchestrated", attention: ["crashed"] });
  localAgent("%3", { driver: "orchestrated", attention: ["done"] });
  localAgent("%4", { driver: "orchestrated", activity: "running" });

  expect(tmuxStatus(status(store, IDENTITY, local))).toBe("crashed\t1\nblocked\t1\ncrew\t4\n");
});

test("tmux status reports the total for a crew-only fleet", () => {
  localAgent("%1", { driver: "orchestrated", activity: "running" });

  expect(tmuxStatus(status(store, IDENTITY, local))).toBe("crew\t1\n");
});

test("tmux status omits the crew record when no crew agents exist", () => {
  localAgent("%1", { activity: "running" });

  expect(tmuxStatus(status(store, IDENTITY, local))).toBe("working\t1\n");
});

test("status works with no peers configured", () => {
  localAgent("%1", { activity: "running" });

  const result = status(store, IDENTITY, local);

  expect(result.peers).toEqual([]);
  expect(result.counts.running).toBe(1);
  expect(result.panes[0]).toMatchObject({ local: true, fetched_at: null, snapshot_at: null });
});

test("a peer that has never been reached is stale, not fresh", () => {
  // Null `fetched_at` on a PEER means the first collect has not succeeded, which
  // is the opposite of the answer that reads well for a local pane. Found live:
  // an unreachable host added with `peer add` rendered as up to date.
  store.addPeer("ghost", "192.0.2.1");

  const view = status(store, IDENTITY, local);

  expect(view.peers[0]).toMatchObject({ fetched_at: null, stale: true });
});

test("a peer's staleness is the view's freshness verdict, not a second threshold", () => {
  // One definition of "how long is too long", used by the peer list and by every
  // pane that peer contributes. Two copies of the number is how a peer could
  // read stale in `peer list` while its panes rendered fresh in the picker -- a
  // disagreement no operator can resolve from the output.
  const at = 1_000;
  store.addPeer("dev", "dev");
  store.replacePeerSnapshot("dev", { ok: true, at, snapshot: remoteSnapshot([remotePane("%50")]) });

  const edge = status(store, IDENTITY, local, at + STALENESS_MS);
  expect(edge.peers[0]?.stale).toBe(false);
  expect(edge.panes.find((pane) => pane.pane === "%50")?.freshness).toBe("fresh");

  const over = status(store, IDENTITY, local, at + STALENESS_MS + 1);
  expect(over.peers[0]?.stale).toBe(true);
  expect(over.panes.find((pane) => pane.pane === "%50")?.freshness).toBe("stale");
});

test("snapshot_at and fetched_at are not interchangeable", () => {
  // The two clocks. A node polled one second ago can be serving a three-hour-old
  // fact, and collapsing the two is how that read as fresh.
  const now = Date.now();
  const old = now - 3 * 3_600_000;
  store.addPeer("p", "p");
  store.replacePeerSnapshot("p", {
    ok: true,
    at: now,
    snapshot: remoteSnapshot([remoteAgentPane("%50", old)], old),
  });

  const view = status(store, IDENTITY, local, now);
  const pane = view.panes.find((candidate) => candidate.host_id === "REMOTE");

  // The NODE is fresh: we reached it just now.
  expect(pane?.freshness).toBe("fresh");
  expect(pane?.fetched_at).toBe(now);
  // The INFORMATION is not, and the view shows both.
  expect(pane?.snapshot_at).toBe(old);
  expect(pane?.updated_at).toBe(old);
  expect(view.peers[0]).toMatchObject({ fetched_at: now, snapshot_at: old, stale: false });
});

test("statusWithCollect awaits the collect before reading", async () => {
  // Regression: status() used to fire a fire-and-forget collect, so the view it
  // returned predated the sync that had just run, and the CLI's store.close()
  // in a finally raced the in-flight write -- "The database connection is not
  // open", which reads as corruption rather than a race.
  //
  // Needs a real peer and a channel we control: with no peers, collect is a
  // no-op loop and deleting the `await` leaves the test green.
  store.addPeer("dev", "dev");

  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const channel: Channel = {
    exec: async () => {
      await held;
      return JSON.stringify(remoteSnapshot([remotePane("%far")]));
    },
  };

  let settled = false;
  // The mux is named, not defaulted: `statusWithCollect` collects, and a collect
  // reads every local tmux server.
  const pending = statusWithCollect(store, IDENTITY, Date.now(), channel, {
    mux: vtmuxMux([vtmuxRow({ pane: "%1", state: "working" })]),
    rex: false,
  }).then((view) => {
    settled = true;
    return view;
  });

  await new Promise((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);

  release?.();
  const view = await pending;

  // And the returned view reflects the sync that just ran, not the one before.
  expect(view.panes.map((pane) => pane.pane)).toEqual(expect.arrayContaining(["%far", "%1"]));
  expect(view.peers[0]?.fetched_at).not.toBeNull();
  expect(() => store.close()).not.toThrow();
});

test("blocked panes lead oldest-first: the longer wait is the one starving", () => {
  // Two blocked panes, so state cannot decide the order and age has to. A
  // pane's age is when it entered its state (`pane_program_state_time`).
  localAgent("%fresh", { attention: ["blocked"], at: 9_000 });
  localAgent("%stale", { attention: ["blocked"], at: 2_000 });

  const result = status(store, IDENTITY, local);

  const byPane = new Map(result.panes.map((pane) => [pane.pane as string, pane]));
  expect(byPane.get("%fresh")?.updated_at).toBe(9_000);
  expect(byPane.get("%stale")?.updated_at).toBe(2_000);
  expect(result.panes.map((pane) => pane.pane)).toEqual(["%stale", "%fresh"]);
});

/** A peer that has answered before, then failed, for the gating tests below. */
function gatedPeer(name: string, error: string): void {
  store.addPeer(name, name);
  // A successful fetch first: "has answered before" is the fact that separates a
  // re-auth prompt from a host that is merely switched off.
  store.replacePeerSnapshot(name, { ok: true, at: 1_000, snapshot: remoteSnapshot([]) });
  store.replacePeerSnapshot(name, { ok: false, at: 2_000, error });
}

test("a peer that cannot authenticate unattended is marked needs_session", () => {
  // The operator-actionable state: murmur has reached this host before, the last
  // attempt was refused on auth, and no warm ControlMaster socket exists to ride.
  // `ssh <host>` is the only thing that fixes it.
  gatedPeer("dev", "Permission denied (keyboard-interactive).");

  const result = status(store, IDENTITY, local, 3_000, () => false);

  expect(result.peers[0]).toMatchObject({ name: "dev", needs_session: true });
});

test("a warm socket clears needs_session without a collect", () => {
  // The self-correcting half, and the reason this is derived rather than stored:
  // the operator runs `ssh dev`, a ControlMaster socket appears, and the state
  // clears on the next READ. No successful fetch required, no flag to reset.
  gatedPeer("dev", "Permission denied (keyboard-interactive).");

  const result = status(store, IDENTITY, local, 3_000, () => true);

  expect(result.peers[0]?.needs_session).toBe(false);
});

test("a switched-off box is not asked to re-auth", () => {
  // The protection that matters: never tell an operator to `ssh` into a host
  // that is simply off, because the advice is unactionable.
  //
  // Asserted through the ERROR rather than through history, which is the
  // correction this replaced. An earlier version required a cached snapshot as
  // proof of contact, and that excluded a peer row re-added by hand -- the exact
  // case the feature exists for. The classifier carries the proof instead:
  // producing `Permission denied` needs a completed connect, key exchange and
  // auth round, so an unreachable host cannot say it.
  store.addPeer("linuxpc", "linuxpc");
  store.replacePeerSnapshot("linuxpc", {
    ok: false,
    at: 2_000,
    error: "ssh: connect to host linuxpc port 22: Operation timed out",
  });

  const result = status(store, IDENTITY, local, 3_000, () => false);

  expect(result.peers[0]?.needs_session).toBe(false);
});

test("a peer refused on auth is asked to re-auth even if it never once worked", () => {
  // The regression this whole correction is for. `murmur peer add` writes only
  // `(name, target)`, so a re-added peer has a NULL snapshot and has "never
  // worked" -- and the reminder must still fire, because being refused on auth
  // is itself evidence murmur reached the host.
  //
  // No successful fetch is seeded, unlike every other test here. That omission
  // is the point: seeding one is what hid this on the way in.
  store.addPeer("dev", "dev");
  store.replacePeerSnapshot("dev", {
    ok: false,
    at: 2_000,
    error: "Permission denied (keyboard-interactive).",
  });

  const result = status(store, IDENTITY, local, 3_000, () => false);

  expect(result.peers[0]).toMatchObject({ name: "dev", needs_session: true });
});

test("an unreachable peer is not asked to re-auth", () => {
  // The proxy-failure case, which is what the live `dev` peer currently holds.
  // Unreachability is not fixable by authenticating, so it must not produce the
  // prompt -- the advice would be unactionable.
  gatedPeer("dev", "Connection closed by UNKNOWN port 65535");

  const result = status(store, IDENTITY, local, 3_000, () => false);

  expect(result.peers[0]?.needs_session).toBe(false);
});

test("the warm-socket probe runs only for auth-class candidates", () => {
  // Cost control, asserted rather than assumed: the probe is ~20ms per host
  // against a picker launch path measured at ~60ms, so probing every peer would
  // more than double it to answer questions nobody reads. The three conditions
  // left of the probe are free cached reads and exist to gate it.
  gatedPeer("dev", "Permission denied (keyboard-interactive).");
  store.addPeer("bubba", "bubba");
  store.replacePeerSnapshot("bubba", { ok: true, at: 1_000, snapshot: remoteSnapshot([]) });

  const probed: string[] = [];
  status(store, IDENTITY, local, 3_000, (target) => {
    probed.push(target);
    return false;
  });

  expect(probed).toEqual(["dev"]);
});

test("status --json contract: stable fields are present with their types", () => {
  localAgent("%1", { activity: "running" });
  localAgent("%2", { driver: "orchestrated" });
  localAgent("%3", { attention: ["blocked"], driver: "orchestrated" });
  const json = JSON.parse(
    JSON.stringify(
      statusJson(status(store, IDENTITY, local, Date.now(), () => false, {}, { mux: fakeMux() })),
    ),
  );
  expect(Array.isArray(json.peers)).toBe(true);
  expect(json.panes).toHaveLength(3);
  for (const pane of json.panes) {
    for (const key of [
      "host_id",
      "host",
      "pane",
      "window",
      "label",
      "jump_target",
      "render_state",
    ]) {
      expect(typeof pane[key], key).toBe("string");
    }
    expect(typeof pane.local).toBe("boolean");
    expect(typeof pane.visible).toBe("boolean");
    expect(typeof pane.server.kind).toBe("string");
    expect(Array.isArray(pane.attention)).toBe(true);
    for (const key of ["session_name", "window_name", "runs_on", "pending", "attached_pane"]) {
      expect(pane, key).toHaveProperty(key);
    }
  }
  const byPane = Object.fromEntries(json.panes.map((pane: { pane: string }) => [pane.pane, pane]));
  // tmux vocabulary: working, never running.
  expect(byPane["%1"].render_state).toBe("working");
  expect(byPane["%1"].visible).toBe(true);
  expect(byPane["%2"].render_state).toBe("idle");
  expect(byPane["%2"].visible).toBe(false);
  // Crew that needs a human stays visible.
  expect(byPane["%3"].render_state).toBe("blocked");
  expect(byPane["%3"].visible).toBe(true);
  expect(parseJumpTarget(byPane["%1"].jump_target)).toEqual({
    host_id: "LOCAL",
    server: { kind: "default" },
    pane: "%1",
  });
});

test("jump_target round-trips a server label with awkward characters", () => {
  const server = { kind: "label" as const, value: "my server|/é" };
  const token = jumpTarget({ host_id: "H", server, pane: asPaneId("%9") });
  expect(parseJumpTarget(token)).toEqual({ host_id: "H", server, pane: "%9" });
  expect(parseJumpTarget("garbage")).toBeNull();
  expect(parseJumpTarget("j1:!!")).toBeNull();
});

test("a local attachment is credited only to the pane on the server it names", () => {
  store.addPeer("dev", "dev.example", "ssh -t dev {attach}");
  const named = (agent_name: string, over: Partial<SnapshotPane>): SnapshotPane => {
    const base = remotePane("%1", over);
    return {
      ...base,
      agent: base.agent && { ...base.agent, agent_name },
    };
  };
  store.replacePeerSnapshot("dev", {
    ok: true,
    at: 1_000,
    snapshot: remoteSnapshot([
      named("alpha", {}),
      named("beta", { server: { kind: "label", value: "private é" } }),
    ]),
  });
  const attached = (argv: string) => {
    const result = status(store, IDENTITY, local, 1_000, () => false, undefined, {
      mux: fakeMux({
        localPaneProcesses: () => [
          { pane: asPaneId("%55"), current_command: "ssh", arguments: argv },
        ],
      }),
      resolveSsh: isolatedSsh,
    });
    return Object.fromEntries(result.panes.map((pane) => [pane.agent_name, pane.attached_pane]));
  };
  expect(attached("ssh dev tmux -L 'private é' attach -t %1")).toEqual({
    alpha: null,
    beta: "%55",
  });
  expect(attached("ssh dev tmux attach -t %1")).toEqual({ alpha: "%55", beta: null });
  // tmux takes its global flags in any order, so a selector after another
  // flag still names the server, and a no-arg flag alone is still the default.
  expect(attached("ssh dev tmux -u -L 'private é' attach -t %1")).toEqual({
    alpha: null,
    beta: "%55",
  });
  expect(attached("ssh dev tmux -2u attach -t %1")).toEqual({ alpha: "%55", beta: null });
  // A flag that is not read, `-S` overriding `-L` as tmux does, a config
  // file, or two attaches: the server cannot be named, so neither is credited.
  for (const argv of [
    "ssh dev tmux -X attach -t %1",
    "ssh dev tmux -S /tmp/elsewhere -L 'private é' attach -t %1",
    "ssh dev tmux -f /tmp/conf attach -t %1",
    "ssh dev tmux -L 'private é' attach -t %1 ; tmux attach -t %1",
  ]) {
    expect(attached(argv), argv).toEqual({ alpha: null, beta: null });
  }
});

test("an attachment is credited to the peer its argv connects to, not the first with that pane id", () => {
  // Two peers both reporting %9. Matching on the pane id and the transport
  // name alone credited the attachment to whichever peer came first, and jump
  // then focused that local pane instead of reaching the other host.
  const peerWith = (name: string, target: string) => {
    store.addPeer(name, target, `ssh -t '${target}' env LC_CTYPE=C.UTF-8 {attach}`);
    const base = remotePane("%9");
    store.replacePeerSnapshot(name, {
      ok: true,
      at: 1_000,
      snapshot: {
        ...remoteSnapshot([{ ...base, agent: base.agent && { ...base.agent, agent_name: name } }]),
        host_id: `host-${name}`,
      },
    });
  };
  peerWith("first", "first.example");
  peerWith("second", "second.example");
  const attached = (argv: string, command = "ssh") => {
    const result = status(store, IDENTITY, local, 1_000, () => false, undefined, {
      mux: fakeMux({
        localPaneProcesses: () => [
          { pane: asPaneId("%55"), current_command: command, arguments: argv },
        ],
      }),
      resolveSsh: isolatedSsh,
    });
    return Object.fromEntries(result.panes.map((pane) => [pane.agent_name, pane.attached_pane]));
  };

  expect(attached("ssh -t second.example env LC_CTYPE=C.UTF-8 tmux attach -t %9")).toEqual({
    first: null,
    second: "%55",
  });
  expect(attached("ssh -p 22 -i key first.example tmux attach -t %9")).toEqual({
    first: "%55",
    second: null,
  });
  // ssh connects where the overrides say, not where the operand says: this is
  // neither peer, and a port or login change is another sshd or another
  // user's tmux.
  for (const argv of [
    "ssh -o HostName=elsewhere.example first.example tmux attach -t %9",
    "ssh -oHostName=second.example first.example tmux attach -t %9",
    "ssh -p 2222 first.example tmux attach -t %9",
    "ssh -l someone-else first.example tmux attach -t %9",
    // Same hostname, user and port through a bastion is the bastion's
    // first.example, another machine.
    "ssh -J bastion.example first.example tmux attach -t %9",
    "ssh -o ProxyCommand=bastion-pipe first.example tmux attach -t %9",
  ]) {
    expect(attached(argv), argv).toEqual({
      first: null,
      second: argv.includes("HostName=second") ? "%55" : null,
    });
  }
  // An unrelated local ssh session naming the same pane id is nobody's.
  expect(attached("ssh -t elsewhere.example tmux attach -t %9")).toEqual({
    first: null,
    second: null,
  });
});

test("an opaque transport earns no attachment, since its argv cannot name the host", () => {
  store.addPeer("dev", "dev.example", "jump-dev {attach}");
  const base = remotePane("%9");
  store.replacePeerSnapshot("dev", {
    ok: true,
    at: 1_000,
    snapshot: remoteSnapshot([
      { ...base, agent: base.agent && { ...base.agent, agent_name: "w" } },
    ]),
  });
  const result = status(store, IDENTITY, local, 1_000, () => false, undefined, {
    mux: fakeMux({
      localPaneProcesses: () => [
        {
          pane: asPaneId("%55"),
          current_command: "jump-dev",
          arguments: "jump-dev tmux attach -t %9",
        },
      ],
    }),
  });
  expect(result.panes.find((pane) => pane.pane === "%9")?.attached_pane).toBeNull();
});

test("status --json carries each pane's resume record, local and remote", () => {
  // OSC 7577, for a resolver such as mural: how to relaunch the program, and
  // where. Null, never absent, for a program that published none.
  local.push(
    localPane({
      ...location("%1"),
      agent: {
        resume_command: "pi --session /home/u/.pi/sessions/a.jsonl",
        resume_cwd: "/work",
        cwd: "/work/sub",
      },
    }),
  );
  localAgent("%2");
  store.addPeer("dev", "dev.example");
  const remote = remotePane("%9");
  if (!remote.agent) throw new Error("expected a remote agent fixture");
  remote.agent.resume_command = "claude --resume 0b5c";
  remote.agent.resume_cwd = "/srv";
  store.replacePeerSnapshot("dev", { ok: true, at: 1_000, snapshot: remoteSnapshot([remote]) });

  const json = JSON.parse(
    JSON.stringify(
      statusJson(status(store, IDENTITY, local, 1_000, () => false, {}, { mux: fakeMux() })),
    ),
  );
  const byPane = Object.fromEntries(json.panes.map((pane: { pane: string }) => [pane.pane, pane]));
  expect(byPane["%1"]).toMatchObject({
    resume_command: "pi --session /home/u/.pi/sessions/a.jsonl",
    resume_cwd: "/work",
    cwd: "/work/sub",
  });
  expect(byPane["%2"]).toMatchObject({ resume_command: null, resume_cwd: null });
  expect(byPane["%9"]).toMatchObject({
    local: false,
    resume_command: "claude --resume 0b5c",
    resume_cwd: "/srv",
  });
});

test("status --json names the waiting state for an agent with delegates out", () => {
  // `mu/delegates` under `working` reads as `waiting`: the agent ended its turn
  // and its delegates' answers will re-run it.
  local.push(localPane({ ...location("%1"), agent: { activity: "stopped", pending: 3 } }));
  const json = statusJson(
    status(store, IDENTITY, local, 1_000, () => false, {}, { mux: fakeMux() }),
  );
  expect(json.panes[0]).toMatchObject({ render_state: "waiting", pending: 3 });
  expect(json.counts.waiting).toBe(1);
});
