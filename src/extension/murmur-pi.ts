import { execFileSync } from "node:child_process";
import { publishAgentStates } from "../agent-state.js";
import { tmux } from "../mux.js";
import type { Store } from "../store.js";
import type { Activity, AgentMeta, AgentRuntime, Location } from "../types.js";
import {
  driverFromEnv,
  foldPending,
  isReportableTurn,
  PENDING_CHANNEL,
  type RuntimeContext,
  type RuntimeMessage,
  runtimeFromContext,
  settledState,
  turnError,
  usageFromMessage,
} from "./decide.js";
import type { StoreModule } from "./store-api.js";

// Declared, not imported: murmur must not depend on pi to build, and this is the
// whole surface the extension touches. `getSessionName` is optional because an
// older pi lacks it, and a missing method must degrade to "no name".
//
// No `reason` on any event. pi puts one on session_shutdown ("quit" | "reload" |
// "new" | "resume" | "fork"), but the response is the same for all five: release
// the agent, clear the badge, drop the handle. What differs is whether anything
// follows, and session_start answers that by firing.
type ExtensionAPI = {
  on(
    event: "agent_settled" | "session_shutdown" | "session_start",
    handler: () => void | Promise<void>,
  ): void;
  // The runtime-reporting events: each reads `ctx`, and `message_end` reads the
  // assistant message. Every member of both payloads is optional in
  // `RuntimeContext` / `RuntimeMessage`, so a pi that lacks any of them degrades
  // to reporting nothing rather than crashing -- which is why murmur can declare
  // this surface instead of depending on pi to build.
  //
  // `agent_start` is here because a run beginning is the moment to state what
  // this agent is running WITH -- a resumed session may never emit a
  // model_select or complete a turn, and would otherwise report nothing at all.
  on(
    event: "agent_start" | "agent_end" | "turn_start" | "model_select" | "thinking_level_select",
    handler: (event: unknown, ctx: RuntimeContext) => void,
  ): void;
  // NOT `turn_end`. Registering any turn_end handler switches on pi's
  // actionable turn boundary, which must resolve the assistant's persisted
  // entry id; during `/new` pi aborts the run before that entry exists and
  // reports a boundary error. `message_end` carries the same assistant message
  // with no boundary attached. Its handler may return a replacement message, so
  // this one must return nothing.
  on(event: "message_end", handler: (event: { message?: RuntimeMessage }) => void): void;
  getSessionName?(): string | undefined;
  // pi's in-process bus between extensions.
  events: { on(channel: string, handler: (data: unknown) => void): unknown };
};

// Where to import the store from.
//
// The bare specifier only resolves when murmur is a dependency of the importer,
// which it never is: the extension loads from ~/.pi/agent/extensions, and a
// global murmur is not resolvable from there. Unpinned, the import throws,
// getStore swallows it, and every write no-ops while the badge still paints --
// so nothing looks broken while the node exports nothing.
//
// Two ways it gets pinned, because there are two install shapes:
//
//   $MURMUR_STORE_MODULE  set by the shim `murmur link pi` writes, which is a
//                         re-export of THIS file from the murmur install. The
//                         shim cannot rewrite this constant (it does not copy
//                         the source), so it passes the path instead.
//   link pi --copy        inlines this file and rewrites the string literal.
const storeModule = process.env.MURMUR_STORE_MODULE || "@mu-crew/murmur/extension-store";
const muManaged = process.env.MU_MANAGED_AGENT === "1";
const driver = driverFromEnv(process.env);

function focused(pane: string): boolean {
  try {
    return (
      execFileSync(
        "tmux",
        [
          "display-message",
          "-t",
          pane,
          "-p",
          "#{&&:#{pane_active},#{&&:#{window_active},#{session_attached}}}",
        ],
        { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] },
      ).trim() === "1"
    );
  } catch {
    return false;
  }
}

// pi.getSessionName() is a live read and a session can be unnamed, so this must
// never be the reason a report is lost.
function safeSessionName(pi: ExtensionAPI): string | null {
  try {
    return pi.getSessionName?.() || null;
  } catch {
    return null;
  }
}

export default function murmurPi(pi: ExtensionAPI): void {
  const observedStartLocation = tmux.currentWindow();
  if (!observedStartLocation) return;
  const startLocation: Location = {
    ...observedStartLocation,
    server: observedStartLocation.server ?? { kind: "default" },
  };

  /**
   * Where this agent is NOW, not where it started.
   *
   * `move-pane` and `break-pane` keep the pane id while the window id changes,
   * so resolving the window once at startup meant a moved agent painted its
   * badge on the window it used to live in and recorded a stale location on
   * every later write.
   *
   * The pane is the address and does not change, so only the location is
   * re-read. Falls back to the startup location when tmux cannot answer, so a
   * transient failure does not rewrite an agent's address to nothing.
   */
  let lastLocation = startLocation;
  const here = (): Location => {
    const observed = tmux.currentWindow();
    const location: Location = observed
      ? { ...observed, server: observed.server ?? startLocation.server }
      : startLocation;
    // A move leaves a badge on the old window, which nothing else will ever
    // clear: the badge belongs to the window, and this is the only process that
    // knows the agent left.
    if (
      location.window !== lastLocation.window ||
      location.server.kind !== lastLocation.server.kind ||
      ("value" in location.server &&
        "value" in lastLocation.server &&
        location.server.value !== lastLocation.server.value)
    ) {
      try {
        tmux.setWindowState(lastLocation.window, null, lastLocation.server);
      } catch {
        // Best effort; the new window's badge matters more than the old one's.
      }
      lastLocation = location;
    }
    return location;
  };

  const meta = (): AgentMeta => ({
    // mu names its agents; pi names its sessions. Both beat a window name when
    // present, and neither can be recovered from tmux.
    agent_name: process.env.MU_AGENT_NAME ?? null,
    pi_session: safeSessionName(pi),
    workstream: process.env.MU_WORKSTREAM ?? null,
    role: process.env.MU_ROLE ?? null,
    cli: "pi",
    driver,
  });

  /**
   * One variable, three named states, so the combinations that must not exist
   * cannot be written down.
   *
   * This was `Store | null | undefined` plus a separate `absent` boolean -- six
   * combinations for three meanings -- and conflating two of them silenced the
   * extension for the life of the process: `null` meant both "murmur is not
   * installed, stop trying" and "a write failed, drop the handle", so one
   * transient failure latched reporting off while the badge still painted.
   *
   * Only `absent` is permanent, from a failed import, a missing identity or a
   * REFUSED claim. A dropped handle returns to `untried` and the next event
   * reopens.
   */
  type StoreState = { kind: "untried" } | { kind: "open"; store: Store } | { kind: "absent" };
  let state: StoreState = { kind: "untried" };
  /**
   * This process is nested, permanently and unrecoverably.
   *
   * Separate from `absent`, which `session_start` re-arms: a missing murmur or
   * identity is fixable from outside a running pi, but a second live process in
   * one pane never becomes the owner. Re-arming it would let a nested pi report
   * as the parent agent after the first /reload.
   */
  let refused = false;
  /** This process's agent row, for the life of the process. */
  let agentId: string | null = null;
  /**
   * The last completed turn's assistant message, waiting to be written.
   *
   * Held, not written, at `message_end`: pi dispatches that event BEFORE it
   * persists the message, so the context read there would still describe the
   * previous turn. It is written at the next `turn_start` or at `agent_end`,
   * both of which follow persistence of the whole turn, tool results included.
   */
  let pendingTurn: RuntimeMessage | null = null;
  /** The last assistant message's failure, if it failed. Read at settle. */
  let lastError: string | null = null;
  /** Outstanding background work per source, from `murmur:pending`. */
  const pendingWork = new Map<string, number>();
  let pendingTotal = 0;
  let queue: Promise<void> = Promise.resolve();

  const enqueue = (work: () => Promise<void>): Promise<void> => {
    queue = queue.then(work, work);
    return queue;
  };

  const dropStore = (): void => {
    if (state.kind === "open") {
      try {
        state.store.close();
      } catch {
        // Best effort: extension failures must never reach pi.
      }
    }
    state = { kind: "untried" };
  };

  /**
   * Open the store and claim the pane, in that order, once.
   *
   * `refused` is the nested-agent case and is permanent for this process: a pi
   * launched inside an agent's pane inherits $TMUX_PANE and would report AS the
   * parent agent. Six pids once wrote to one pane that way, and the parent read
   * as idle while it was working. The claim's liveness probe answers this from
   * the database rather than an environment marker an oddly-launched process
   * could drop.
   */
  const getStore = async (): Promise<Store | null> => {
    // Permanent: no murmur, no identity, or nested. None becomes false later in
    // the same process, so retrying would pay a failed dynamic import per turn
    // forever. `session_start` re-arms it, since the first two are fixable from
    // outside a running pi.
    if (state.kind === "absent") return null;
    if (refused) return null;
    if (state.kind === "open") return state.store;
    try {
      const { loadIdentity, openStore } = (await import(storeModule)) as StoreModule;
      // Read, never minted: loading an extension must not create a node.
      if (!loadIdentity()) {
        state = { kind: "absent" };
        return null;
      }
      const store = openStore();
      const claim = store.claimAgent({
        location: here(),
        owner_pid: process.pid,
        meta: meta(),
      });
      if (claim.outcome === "refused") {
        store.close();
        refused = true;
        state = { kind: "absent" };
        return null;
      }
      // `retained` makes /reload a no-op: pi re-runs this factory in the same
      // process, and the store recognises our own pid.
      agentId = claim.agent_id;
      state = { kind: "open", store };
      return store;
    } catch {
      state = { kind: "absent" };
      return null;
    }
  };

  /**
   * Report activity, and answer whether this process is still the owner.
   *
   * `setActivity` returning false is not an error and is not retried: it means
   * this process is no longer the owner of record, and silence is correct.
   *
   * The badge is gated on that boolean, because the badge is the only part of a
   * report a human sees directly -- painting it before the write is how a
   * silently non-reporting extension looks healthy for a whole process.
   */
  const report = async (activity: Activity, location: Location): Promise<boolean> => {
    try {
      const store = await getStore();
      if (!store || !agentId) return false;
      return store.setActivity({ agent_id: agentId, owner_pid: process.pid, activity, location });
    } catch {
      dropStore();
      return false;
    }
  };

  /**
   * Send a runtime report, if there is anything to send and we own the pane.
   *
   * Silent on every failure, like `report`: an extension fault must never reach
   * pi, and a runtime field is the least important thing murmur carries. An
   * empty patch is skipped before the store is even opened -- an older pi offers
   * none of these members, and that must not cost a dynamic import per turn.
   */
  const reportRuntime = async (patch: Partial<AgentRuntime>): Promise<void> => {
    if (Object.keys(patch).length === 0) return;
    try {
      const store = await getStore();
      if (!store || !agentId) return;
      // Same owner gate as `report`, enforced inside the store: a nested pi that
      // inherited $TMUX_PANE gets `false` and writes nothing.
      store.setRuntime({ agent_id: agentId, owner_pid: process.pid, ...patch });
    } catch {
      dropStore();
    }
  };

  /**
   * Claim the pane NOW, not on the first event.
   *
   * A nested process must paint no badge, and the same handler that reports also
   * paints -- so ownership must be settled before any handler runs.
   *
   * ONE VISIBLE DEVIATION FROM THE CONTRACT: §9.1 says a refused process
   * registers no handlers, and it cannot, quite. The store arrives through a
   * dynamic `import()` of a runtime-pinned path, so the claim is asynchronous
   * while pi's extension factory is not -- handlers must be attached before the
   * first `await` resolves or the extension misses events it does own.
   *
   * Observable behaviour is identical, which is what the contract is about: the
   * claim rides the queue that already serialises every handler, so each runs
   * after it, and a refused process writes nothing, paints nothing and holds no
   * handle. `refused` is checked in both places that could act.
   *
   * Publish after the claim, too. Otherwise the tmux options wait for the first
   * agent event, and an idle agent, such as a mu worker not yet sent work, has
   * no label or window marker for as long as it waits.
   */
  const claimAndPublish = async (): Promise<void> => {
    if (await getStore()) publish(here());
  };

  /** Publish stored state only if we own the pane. A nested agent is invisible. */
  const publish = (location: Location): void => {
    if (refused || state.kind !== "open") return;
    try {
      publishAgentStates(location.window, tmux, state.store, location.server);
    } catch {
      // Presentation is best effort; a tmux or store failure must never reach pi.
    }
  };

  void enqueue(claimAndPublish);

  /** Retract a state this process may have painted when it cannot publish truth. */
  const retract = (location: Location): void => {
    if (refused) return;
    try {
      tmux.setPaneState(location.pane, null, location.server);
      tmux.setPaneLabel(location.pane, null, location.server);
      tmux.setWindowState(location.window, null, location.server);
    } catch {
      // Best effort, as with publish.
    }
  };

  pi.on("agent_start", (_event, ctx) => {
    void enqueue(async () => {
      const location = here();
      // Ownership first, glyph second. A process whose pane was taken over while
      // its handle was dropped learns that from the claim inside `report`, and a
      // badge painted before it would announce an agent that has moved on.
      if (await report("running", location)) publish(location);
      // Then what it is running with. Here as well as on the change events,
      // because a RESUMED session may never emit a model_select or end a turn --
      // it would sit on the dash reporting no model for its whole life.
      await reportRuntime(runtimeFromContext(ctx));
    });
  });

  // One event per field that can change, and no timer anywhere.
  //
  //   model_select          the only thing that changes the model
  //   thinking_level_select the only thing that changes the requested effort
  //   a completed turn      the only thing that moves the context, the token
  //                         counts or the cost
  //
  // A periodic poll would have put a SQLite write in every pi process forever
  // for numbers that cannot change between turns. These fire exactly as often
  // as the facts move.
  pi.on("model_select", (_event, ctx) => {
    void enqueue(() => reportRuntime(runtimeFromContext(ctx)));
  });

  pi.on("thinking_level_select", (_event, ctx) => {
    void enqueue(() => reportRuntime(runtimeFromContext(ctx)));
  });

  // A completed turn is reported in two halves, because pi offers no single
  // event that is both boundary-free and after persistence (see the ExtensionAPI
  // note on `turn_end`). `message_end` captures the usage; the next point that
  // follows persistence writes it together with the context, in ONE write, so a
  // reader never sees this turn's cost beside last turn's context.
  pi.on("message_end", (event) => {
    const message = event?.message;
    if (message?.role === "assistant") lastError = turnError(message);
    if (isReportableTurn(message)) pendingTurn = message ?? null;
  });

  // Read NOW, at the event, and write later. Handlers return at once while the
  // queue may lag behind a slow store open; read inside the queued work, the
  // context could belong to a later turn, and the next message_end could
  // replace `pendingTurn` before it is written.
  const takeTurn = (ctx: RuntimeContext | undefined): Partial<AgentRuntime> => {
    const patch = { ...runtimeFromContext(ctx), ...usageFromMessage(pendingTurn ?? undefined) };
    pendingTurn = null;
    return patch;
  };

  // Every turn after the first starts once the previous one is persisted. The
  // first has nothing pending, and agent_start has already reported.
  pi.on("turn_start", (_event, ctx) => {
    if (!pendingTurn) return;
    const patch = takeTurn(ctx);
    void enqueue(() => reportRuntime(patch));
  });

  pi.on("agent_end", (_event, ctx) => {
    // The run's last turn has no following turn_start. Context is written even
    // with no usage pending: an aborted last turn or a compaction still moved it.
    const patch = takeTurn(ctx);
    void enqueue(async () => {
      await reportRuntime(patch);
      const location = here();
      // Clearing is safe whatever the answer -- it retracts this process's own
      // glyph and can only ever say less -- but it is still ordered after the
      // write so that both halves read the same ownership answer.
      if (await report("stopped", location)) publish(location);
      else retract(location);
    });
  });

  // The event that produces `done`. agent_end alone cannot express it: agent_end
  // fires when a run's loop ends, which is not the same as "nothing more will
  // happen" -- pi re-enters the loop for a retry, a compaction, or a queued
  // message, and each re-entry emits its own start/end pair. Only
  // `agent_settled` means finished and waiting. See the table in decide.ts.
  pi.on("agent_settled", () => {
    // Read at the event: a delegate answering while the queue lags must not
    // turn this settle -- the one that ended to WAIT for it -- into a `done`.
    const pending = pendingTotal;
    const error = lastError;
    lastError = null;
    void enqueue(async () => {
      const location = here();
      const settled = settledState(focused(location.pane), muManaged, pending, error !== null);
      if (settled === null) return;
      try {
        const store = await getStore();
        if (!store || refused) return;
        // Attention is pane-addressed, and this call structurally cannot name an
        // agent, pid or activity. `blocked` is never authored by an owner.
        store.requestAttention({
          kind: settled,
          location,
          message: settled === "error" ? (error ?? "") : "",
          source: "pi",
        });
        publishAgentStates(location.window, tmux, store, location.server);
      } catch {
        dropStore();
      }
    });
  });

  // Background work another extension started (mu delegates). Reported as a
  // runtime field so every surface can show it, and republished because it
  // moves the pane between `idle` and `waiting`. Read at the event, written in
  // the queue, like the turn reports.
  pi.events.on(PENDING_CHANNEL, (data) => {
    const total = foldPending(pendingWork, data);
    if (total === null || total === pendingTotal) return;
    pendingTotal = total;
    void enqueue(async () => {
      await reportRuntime({ pending: total });
      publish(here());
    });
  });

  // `session_shutdown` does not mean the process is exiting: pi fires it for
  // `/reload`, session switch, resume and fork, then rebinds and keeps going --
  // its docs say clean up here and reestablish in `session_start`. Treating it
  // as terminal killed reporting permanently on the first `/reload`.
  //
  // Releasing deletes the agent row but NOT its attention: a `done` raised at
  // settle must survive the process quitting, or completion becomes invisible
  // the moment the agent exits.
  pi.on("session_shutdown", async () => {
    await enqueue(async () => {
      const location = here();
      try {
        if (state.kind === "open" && agentId) {
          state.store.releaseAgent({ agent_id: agentId, owner_pid: process.pid, location });
          publish(location);
        } else {
          retract(location);
        }
      } catch {
        // The handle goes either way.
        retract(location);
      }
      agentId = null;
      pendingTurn = null;
      lastError = null;
      // The producers' watchers die with the runtime too; a re-claim starts at
      // nothing outstanding.
      pendingWork.clear();
      pendingTotal = 0;
      dropStore();
    });
  });

  // Reestablish, per pi's contract. A reload leaves this instance live with its
  // store dropped and its cached location possibly wrong, since the pane can
  // move while the session is being switched.
  pi.on("session_start", () => {
    void enqueue(async () => {
      if (state.kind === "absent") state = { kind: "untried" };
      const location = here();
      lastLocation = location;
      // Re-claim NOW, not on the next agent event. `session_shutdown` released
      // the row, so until this runs the pane has no owner and `claimAgent` would
      // refuse nobody. Waiting for an agent event -- minutes away, or never,
      // since /reload happens while idle -- lets a pi started meanwhile claim the
      // pane legitimately, leaving this process refused permanently: silent for
      // life while its badge still paints. pi fires session_start immediately
      // after shutdown, bounding the unowned window to two handler calls.
      // Publishing repaints what session_shutdown's publish removed.
      await claimAndPublish();
    });
  });
}
