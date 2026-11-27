import type { PaneId, SessionId, WindowId } from "./ids.js";

/**
 * The three independent facts, as types.
 *
 * `activity` is what the pane's program says it is doing. `attention` is
 * whether a human is wanted. `freshness` (src/view.ts) is how recently we
 * reached the node that reported. They are three independent fields, never one
 * enum, and absence carries meaning: no attention row means "nothing to see",
 * no agent row means "no agent here".
 *
 * From 3.0 a local pane's facts come from its multiplexer: the program reports
 * them over OSC 7501 (Program Status) and vtmux or Rex keeps the record. murmur
 * reads that record once per collect (src/local.ts) and keeps only what the
 * multiplexer cannot: a pane that vanished mid-work (`crashed`) and which
 * transitions have already been alerted.
 */
export type Activity = "running" | "stopped";
export type AttentionKind = "done" | "blocked" | "error" | "crashed";

/**
 * Attention kinds, most urgent first. Beside the type they order.
 *
 * Typed as `AttentionKind` rather than reusing `RENDER_PRIORITY`, which is a
 * list of seven `RenderState`s of which these are four. The two tables must
 * not disagree about relative order; a test asserts this is an
 * order-consistent subset of `RENDER_PRIORITY`.
 */
export const ATTENTION_PRIORITY: readonly AttentionKind[] = ["crashed", "error", "blocked", "done"];

/**
 * What a blocked program is waiting for, as OSC 7501 names it: a tool
 * permission, an answer, or a credential. Null when the program did not say.
 */
export const BLOCKED_KINDS = ["permission", "question", "auth"] as const;
export type BlockedKind = (typeof BLOCKED_KINDS)[number];

/**
 * The OSC 7501 record id mu's pi extension reports outstanding delegates
 * under: a `working` summary from it is an agent waiting, not working.
 */
export const DELEGATES_RECORD = "mu/delegates";

/**
 * The OSC 7501 record id mu's pi extension reports a Rex pane's crew role
 * under (tmux has the `@mu_role` pane option instead): `idle`, its `title`
 * `orchestrator`, `worker` or `delegate` (mu's `actor_role`). Identity, not state: never the pane's summary.
 */
export const ROLE_RECORD = "mu/role";

/**
 * The OSC 7501 `app` `murmur rex-feed` reports as. A pane carrying it is
 * murmur's own echo of the fleet, never an agent, so collectors skip it.
 */
export const FEED_APP = "murmur";

/** Agent harnesses murmur lists as `idle` before they emit any OSC 7501. */
const KNOWN_HARNESSES: ReadonlySet<string> = new Set(["pi", "claude", "codex"]);

/** The known harness a program name or path names (`pi`, `/x/claude.real`), else null. */
export function harnessName(cli: string | null | undefined): string | null {
  if (!cli) return null;
  const name = (cli.split("/").pop() ?? "").replace(/\.real$/, "");
  return KNOWN_HARNESSES.has(name) ? name : null;
}

/** Whether a pane's foreground program (`cli`) is a known agent harness. */
export function isHarnessCli(cli: string | null | undefined): boolean {
  return harnessName(cli) !== null;
}

/**
 * Who is waiting on this agent -- a human, or a supervisor that consumes the
 * result. Not "which harness"; that is `harness`.
 *
 * mu marks the panes it places with the `@mu_agent` pane option, which is what
 * makes a pane `orchestrated`.
 */
export type Driver = "human" | "orchestrated";

export const DEFAULT_DRIVER: Driver = "human";

/**
 * Where a pane lives: a tmux (vtmux) server, or the local Rex server.
 *
 * Rex has one server per user, so its tag carries no value. Its pane ids are
 * Rex block ids (`block:<uuid>`), its sessions and windows Rex's own ids.
 */
export type TmuxServer =
  | { kind: "default" }
  | { kind: "label"; value: string }
  | { kind: "path"; value: string }
  | { kind: "rex" };

export const DEFAULT_TMUX_SERVER: TmuxServer = { kind: "default" };

/** A tmux server, as opposed to Rex: every server a tmux argv can name. */
export type TmuxSocket = Exclude<TmuxServer, { kind: "rex" }>;

/** Whether `server` is a tmux server (`-L`/`-S`/default), not Rex. */
export function isTmuxSocket(server: TmuxServer): server is TmuxSocket {
  return server.kind !== "rex";
}

/** The server's value, or "" for the two kinds that carry none. */
export function serverValue(server: TmuxServer): string {
  return "value" in server ? server.value : "";
}

/** One key per server, for maps and sets. */
export function serverKey(server: TmuxServer): string {
  return `${server.kind}\0${serverValue(server)}`;
}

/** One key per pane address: a pane id is unique only per server. */
export function paneKey(address: { server: TmuxServer; pane: string }): string {
  return `${serverKey(address.server)}\0${address.pane}`;
}

/**
 * A pane's address. Location, never identity.
 *
 * `pane` is stable for the life of the pane; `session` and `window` are only
 * where that pane currently is, and both change under move-pane and break-pane.
 */
export type PaneIdentity = {
  server: TmuxServer;
  pane: PaneId;
};

export type Location = PaneIdentity & {
  session: SessionId;
  window: WindowId;
  session_name: string | null;
  window_name: string | null;
};

export type PeerRecord = {
  name: string;
  target: string;
  /** Opaque command template for interactive access; `{attach}` or `{pane}` is substituted. */
  jump_command: string;
  host_id: string | null;
  display_name: string | null;
  /** The whole validated document, or null when we have never parsed one. */
  snapshot: Snapshot | null;
  /** The PEER's clock: when that node built the document. */
  snapshot_at: number | null;
  /** OUR clock: when we last reached it. Freshness is computed from this. */
  fetched_at: number | null;
  last_attempt_at: number | null;
  last_error: string | null;
  murmur_version: string | null;
  /** The peer's `murmur_snapshot` value, i.e. the document version it speaks. */
  snapshot_version: number | null;
  /**
   * The `rex -S` label (a `rex hosts` name or address) reaching this peer's Rex
   * server, set by hand on THIS node. Never on the wire: a peer's Rex panes stay
   * `{ kind: "rex" }`, and only the viewer knows how its own Rex reaches them.
   */
  rex_host: string | null;
};

/**
 * The snapshot document version this node speaks, and the ONE place the
 * number lives. 8 is murmur 3.0: panes read from OSC 7501 and 7577 rather
 * than reported by harness hooks.
 */
export const SNAPSHOT_VERSION = 8;

/**
 * One node's whole current state. Complete, never a delta: a peer that returns
 * one has said everything it knows, so absence from it is absence.
 */
export type Snapshot = {
  murmur_snapshot: typeof SNAPSHOT_VERSION;
  host_id: string;
  display_name: string;
  murmur_version: string;
  generated_at: number;
  panes: SnapshotPane[];
};

export type SnapshotPane = Location & {
  /** Null for an attention-only pane (a crash murmur recorded): valid, listable. */
  agent: SnapshotAgent | null;
  attention: SnapshotAttention[];
};

/**
 * A local pane as one collect read it: the snapshot row, plus whether the
 * operator is looking at it right now. `focused` is local only and never
 * reaches the wire: a remote node's focus says nothing about this operator.
 */
export type LocalPane = SnapshotPane & {
  focused: boolean;
  /**
   * The host a mu remote worker runs on, from the `@mu_host` option mu sets
   * on its local pane (which holds the ssh session). Local only, like focus.
   */
  runs_on: string | null;
};

/**
 * The program in a pane, as its multiplexer reports it.
 *
 * Every field after `driver` is the program's own word (OSC 7501's `app`,
 * `title`, `msg`, `progress`, `kind`; OSC 7577's resume record), never
 * inferred by murmur.
 */
export type SnapshotAgent = {
  activity: Activity;
  /** mu's `@mu_agent`, `@mu_workstream` and `@mu_role` pane options. */
  agent_name: string | null;
  workstream: string | null;
  role: string | null;
  driver: Driver;
  /** The pane's foreground command, as the multiplexer names it. */
  cli: string | null;
  /** The reporting program's name (OSC 7501 `app`): `pi`, `claude`, `codex`. */
  harness: string | null;
  /** The pane's title (OSC 0/2), a display-name fallback. */
  pane_title: string | null;
  /** OSC 7501 `title`: a short label for what the program is doing. */
  title: string | null;
  /** OSC 7501 `msg`: one line describing the status. */
  message: string | null;
  /** OSC 7501 `progress`, 0..100, for a working or blocked program. */
  progress: number | null;
  /** What a blocked program waits for; null otherwise or when unsaid. */
  blocked_kind: BlockedKind | null;
  /**
   * Background work the agent is waiting on (mu delegates, reported as the
   * `mu/delegates` OSC 7501 sub-record). Null when nothing reports it.
   */
  pending: number | null;
  /** OSC 7577: how to relaunch the program, and where. Null without a record. */
  resume_command: string | null;
  resume_cwd: string | null;
  /** The pane's current directory. */
  cwd: string | null;
  /** When the program's state last changed, on the owning node's clock. */
  updated_at: number;
};

export type SnapshotAttention = {
  kind: AttentionKind;
  message: string;
  source: string;
  /** Who is waiting on the pane, as its node saw it. */
  driver: Driver;
  requested_at: number;
};

export type PeerFetch =
  | { ok: true; snapshot: Snapshot; at: number }
  | { ok: false; error: string; at: number };

/**
 * One word for a pane, as surfaces paint it. Defined here, beside the facts it
 * is derived from, so the store can remember it; `view.ts` re-exports it as
 * `RenderState`.
 */
export type PaneState = "crashed" | "error" | "blocked" | "done" | "running" | "waiting" | "idle";

/**
 * One live pane as a collect saw it, before murmur adds what only it knows
 * (since when, and any crash it recorded). The identity fields are kept so a
 * pane that vanishes mid-work can still be named in its `crashed` row.
 */
export type SeenPane = Location & {
  state: PaneState;
  /** The multiplexer's own state-change time, when it reports one. */
  state_time: number | null;
  agent_name: string | null;
  workstream: string | null;
  role: string | null;
  driver: Driver;
  harness: string | null;
  cli: string | null;
  pane_title: string | null;
};

/**
 * What one collect saw on one server: its panes, or null when the server could
 * not be asked. Null is not evidence that the panes are gone, so it never
 * synthesises a crash.
 */
export type ServerRead = {
  server: TmuxServer;
  panes: SeenPane[] | null;
  /**
   * Every pane id the server holds, listed or not. A listed pane that drops
   * out of `panes` but is still here cleared its status; only one missing
   * from this set vanished. Absent, `panes` is taken as the whole server.
   */
  live?: ReadonlySet<string>;
};

/** What `Store.syncLocal` concluded from one collect. */
export type LocalSync = {
  /** Panes that vanished mid-work and now carry a `crashed` row. */
  crashed: PaneId[];
  /** When each live pane entered its current state, by `paneKey`. */
  since: Map<string, number>;
};
