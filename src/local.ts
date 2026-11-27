/**
 * The local collector: this node's panes, read from the multiplexer.
 *
 * Every program in a pane reports its own state over OSC 7501 (Program
 * Status) and how to relaunch it over OSC 7577 (Program Resume); vtmux keeps
 * both records per pane and exposes them as `#{pane_program_*}` and
 * `#{pane_resume_*}` formats, and mu marks the panes it places with
 * `@mu_agent`, `@mu_workstream` and `@mu_role`. So one `list-panes -a -F` per
 * tmux server is the whole read: no hooks, no inbox, no process walk.
 *
 * What the multiplexer cannot remember, the store does (`Store.syncLocal`):
 * since when a pane has held its state, and which panes vanished while
 * working or blocked (a crash of a pane nobody retained).
 *
 * Specs: https://www.superlogical.com/rex/docs/build/program-status and
 * https://www.superlogical.com/rex/docs/build/program-resume
 */
import { hostname } from "node:os";
import type { NodeIdentity } from "./identity.js";
import { asPaneId, asSessionId, asWindowId } from "./ids.js";
import type { Mux } from "./mux.js";
import { type RexRead, readRex } from "./rex.js";
import type { Store } from "./store.js";
import { tmuxText } from "./tmux-format.js";
import {
  type AttentionKind,
  BLOCKED_KINDS,
  type BlockedKind,
  DELEGATES_RECORD,
  type Driver,
  FEED_APP,
  isHarnessCli,
  type LocalPane,
  type PaneState,
  paneKey,
  type SeenPane,
  type ServerRead,
  SNAPSHOT_VERSION,
  type Snapshot,
  type SnapshotAgent,
  type SnapshotPane,
  serverKey,
  type TmuxServer,
  type TmuxSocket,
} from "./types.js";
import { MURMUR_VERSION } from "./version.js";

/** The `@mu_*` option mu sets on a remote worker's local pane: the host it runs on. */
export const MU_HOST_OPTION = "@mu_host";

/**
 * The single-pass format, one field per entry. Free text goes through
 * `tmuxText` so a `|` in a title cannot split the row.
 */
export const PANE_FIELDS = [
  "#{pane_id}",
  "#{session_id}",
  "#{window_id}",
  tmuxText("session_name"),
  tmuxText("window_name"),
  "#{?automatic-rename,1,0}",
  "#{pane_pid}",
  "#{pane_dead}",
  "#{pane_dead_status}",
  tmuxText("pane_current_command"),
  tmuxText("pane_current_path"),
  tmuxText("pane_title"),
  "#{&&:#{pane_active},#{&&:#{window_active},#{session_attached}}}",
  // OSC 7501
  "#{pane_program_state}",
  "#{pane_program_kind}",
  "#{pane_program_progress}",
  tmuxText("pane_program_app"),
  tmuxText("pane_program_title"),
  tmuxText("pane_program_message"),
  tmuxText("pane_program_id"),
  "#{pane_program_state_time}",
  // OSC 7577
  tmuxText("pane_resume_command"),
  tmuxText("pane_resume_cwd"),
  // mu's crew identity, set at spawn
  tmuxText("@mu_agent"),
  tmuxText("@mu_workstream"),
  tmuxText("@mu_role"),
  tmuxText(MU_HOST_OPTION),
] as const;

/** The pill's state words, in tmux's vocabulary, as `@murmur_count_<word>` names them. */
export const PILL_WORDS = [
  "crashed",
  "error",
  "blocked",
  "done",
  "working",
  "waiting",
  "idle",
  "crew",
] as const;

/**
 * The pill options as the server holds them now, read in the same pass (a
 * pane format resolves a global option), so an unchanged pill costs no write.
 */
export const PILL_FIELDS = PILL_WORDS.map((word) => `#{@murmur_count_${word}}`);

/**
 * One pane as a collect saw it: what the store remembers (`SeenPane`) plus
 * the program's own words and the two local-only facts.
 */
export type ObservedPane = SeenPane & {
  focused: boolean;
  runs_on: string | null;
  dead_status: string | null;
  title: string | null;
  message: string | null;
  progress: number | null;
  blocked_kind: BlockedKind | null;
  pending: number | null;
  resume_command: string | null;
  resume_cwd: string | null;
  cwd: string | null;
};

/**
 * The window name worth recording: null while tmux renames the window after
 * its foreground process (`automatic-rename`, tmux's default), because then
 * the "name" is `node` or `zsh` and would shadow the session name in a label.
 */
export function chosenWindowName(
  name: string | undefined,
  autoRename: string | undefined,
): string | null {
  if (autoRename === "1") return null;
  return name || null;
}

/**
 * murmur's seven words from a pane's OSC 7501 summary and its lifecycle.
 *
 * A retained pane that died with a non-zero status is `crashed` whatever its
 * last record said. `working` under the `mu/delegates` record is the agent
 * waiting on its delegates. An unknown word reads as `idle`, as the protocol
 * says to.
 */
export function programState(row: {
  dead: boolean;
  deadStatus: string | null;
  state: string;
  id: string | null;
}): PaneState {
  if (row.dead && row.deadStatus !== "0") return "crashed";
  switch (row.state) {
    case "blocked":
    case "error":
    case "done":
      return row.state;
    case "working":
      return row.id === DELEGATES_RECORD ? "waiting" : "running";
    default:
      return "idle";
  }
}

/** A time from the multiplexer in seconds or milliseconds, as milliseconds. */
export function stateTime(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  return value < 1e12 ? value * 1000 : value;
}

function blockedKind(raw: string): BlockedKind | null {
  return (BLOCKED_KINDS as readonly string[]).includes(raw) ? (raw as BlockedKind) : null;
}

function progress(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return value <= 100 ? value : null;
}

/** How many delegates a `mu/delegates` record says are out: its count, else one. */
function delegates(message: string | null): number {
  const count = message ? /\d+/.exec(message) : null;
  return count ? Math.max(1, Number(count[0])) : 1;
}

/**
 * A pane title worth showing: tmux starts every pane titled with the host
 * name, which names the machine rather than the agent.
 */
export function chosenPaneTitle(title: string, host = hostname()): string | null {
  if (!title) return null;
  const short = host.split(".")[0];
  if (title === host || title === short) return null;
  // pi titles its pane `π - <session name> - <dir>` (or `π - <dir>` when unnamed).
  const piNamed = /^π - (.+) - [^ ]+$/.exec(title);
  if (piNamed?.[1]) return piNamed[1];
  const piPlain = /^π - (.+)$/.exec(title);
  if (piPlain?.[1]) return piPlain[1];
  return title;
}

/**
 * One `list-panes` row as an observed pane, or null for a pane murmur does not
 * list: neither a program reporting OSC 7501, nor one with a live OSC 7577
 * resume record, nor a pane mu placed. Including OSC 7577 keeps an agent
 * visible as `idle` after vtmux clears `done`/`error` on pane focus; vtmux
 * prunes the resume record once the process exits, so a plain shell drops off.
 * A foreground known harness (pi, claude, codex) is listed idle even before
 * it reports anything.
 */
export function parsePaneRow(fields: readonly string[], server: TmuxServer): ObservedPane | null {
  const [
    pane = "",
    session = "",
    window = "",
    sessionName = "",
    windowName = "",
    autoRename = "",
    ,
    dead = "",
    deadStatus = "",
    command = "",
    path = "",
    paneTitle = "",
    focused = "",
    state = "",
    kind = "",
    rawProgress = "",
    app = "",
    title = "",
    message = "",
    id = "",
    rawTime = "",
    resumeCommand = "",
    resumeCwd = "",
    agentName = "",
    workstream = "",
    role = "",
    host = "",
  ] = fields;
  if (!pane || !session || !window) return null;
  if (state === "" && agentName === "" && resumeCommand === "" && !isHarnessCli(command))
    return null;
  // `murmur rex-feed`'s own pane: reading it back would re-report the fleet.
  if (app === FEED_APP) return null;
  const isDead = dead === "1";
  const paneState = programState({
    dead: isDead,
    deadStatus: deadStatus || null,
    state,
    id: id || null,
  });
  const driver: Driver = agentName ? "orchestrated" : "human";
  return {
    server,
    pane: asPaneId(pane),
    session: asSessionId(session),
    window: asWindowId(window),
    session_name: sessionName || null,
    window_name: chosenWindowName(windowName, autoRename),
    state: paneState,
    state_time: stateTime(rawTime),
    agent_name: agentName || null,
    workstream: workstream || null,
    role: role || null,
    driver,
    harness: app || null,
    cli: command || null,
    pane_title: chosenPaneTitle(paneTitle),
    focused: focused === "1",
    runs_on: host || null,
    dead_status: isDead ? deadStatus || null : null,
    title: title || null,
    message: message || null,
    progress: progress(rawProgress),
    blocked_kind: paneState === "blocked" ? blockedKind(kind) : null,
    pending: paneState === "waiting" ? delegates(message || null) : null,
    resume_command: resumeCommand || null,
    resume_cwd: resumeCwd || null,
    cwd: path || null,
  };
}

const ATTENTION_STATES: readonly PaneState[] = ["crashed", "blocked", "error", "done"];

/** The sentence an attention row carries: the program's own, else what murmur can say. */
function attentionMessage(pane: ObservedPane): string {
  if (pane.message) return pane.message;
  if (pane.title) return pane.title;
  if (pane.state === "crashed") {
    return pane.dead_status ? `exited ${pane.dead_status}` : "pane died";
  }
  if (pane.state === "blocked" && pane.blocked_kind) return `needs ${pane.blocked_kind}`;
  return "";
}

/** An observed pane, with its age from the store, in the shape every reader takes. */
export function localPane(pane: ObservedPane, since: number): LocalPane {
  const agent: SnapshotAgent = {
    activity: pane.state === "running" ? "running" : "stopped",
    agent_name: pane.agent_name,
    workstream: pane.workstream,
    role: pane.role,
    driver: pane.driver,
    cli: pane.cli,
    harness: pane.harness,
    pane_title: pane.pane_title,
    title: pane.title,
    message: pane.message,
    progress: pane.progress,
    blocked_kind: pane.blocked_kind,
    pending: pane.pending,
    resume_command: pane.resume_command,
    resume_cwd: pane.resume_cwd,
    cwd: pane.cwd,
    updated_at: since,
  };
  return {
    server: pane.server,
    pane: pane.pane,
    session: pane.session,
    window: pane.window,
    session_name: pane.session_name,
    window_name: pane.window_name,
    agent,
    attention: ATTENTION_STATES.includes(pane.state)
      ? [
          {
            kind: pane.state as AttentionKind,
            message: attentionMessage(pane),
            source: pane.harness ?? "osc7501",
            driver: pane.driver,
            requested_at: since,
          },
        ]
      : [],
    focused: pane.focused,
    runs_on: pane.runs_on,
  };
}

/**
 * What one server's single pass returned: its panes, every pane id it holds
 * (listed or not), and its raw rows for the pill.
 */
export type TmuxRead = {
  server: TmuxSocket;
  panes: ObservedPane[] | null;
  live: Set<string>;
  rows: string[][];
};

/**
 * The rows as panes, one per pane id. `list-panes -a` prints a window linked
 * into several sessions once per session; the pane is focused if any of its
 * sessions shows it.
 */
function uniquePanes(rows: readonly string[][], server: TmuxServer): ObservedPane[] {
  const panes = new Map<string, ObservedPane>();
  for (const row of rows) {
    const next = parsePaneRow(row, server);
    if (next === null) continue;
    const existing = panes.get(next.pane);
    panes.set(
      next.pane,
      existing ? { ...existing, focused: existing.focused || next.focused } : next,
    );
  }
  return [...panes.values()];
}

/** One `list-panes` per tmux server: every server tmux's directory names, and every one seen before. */
export function readTmux(mux: Mux, known: readonly TmuxServer[] = []): TmuxRead[] {
  const servers = new Map<string, TmuxSocket>();
  for (const server of mux.servers()) servers.set(serverKey(server), server);
  // A server seen before is asked again even when its socket is gone: that
  // answer ("no server running") is what retires its panes.
  for (const server of known) {
    if (server.kind !== "rex") servers.set(serverKey(server), server);
  }
  return [...servers.values()].map((server) => {
    const rows = mux.listPanes([...PANE_FIELDS, ...PILL_FIELDS], server);
    return {
      server,
      rows: rows ?? [],
      panes: rows === null ? null : uniquePanes(rows, server),
      live: new Set((rows ?? []).flatMap(([pane]) => (pane ? [pane] : []))),
    };
  });
}

/** Everything one local read produced. */
export type LocalRead = {
  /** Every local pane: the live ones, then the crashes murmur recorded. */
  panes: LocalPane[];
  /** The tmux servers asked, for the pill. Rex has no options to publish to. */
  tmux: TmuxRead[];
  /** Panes that vanished mid-work during this read. */
  crashed: SnapshotPane["pane"][];
};

export type LocalOptions = {
  /** How Rex is read; `false` skips it. Injected so a test needs no Rex. */
  rex?: (() => Promise<RexRead | null>) | false;
};

/**
 * Read every local pane: the tmux servers in one pass each, Rex when it runs,
 * then let the store fold in what only it knows. The one way local state is
 * read; `status`, `export`, the dash and the side panel all come through here.
 */
export async function readLocal(
  store: Store,
  mux: Mux,
  now = Date.now(),
  options: LocalOptions = {},
): Promise<LocalRead> {
  const tmux = readTmux(mux, store.knownServers());
  const rex = options.rex === false ? null : await (options.rex ?? readRex)().catch(() => null);
  const reads: { server: TmuxServer; panes: ObservedPane[] | null; live: Set<string> }[] = [
    ...tmux,
    ...(rex ? [rex] : []),
  ];
  const sync = store.syncLocal(
    reads.map((read): ServerRead => ({ server: read.server, panes: read.panes, live: read.live })),
    now,
  );
  const live = reads.flatMap((read) =>
    (read.panes ?? []).map((pane) => localPane(pane, sync.since.get(paneKey(pane)) ?? now)),
  );
  const recorded = store
    .localPanes()
    .map((pane): LocalPane => ({ ...pane, focused: false, runs_on: null }));
  return { panes: [...live, ...recorded], tmux, crashed: sync.crashed };
}

/** A local pane as the wire carries it: the local-only fields dropped. */
function snapshotPane({ focused: _focused, runs_on: _runsOn, ...pane }: LocalPane): SnapshotPane {
  return pane;
}

/**
 * This node's snapshot. Complete, so absence in it is absence: built from a
 * fresh local read, never from a cache.
 */
export function buildSnapshot(
  identity: NodeIdentity,
  panes: readonly LocalPane[],
  now = Date.now(),
): Snapshot {
  return {
    murmur_snapshot: SNAPSHOT_VERSION,
    host_id: identity.host_id,
    display_name: identity.display_name,
    murmur_version: MURMUR_VERSION,
    generated_at: now,
    // Sorted by address so the document diffs cleanly; order carries nothing.
    panes: panes
      .map(snapshotPane)
      .sort((left, right) => paneKey(left).localeCompare(paneKey(right))),
  };
}
