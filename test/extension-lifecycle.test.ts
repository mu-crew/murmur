import { expect, test, vi } from "vitest";

/**
 * Ownership over the extension's LIFETIME, as opposed to its per-event
 * decisions (test/extension-decide.test.ts).
 *
 * The store decides who owns a pane; this file is about the windows in between
 * those decisions. Every test here is a claim about what a second process in
 * the same pane cannot do, or about which agent row this process writes to
 * after its own ownership has changed underneath it.
 */

/**
 * Wait until `condition` holds, then return regardless.
 *
 * Same helper and the same reasoning as extension-decide.test.ts: handlers are
 * `void enqueue(...)`, so they return before their work runs, and that work
 * awaits a dynamic import. It returns rather than throws so a regression is
 * reported by the caller's `expect` and not by a timeout message that says
 * nothing about the behaviour.
 */
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

type Claim = { outcome: "claimed" | "retained" | "replaced" | "refused"; agent_id?: string };

type Rig = {
  handlers: Map<string, () => void | Promise<void>>;
  claims: { owner_pid: number; pane: string }[];
  writes: { activity: string; agent_id: string; owner_pid: number }[];
  releases: { agent_id: string; owner_pid: number; location: { pane: string } }[];
  badges: [string, string | null][];
  labels: [string, string | null][];
  opens: () => number;
  closes: () => number;
  attention: string[];
  runtime: Record<string, unknown>[];
  /** Deliver a payload on pi's in-process event bus, as another extension would. */
  emit: (channel: string, data: unknown) => void;
};

/**
 * Load the extension against a store whose claim answer is chosen per call.
 *
 * `claimAnswers` is consumed in order and the last entry repeats, which is how
 * a takeover is expressed: this process claimed successfully once and is
 * refused the next time it asks.
 */
async function rig(claimAnswers: Claim[], options: { setActivity?: boolean } = {}): Promise<Rig> {
  const claims: Rig["claims"] = [];
  const writes: Rig["writes"] = [];
  const releases: Rig["releases"] = [];
  const badges: Rig["badges"] = [];
  const labels: Rig["labels"] = [];
  const attention: string[] = [];
  const runtime: Record<string, unknown>[] = [];
  let opens = 0;
  let closes = 0;
  let asked = 0;

  vi.doMock("@mu-crew/murmur/extension-store", () => ({
    loadIdentity: () => ({ host_id: "H", display_name: "h" }),
    openStore: () => {
      opens += 1;
      return {
        claimAgent: (claim: { owner_pid: number; location: { pane: string } }) => {
          claims.push({ owner_pid: claim.owner_pid, pane: claim.location.pane });
          const answer = claimAnswers[Math.min(asked, claimAnswers.length - 1)];
          asked += 1;
          return answer?.outcome === "refused"
            ? { outcome: "refused", held_by_pid: 61980 }
            : { outcome: answer?.outcome, agent_id: answer?.agent_id };
        },
        setActivity: (update: { activity: string; agent_id: string; owner_pid: number }) => {
          writes.push(update);
          return options.setActivity ?? true;
        },
        requestAttention: (request: { kind: string }) => void attention.push(request.kind),
        setRuntime: (update: Record<string, unknown>) => {
          runtime.push(update);
          return true;
        },
        // What publishAgentStates reads: this process's pane, idle.
        localPanes: () => [
          {
            server: { kind: "default" },
            pane: "%1",
            session: "$0",
            window: "@1",
            session_name: null,
            window_name: null,
            agent: { agent_id: "a1", agent_name: "worker-1", cli: "pi", activity: "stopped" },
            attention: [],
          },
        ],
        releaseAgent: (release: {
          agent_id: string;
          owner_pid: number;
          location: { pane: string };
        }) => {
          releases.push(release);
          return true;
        },
        close: () => {
          closes += 1;
        },
      };
    },
  }));

  vi.doMock("node:child_process", () => ({ execFileSync: () => "0" }));

  vi.doMock("../src/mux.js", () => ({
    tmux: {
      currentWindow: () => ({
        session: "$0",
        window: "@1",
        pane: "%1",
        session_name: null,
        window_name: null,
      }),
      panesInWindow: () => ["%1"],
      setWindowState: (target: string, badge: string | null) => void badges.push([target, badge]),
      setPaneState: () => {},
      setPaneLabel: (pane: string, label: string | null) => void labels.push([pane, label]),
      sessionPanes: () => null,
      setStateCounts: () => {},
    },
  }));

  vi.resetModules();
  const { default: murmurPi } = await import("../src/extension/murmur-pi.js");
  // Real pi hands every handler `(event, ctx)`; the ones that ignore both just
  // declare no parameters. The harness curries those arguments away so a test
  // can call `handlers.get("agent_start")?.()` as before -- and passes an EMPTY
  // ctx, which is the older-pi case: no model, no thinking level, no context
  // usage, so the runtime report is skipped and these tests keep asserting only
  // activity and ownership.
  const handlers = new Map<string, () => void | Promise<void>>();
  const bus = new Map<string, (data: unknown) => void>();
  murmurPi({
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) =>
      handlers.set(event, () => handler({}, {}) as void | Promise<void>),
    events: {
      on: (channel: string, handler: (data: unknown) => void) => bus.set(channel, handler),
    },
  } as never);

  return {
    attention,
    runtime,
    emit: (channel, data) => bus.get(channel)?.(data),
    handlers,
    claims,
    writes,
    releases,
    badges,
    labels,
    opens: () => opens,
    closes: () => closes,
  };
}

function unmock(): void {
  vi.doUnmock("@mu-crew/murmur/extension-store");
  vi.doUnmock("node:child_process");
  vi.doUnmock("../src/mux.js");
  vi.resetModules();
}

test("a claim publishes the pane at once, so an idle agent is labelled before any turn", async () => {
  // A pi spawned by mu sits idle until it is sent work. If the tmux options are
  // written only by agent events, that pane has no @murmur_pane_label and no
  // window marker until its first turn -- observed on live workers that had
  // been idle for hours, their tabs showing the pane title instead.
  const r = await rig([{ outcome: "claimed", agent_id: "a1" }]);
  await until(() => r.labels.length > 0);

  expect(r.labels).toContainEqual(["%1", "worker-1"]);

  // And again after a reload: session_shutdown retracted what it painted.
  await r.handlers.get("session_shutdown")?.();
  const before = r.labels.length;
  await r.handlers.get("session_start")?.();
  await until(() => r.labels.slice(before).some(([, label]) => label !== null));

  expect(r.labels.slice(before)).toContainEqual(["%1", "worker-1"]);

  unmock();
});

test("a reload re-claims the pane at once, leaving no unowned window to lose it in", async () => {
  // `session_shutdown` RELEASES the agent row -- it must, because pi fires the
  // same event for a real quit, and a row left behind survives until something
  // notices its pid is gone. But pi also fires it for /reload, session switch,
  // resume and fork, and keeps using the same process afterwards.
  //
  // So between the release and this process's next agent event the pane has NO
  // agent row, and `claimAgent` refuses nobody. A pi started in that pane in
  // that window claims it legitimately; when the real owner's next event
  // arrives, the squatter is alive, the claim is REFUSED, and the refusal is
  // permanent for the process. A /reload could hand the pane away, and the
  // agent that lost it goes silent for the rest of its life while its badge
  // still paints.
  //
  // Claiming in `session_start` -- which pi fires immediately after the
  // shutdown, and which is where its own docs say to reestablish -- bounds that
  // window to the gap between two synchronous handler calls. It does not need
  // an agent event to have happened, and waiting for one is what made the
  // window unbounded.
  const r = await rig([
    { outcome: "claimed", agent_id: "a1" },
    { outcome: "claimed", agent_id: "a2" },
  ]);
  await until(() => r.claims.length === 1);
  expect(r.claims).toHaveLength(1);

  await r.handlers.get("session_shutdown")?.();
  await until(() => r.releases.length === 1);
  expect(r.releases).toMatchObject([
    { agent_id: "a1", owner_pid: process.pid, location: { pane: "%1" } },
  ]);

  await r.handlers.get("session_start")?.();
  // No agent event: the point is that ownership does not wait for one.
  await until(() => r.claims.length === 2);

  expect(r.claims).toEqual([
    { owner_pid: process.pid, pane: "%1" },
    { owner_pid: process.pid, pane: "%1" },
  ]);

  unmock();
});

test("a write after a reload names the re-claimed agent, never the released one", async () => {
  // The released `agent_id` is dead: `releaseAgent` deleted that row, so a
  // later write quoting it matches nothing and is silently dropped -- which is
  // the failure mode that reads as "the agent stopped reporting after a
  // /reload" and is invisible from the pane. The id this process writes under
  // has to be the one the most recent claim returned.
  const r = await rig([
    { outcome: "claimed", agent_id: "a1" },
    { outcome: "claimed", agent_id: "a2" },
  ]);
  await until(() => r.claims.length === 1);

  await r.handlers.get("agent_start")?.();
  await until(() => r.writes.length === 1);

  await r.handlers.get("session_shutdown")?.();
  await r.handlers.get("session_start")?.();
  await r.handlers.get("agent_start")?.();
  await until(() => r.writes.length === 2);

  expect(r.writes.map((write) => write.agent_id)).toEqual(["a1", "a2"]);
  // And every write is pid-keyed to THIS process, which is the half of the
  // store's `(agent_id, owner_pid)` key the extension is responsible for.
  expect(new Set(r.writes.map((write) => write.owner_pid))).toEqual(new Set([process.pid]));

  unmock();
});

test("a pane taken over mid-life silences this process instead of writing as the new owner", async () => {
  // The takeover direction of the six-pid bug. This process owned the pane, its
  // handle was dropped by a transient failure, and by the time it reopened a
  // replacement owner held the pane and is alive -- so its claim is refused.
  //
  // `refused` means someone else is the agent in this pane. Reporting anyway
  // would put this process's activity on another agent's row, which is exactly
  // what the store's pid gate exists to prevent, and painting a badge would
  // claim the window for an agent that no longer lives there.
  const r = await rig([{ outcome: "claimed", agent_id: "a1" }, { outcome: "refused" }]);
  await until(() => r.claims.length === 1);

  await r.handlers.get("agent_start")?.();
  await until(() => r.writes.length === 1);
  const badgesBefore = r.badges.length;

  // The reload cycle is what makes it ask again. Any path that re-claims does.
  await r.handlers.get("session_shutdown")?.();
  await r.handlers.get("session_start")?.();
  await until(() => r.claims.length === 2);

  await r.handlers.get("agent_start")?.();
  await r.handlers.get("agent_end")?.();
  await r.handlers.get("agent_settled")?.();
  // Waits for something that must not arrive, so this is not merely "it had not
  // happened yet".
  await until(() => r.writes.length > 1 || r.badges.length > badgesBefore + 1);

  expect(r.writes.map((write) => write.agent_id)).toEqual(["a1"]);
  // One badge after the takeover at most: `agent_end`'s clear, which is honest
  // about the window this process is leaving. Nothing may re-light it.
  expect(r.badges.slice(badgesBefore).filter(([, badge]) => badge !== null)).toEqual([]);

  unmock();
});

test("a replaced owner cannot light the window after its write is rejected", async () => {
  const r = await rig([{ outcome: "claimed", agent_id: "a1" }], { setActivity: false });
  await until(() => r.claims.length === 1);

  await r.handlers.get("agent_start")?.();
  await until(() => r.writes.length === 1);

  expect(r.badges.filter(([, badge]) => badge !== null)).toEqual([]);

  unmock();
});

test("a refused claim holds no store handle, however many events arrive", async () => {
  // A nested pi is refused for the life of the process, and it must not keep a
  // SQLite connection and its WAL read state open for that life -- the process
  // it lives in can run for days, and the handle it holds is one no write will
  // ever use. Opened once, closed at once, and never reopened: `session_start`
  // re-arms `absent` for a missing murmur or a missing identity, both of which
  // a human can fix from outside, but a second live process in one pane never
  // becomes the owner.
  const r = await rig([{ outcome: "refused" }]);
  await until(() => r.closes() === 1);

  await r.handlers.get("agent_start")?.();
  await r.handlers.get("agent_end")?.();
  await r.handlers.get("agent_settled")?.();
  await r.handlers.get("session_shutdown")?.();
  await r.handlers.get("session_start")?.();
  await r.handlers.get("agent_start")?.();
  await until(() => r.opens() > 1);

  expect(r.opens()).toBe(1);
  expect(r.closes()).toBe(1);
  expect(r.claims).toHaveLength(1);
  expect(r.writes).toEqual([]);
  expect(r.badges).toEqual([]);

  unmock();
});

test("a release only ever quotes this process's own claim", async () => {
  // `releaseAgent` is keyed on `(agent_id, owner_pid)` in the store, so the
  // damage a wrong id could do is bounded -- but the extension must not try. A
  // shutdown with no live claim (the handle was dropped, or the claim was
  // refused) has nothing to release, and a release quoting a stale id is a
  // request to delete a row this process does not own.
  const r = await rig([{ outcome: "claimed", agent_id: "a1" }]);
  await until(() => r.claims.length === 1);

  await r.handlers.get("session_shutdown")?.();
  await until(() => r.releases.length === 1);
  // A second shutdown with no intervening start: the claim is already gone.
  await r.handlers.get("session_shutdown")?.();
  await until(() => r.releases.length > 1);

  expect(r.releases).toMatchObject([
    { agent_id: "a1", owner_pid: process.pid, location: { pane: "%1" } },
  ]);

  unmock();
});

test("a settle with delegates outstanding raises no done; the settle after the last answer does", async () => {
  // The false "look here": an agent fans out mu delegates, ends its turn to wait
  // for them, and settles. Nothing is finished. Each answer re-runs it, so the
  // settle once the count is back to zero is the real `done`.
  const r = await rig([{ outcome: "claimed", agent_id: "a1" }]);
  await until(() => r.claims.length === 1);

  r.emit("murmur:pending", { source: "mu_delegate", count: 2 });
  await until(() => r.runtime.length === 1);
  expect(r.runtime[0]).toMatchObject({ agent_id: "a1", pending: 2 });

  await r.handlers.get("agent_settled")?.();
  // Waits for something that must not arrive.
  await until(() => r.attention.length > 0);
  expect(r.attention).toEqual([]);

  r.emit("murmur:pending", { source: "mu_delegate", count: 0 });
  await until(() => r.runtime.length === 2);
  expect(r.runtime[1]).toMatchObject({ pending: 0 });

  await r.handlers.get("agent_settled")?.();
  await until(() => r.attention.length > 0);
  expect(r.attention).toEqual(["done"]);

  unmock();
});

test("pending counts sum across sources and a malformed report changes nothing", async () => {
  const r = await rig([{ outcome: "claimed", agent_id: "a1" }]);
  await until(() => r.claims.length === 1);

  r.emit("murmur:pending", { source: "mu_delegate", count: 1 });
  r.emit("murmur:pending", { source: "jobs", count: 2 });
  r.emit("murmur:pending", { source: "jobs", count: -1 });
  r.emit("murmur:pending", { count: 5 });
  r.emit("murmur:pending", "3");
  // A repeat of the current total is not a change worth a write.
  r.emit("murmur:pending", { source: "jobs", count: 2 });
  await until(() => r.runtime.length >= 2);

  expect(r.runtime.map((write) => write.pending)).toEqual([1, 3]);

  unmock();
});
