import { type Harness, isHarness } from "./harnesses.js";
import { type HookPayload, mapHookPayload } from "./hook-rows.js";
import {
  capLastText,
  INBOX_EVENT_VERSION,
  INBOX_EVENTS,
  type InboxAgent,
  type InboxEvent,
  type InboxEventName,
  parseAgent,
} from "./inbox-event.js";
import {
  type AgentAnchor,
  type AnchorLookup,
  type ProcessTable,
  paneHarness,
  paneProgram,
  placeEvent,
} from "./process-chain.js";
import { driverFromEnv } from "./types.js";

/**
 * `murmur hook <harness>` and `murmur hook mu`, short of the I/O: one payload
 * in, one inbox event (or nothing) out.
 *
 * Pure over the process table, the environment and an anchor lookup, so the
 * recorded harness payloads and process chains drive every rule in a test.
 * The CLI (`src/cli/hook.ts`) reads stdin and `ps`, and writes the file.
 */

export type HookContext = {
  table: ProcessTable;
  /** The hook's own pid: where the walk to the tmux server starts. */
  self: number;
  env: NodeJS.ProcessEnv;
  anchor?: AnchorLookup;
  /** When the hook ran, in milliseconds since the epoch. */
  now: number;
};

/**
 * Who the agent is: mu's anchor when an ancestor has one, else the variables mu
 * sets on what it starts. A harness may clear its hooks' environment, so the
 * anchor comes first; an agent with neither is the human's own.
 */
export function hookAgent(anchor: AgentAnchor | null, env: NodeJS.ProcessEnv): InboxAgent {
  if (anchor) {
    return {
      agent_name: anchor.agent_name,
      workstream: anchor.workstream,
      role: anchor.role,
      cli: anchor.cli,
      // mu wrote the anchor, so mu started the agent: crew, as `driverFromEnv`
      // reads `MU_MANAGED_AGENT` for pi.
      driver: "orchestrated",
    };
  }
  const value = (name: string | undefined): string | null => (name ? name : null);
  return {
    agent_name: value(env.MU_AGENT_NAME),
    workstream: value(env.MU_WORKSTREAM),
    role: value(env.MU_ROLE),
    cli: value(env.MU_AGENT_CLI),
    driver: driverFromEnv(env),
  };
}

type EventFields = Pick<
  InboxEvent,
  "event" | "session_id" | "source" | "reason" | "message" | "text" | "generation_id"
>;

type Where = Pick<
  InboxEvent,
  "harness" | "server_pid" | "root_pid" | "owner_pid" | "tmux" | "tmux_pane"
>;

function inboxEvent(
  fields: EventFields,
  where: Where,
  by: InboxEvent["by"],
  agent: InboxAgent,
  now: number,
): InboxEvent {
  return { v: INBOX_EVENT_VERSION, ...fields, ...where, at: now, by, agent };
}

/**
 * The event a harness's hook payload means, placed in its pane, or null to
 * write nothing.
 *
 * In order: the harness's row maps the payload (and applies its drop rules);
 * the process chain places it. Nothing is written for a nested agent, a chain
 * that never reaches a tmux server, or a chain whose harness is not the one the
 * hook was configured for: a `murmur hook claude` line that runs under codex
 * is a misconfiguration, and codex's own row decides what its payloads mean.
 *
 * A remote-keyed agent's events belong to its origin node and go to a separate
 * area, which this build does not write yet: nothing is written for one.
 */
export function harnessHookEvent(
  harness: Harness,
  payload: HookPayload,
  context: HookContext,
): InboxEvent | null {
  const mapped = mapHookPayload(harness, payload);
  if (!mapped) return null;
  const placement = placeEvent(context.table, context.self, {
    tmuxEnv: context.env.TMUX,
    ...(context.anchor ? { anchor: context.anchor } : {}),
  });
  if (placement.kind !== "local" || placement.harness !== harness) return null;
  return inboxEvent(
    mapped,
    {
      harness,
      server_pid: placement.server_pid,
      root_pid: placement.root_pid,
      owner_pid: placement.owner_pid,
      tmux: context.env.TMUX ?? null,
      tmux_pane: context.env.TMUX_PANE ?? null,
    },
    "harness",
    hookAgent(placement.anchor, context.env),
    context.now,
  );
}

/**
 * What mu sends `murmur hook mu`: one event of the vocabulary, already decided.
 * mu writes `continued` when its stop hook keeps a turn going, `interrupted`
 * when it sends a pane Escape, and whatever it read from a remote worker.
 */
export type MuHookInput = EventFields & {
  /** The harness, for a pane whose agent does not run locally (an ssh pane). */
  harness: Harness | null;
  /**
   * Who the pane's agent is, as mu knows it, for a pane where no anchor says:
   * a remote worker's, or a local agent whose identity is only in its own
   * environment. The store fixes a row's identity when it claims the pane.
   */
  agent: InboxAgent | null;
};

function optionalText(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : undefined;
}

/** mu's payload, validated, or the reason it is refused. */
export function parseMuHookInput(payload: HookPayload): MuHookInput | string {
  const event = payload.event;
  if (typeof event !== "string" || !(INBOX_EVENTS as readonly string[]).includes(event)) {
    return `unknown event: ${typeof event === "string" ? event : JSON.stringify(event ?? null)}`;
  }
  const harness = payload.harness ?? null;
  if (harness !== null && !isHarness(harness)) return `unknown harness: ${String(harness)}`;
  let agent: InboxAgent | null = null;
  if (payload.agent !== undefined && payload.agent !== null) {
    agent = parseAgent(payload.agent);
    if (!agent)
      return "agent: agent_name, workstream, role and cli must be strings, driver human or orchestrated";
  }
  const fields = {
    session_id: optionalText(payload.session_id),
    source: optionalText(payload.source),
    reason: optionalText(payload.reason),
    message: optionalText(payload.message),
    text: optionalText(payload.text),
    generation_id: optionalText(payload.generation_id),
  };
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) return `${name} must be a string`;
  }
  const text = fields.text ?? null;
  return {
    event: event as InboxEventName,
    harness,
    session_id: fields.session_id ?? null,
    source: fields.source ?? null,
    reason: fields.reason ?? null,
    message: fields.message ?? null,
    text: text === null ? null : capLastText(text),
    generation_id: fields.generation_id ?? null,
    agent,
  };
}

/** A pane named outright, as tmux reported it. */
export type MuHookTarget = {
  server_pid: number;
  root_pid: number;
  /** `$TMUX`'s shape (`socket,pid,session`), so the drain finds the server. */
  tmux: string;
  tmux_pane: string;
};

/**
 * The event mu asked for, placed, or the reason it cannot be.
 *
 * Without a target, the event is about the pane mu runs in, placed by the same
 * process-chain walk a harness hook takes: `mu hook stop` runs as the
 * harness's own Stop hook, so its `continued` lands on that harness's pane,
 * with that harness's owner pid.
 *
 * With a target (`--pane`), the pane's own harness is found from its root
 * downward (`paneHarness`), which yields the owner pid the pane's hooks record,
 * so the event passes the store's owner gate. A pane with no local harness (an
 * ssh pane whose worker runs remotely) takes the harness mu names, and as its
 * owner the program the pane runs (`paneProgram`: the ssh, not the login shell
 * under it), so the claim dies with the session and a harness started in the
 * pane afterwards can claim it. A pane that holds only shells is refused: its
 * shell would own the pane for as long as it lives. A named harness that
 * contradicts the pane's own is refused rather than guessed at.
 *
 * The agent is the anchor's when one is found, else the one mu names, else
 * (in mu's own pane) mu's variables.
 */
export function muHookEvent(
  input: MuHookInput,
  context: HookContext,
  target: MuHookTarget | null = null,
): InboxEvent | string {
  const { harness: named, agent: given, ...fields } = input;
  if (!target) {
    const placement = placeEvent(context.table, context.self, {
      tmuxEnv: context.env.TMUX,
      ...(context.anchor ? { anchor: context.anchor } : {}),
    });
    if (placement.kind === "remote") return "a remote agent's pane is on its origin node";
    if (placement.kind === "drop") return `not inside a harness's tmux pane (${placement.reason})`;
    if (named !== null && named !== placement.harness) {
      return `this pane runs ${placement.harness}, not ${named}`;
    }
    return inboxEvent(
      fields,
      {
        harness: placement.harness,
        server_pid: placement.server_pid,
        root_pid: placement.root_pid,
        owner_pid: placement.owner_pid,
        tmux: context.env.TMUX ?? null,
        tmux_pane: context.env.TMUX_PANE ?? null,
      },
      "mu",
      placement.anchor || !given ? hookAgent(placement.anchor, context.env) : given,
      context.now,
    );
  }

  const found = paneHarness(context.table, target.root_pid);
  if (found && named !== null && named !== found.harness) {
    return `pane ${target.tmux_pane} runs ${found.harness}, not ${named}`;
  }
  const harness = found?.harness ?? named;
  if (!harness) return `no harness runs in pane ${target.tmux_pane}; name one with "harness"`;
  const owner = found?.pid ?? paneProgram(context.table, target.root_pid);
  if (owner === null) {
    return `pane ${target.tmux_pane} runs neither a harness nor a remote session, only a shell`;
  }
  // The pane's agent, not mu's own: from the anchor mu wrote for it, else as mu
  // names it. mu's own environment says nothing about another pane.
  const anchor = found ? anchorAbove(context, found.pid, target.root_pid) : null;
  return inboxEvent(
    fields,
    {
      harness,
      server_pid: target.server_pid,
      root_pid: target.root_pid,
      owner_pid: owner,
      tmux: target.tmux,
      tmux_pane: target.tmux_pane,
    },
    "mu",
    anchor || !given ? hookAgent(anchor, {}) : given,
    context.now,
  );
}

/** The first anchor from `pid` up to `root`, inclusive. */
function anchorAbove(context: HookContext, pid: number, root: number): AgentAnchor | null {
  if (!context.anchor) return null;
  let current = context.table.get(pid);
  for (let depth = 0; depth < 64 && current; depth += 1) {
    const anchor = context.anchor(current);
    if (anchor) return anchor;
    if (current.pid === root || current.ppid === current.pid) break;
    current = context.table.get(current.ppid);
  }
  return null;
}
