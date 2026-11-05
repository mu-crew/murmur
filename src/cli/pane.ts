import type { Command } from "commander";
import { asPaneId, type PaneId } from "../ids.js";
import { type DrainOptions, drainInbox } from "../inbox.js";
import { deriveTmuxServer, tmuxAgentState } from "../mux.js";
import { drainRemote } from "../remote.js";
import { openStore, type Store } from "../store.js";
import type { SnapshotAttention, TmuxServer } from "../types.js";
import { renderState } from "../view.js";

/**
 * One local pane, read AFTER draining the inbox: what mu's send gate and send
 * acknowledgement read for a hook harness. Uncached by construction -- a
 * status-bar view can lag, and a `run_count` that lags is an ack that never
 * arrives.
 *
 * Local only. Nothing here reaches a snapshot, so the harness-side fields
 * (`run_count`, `session_id`, `last_text`, ...) cost no wire change.
 */
export type PaneReport = {
  pane: PaneId;
  server: TmuxServer;
  /**
   * The pane option's word (`working`, `idle`, `blocked`, ...), or `idle?` for
   * an interrupt mu sent that no harness event has confirmed yet. Null when
   * murmur knows nothing about the pane.
   */
  state: string | null;
  agent: {
    agent_name: string | null;
    workstream: string | null;
    role: string | null;
    cli: string;
    driver: string;
    activity: string;
    source: string;
    harness: string | null;
    session_id: string | null;
    run_count: number | null;
    last_text: string | null;
    confirmed: boolean;
    claimed_at: number;
    updated_at: number;
  } | null;
  attention: SnapshotAttention[];
};

export function paneReport(
  store: Store,
  pane: PaneId,
  server: TmuxServer,
  drain: DrainOptions | false = {},
): PaneReport {
  if (drain !== false) drainInbox(store, drain);
  const same = (other: TmuxServer): boolean =>
    other.kind === server.kind &&
    ("value" in other ? other.value : "") === ("value" in server ? server.value : "");
  const local = store.localPanes().find((entry) => entry.pane === pane && same(entry.server));
  const harness = store.harnessState({ server, pane });
  if (!local) return { pane, server, state: null, agent: null, attention: [] };
  const rendered = renderState({
    activity: local.agent?.activity ?? null,
    attention: local.attention,
    pending: local.agent?.pending ?? null,
  });
  const unconfirmed = rendered === "idle" && harness !== null && !harness.confirmed;
  return {
    pane,
    server,
    state: unconfirmed ? "idle?" : tmuxAgentState(rendered),
    agent:
      local.agent && harness
        ? {
            agent_name: local.agent.agent_name,
            workstream: local.agent.workstream,
            role: local.agent.role,
            cli: local.agent.cli,
            driver: local.agent.driver,
            activity: local.agent.activity,
            source: harness.source,
            harness: harness.harness,
            session_id: harness.session_id,
            run_count: harness.run_count,
            last_text: harness.last_text,
            confirmed: harness.confirmed,
            claimed_at: local.agent.claimed_at,
            updated_at: local.agent.updated_at,
          }
        : null,
    attention: local.attention,
  };
}

/**
 * The server a pane id is read against: `-L`/`-S` when given, else the server
 * this command runs inside (`$TMUX`), else the default one.
 */
export function paneServer(
  options: { socketName?: string; socketPath?: string },
  env: NodeJS.ProcessEnv = process.env,
): TmuxServer {
  if (options.socketPath) return deriveTmuxServer(options.socketPath);
  if (options.socketName) {
    return options.socketName === "default"
      ? { kind: "default" }
      : { kind: "label", value: options.socketName };
  }
  const socket = env.TMUX?.split(",")[0];
  return socket ? deriveTmuxServer(socket) : { kind: "default" };
}

export function registerPane(program: Command): void {
  program
    .command("pane")
    .description("Show one local pane's state after draining hook events, or a remote worker's")
    .argument("[pane]", "tmux pane id, e.g. %12")
    .option("--json", "print JSON")
    .option(
      "--remote <key>",
      "a remote worker's state by its key (`<origin host>/<origin pane key>`), read on its node",
    )
    .option("-L, --socket-name <name>", "tmux server socket name")
    .option("-S, --socket-path <path>", "tmux server socket path")
    .action(
      (
        raw: string | undefined,
        options: { json?: boolean; remote?: string; socketName?: string; socketPath?: string },
      ) => {
        if (options.remote !== undefined) {
          if (raw !== undefined) {
            process.stderr.write("murmur: pane: give a pane or --remote, not both\n");
            process.exitCode = 2;
            return;
          }
          // No store: a remote worker's events never reach this node's.
          const report = drainRemote(options.remote);
          if (typeof report === "string") {
            process.stderr.write(`murmur: ${report}\n`);
            process.exitCode = 2;
            return;
          }
          process.stdout.write(
            options.json
              ? `${JSON.stringify(report, null, 2)}\n`
              : `${report.remote}\t${report.state ?? "-"}\t${report.agent?.harness ?? "-"}\n`,
          );
          return;
        }
        if (raw === undefined || !/^%\d+$/.test(raw)) {
          process.stderr.write(`murmur: not a tmux pane id: ${raw ?? ""}\n`);
          process.exitCode = 2;
          return;
        }
        const store = openStore();
        try {
          const report = paneReport(store, asPaneId(raw), paneServer(options));
          process.stdout.write(
            options.json
              ? `${JSON.stringify(report, null, 2)}\n`
              : `${report.pane}\t${report.state ?? "-"}\t${report.agent?.harness ?? report.agent?.cli ?? "-"}\n`,
          );
        } finally {
          store.close();
        }
      },
    );
}
