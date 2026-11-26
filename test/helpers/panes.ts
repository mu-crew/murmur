import { asPaneId, asSessionId, asWindowId } from "../../src/ids.js";
import { PANE_FIELDS, PILL_WORDS } from "../../src/local.js";
import type { Mux } from "../../src/mux.js";
import type { LocalPane, SnapshotAgent, SnapshotPane, TmuxSocket } from "../../src/types.js";
import { serverKey } from "../../src/types.js";
import { fakeMux } from "./fake-mux.js";

/** An agent as a vtmux pane reports it: every optional fact null. */
export function agent(over: Partial<SnapshotAgent> = {}): SnapshotAgent {
  return {
    activity: "running",
    agent_name: null,
    workstream: null,
    role: null,
    driver: "human",
    cli: "pi",
    harness: "pi",
    pane_title: null,
    title: null,
    message: null,
    progress: null,
    blocked_kind: null,
    pending: null,
    resume_command: null,
    resume_cwd: null,
    cwd: null,
    updated_at: 1_000,
    ...over,
  };
}

/** A local pane as `readLocal` answers it. */
export function localPane(
  over: Partial<Omit<LocalPane, "agent">> & { agent?: Partial<SnapshotAgent> | null } = {},
): LocalPane {
  const { agent: agentOver, ...rest } = over;
  return {
    server: { kind: "default" },
    pane: asPaneId("%1"),
    session: asSessionId("$0"),
    window: asWindowId("@0"),
    session_name: "work",
    window_name: null,
    agent: agentOver === null ? null : agent(agentOver),
    attention: [],
    focused: false,
    runs_on: null,
    ...rest,
  };
}

/** The names of `PANE_FIELDS`, in order: one `list-panes` row's columns. */
export const ROW_FIELDS = [
  "pane",
  "session",
  "window",
  "session_name",
  "window_name",
  "auto_rename",
  "pid",
  "dead",
  "dead_status",
  "command",
  "path",
  "pane_title",
  "focused",
  "state",
  "kind",
  "progress",
  "app",
  "title",
  "message",
  "id",
  "state_time",
  "resume_command",
  "resume_cwd",
  "mu_agent",
  "mu_workstream",
  "mu_role",
  "mu_host",
] as const;

export type RowField = (typeof ROW_FIELDS)[number] | `pill_${(typeof PILL_WORDS)[number]}`;

/**
 * One vtmux `list-panes` row, as `readTmux` asks for it (`PANE_FIELDS` then
 * the pill's current values). Unnamed fields are empty, as tmux prints an
 * unset format.
 */
export function vtmuxRow(fields: Partial<Record<RowField, string>> = {}): string[] {
  if (ROW_FIELDS.length !== PANE_FIELDS.length) throw new Error("ROW_FIELDS out of date");
  const base: Partial<Record<RowField, string>> = {
    pane: "%1",
    session: "$0",
    window: "@0",
    session_name: "work",
    window_name: "w",
    auto_rename: "0",
    pid: "100",
    dead: "0",
    command: "pi",
    path: "/work",
    ...fields,
  };
  return [
    ...ROW_FIELDS.map((name) => base[name] ?? ""),
    ...PILL_WORDS.map((word) => base[`pill_${word}`] ?? ""),
  ];
}

/**
 * A Mux whose `list-panes` answers these rows per server, null for a server
 * that cannot be asked. Records every command `run` sends.
 */
export function vtmuxMux(
  rows: Map<string, string[][] | null> | string[][],
  over: Partial<Mux> = {},
): Mux & { ran: { server: TmuxSocket; commands: readonly string[][] }[] } {
  const byServer = rows instanceof Map ? rows : new Map([[serverKey({ kind: "default" }), rows]]);
  const ran: { server: TmuxSocket; commands: readonly string[][] }[] = [];
  const mux = fakeMux({
    servers: () =>
      [...byServer.keys()].map((key): TmuxSocket => {
        const [kind, value] = key.split("\0");
        return kind === "default"
          ? { kind: "default" }
          : { kind: kind as "label" | "path", value: value ?? "" };
      }),
    listPanes: (_fields, server) => {
      const answer = byServer.get(serverKey(server));
      return answer === undefined ? [] : answer;
    },
    run: (commands, server) => {
      ran.push({ server, commands });
    },
    ...over,
  });
  return Object.assign(mux, { ran });
}

/** The crashes a store recorded, as the local panes `readLocal` would add for them. */
export function recordedPanes(store: { localPanes(): SnapshotPane[] }): LocalPane[] {
  return store.localPanes().map((pane) => ({ ...pane, focused: false, runs_on: null }));
}
