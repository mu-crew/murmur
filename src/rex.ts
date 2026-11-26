/**
 * The Rex local collector: Rex panes, read into the same shape as tmux ones.
 *
 * Rex keeps each terminal block's OSC 7501 records itself (`program_status`)
 * and knows its program (`process`), so a Rex pane needs nothing from murmur
 * but this read. Fail-silent by construction: no `rex` binary, no running Rex
 * server, or any reply murmur cannot read is "no Rex here" (`null`), never an
 * error -- and never evidence that a Rex pane is gone. `--autostart=false`,
 * because a status-bar tick must not start a Rex server.
 */
import { execFile } from "node:child_process";
import { findHelper } from "./helper-path.js";
import { asPaneId, asSessionId, asWindowId } from "./ids.js";
import type { ObservedPane } from "./local.js";
import {
  BLOCKED_KINDS,
  type BlockedKind,
  DELEGATES_RECORD,
  FEED_APP,
  type PaneState,
} from "./types.js";

/** Rex's panes with a program status, and every block id Rex holds. */
export type RexRead = { server: { kind: "rex" }; panes: ObservedPane[]; live: Set<string> };

/** A reply murmur cannot read, part way through: the whole read is no evidence. */
class Unreadable extends Error {}

/** One `rex api call`, answering its JSON reply or null. */
export type RexCall = (method: string, input: Record<string, unknown>) => Promise<unknown>;

type Json = Record<string, unknown>;
const isJson = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;
const list = (value: unknown, key: string): Json[] =>
  isJson(value) && Array.isArray(value[key]) ? (value[key] as unknown[]).filter(isJson) : [];

/** The real call: the `rex` CLI, or null when it is not installed. */
export function rexCli(binary = findHelper("rex")): RexCall | null {
  if (binary === null) return null;
  return (method, input) =>
    new Promise((resolve) => {
      execFile(
        binary,
        ["--autostart=false", "--timeout", "2s", "api", "call", method, JSON.stringify(input)],
        { timeout: 3000, encoding: "utf8" },
        (error, stdout) => {
          if (error) return resolve(null);
          try {
            resolve(JSON.parse(stdout));
          } catch {
            resolve(null);
          }
        },
      );
    });
}

const PRIORITY: readonly string[] = ["blocked", "error", "working", "done", "idle"];

/** The record that speaks for the pane: the most urgent state, the root first on a tie. */
function summary(records: readonly Json[]): Json | null {
  let best: Json | null = null;
  for (const record of records) {
    const rank = PRIORITY.indexOf(String(record.state));
    if (rank === -1) continue;
    if (best === null || rank < PRIORITY.indexOf(String(best.state))) best = record;
  }
  return best;
}

/**
 * Every Rex terminal with a program status, or null when Rex cannot be asked.
 * A session's blocks or a block's status that cannot be read makes the whole
 * read null: reporting the rest would read that block as gone, and a block
 * gone mid-work is a crash.
 */
export async function readRex(call: RexCall | null = rexCli()): Promise<RexRead | null> {
  if (call === null) return null;
  try {
    return await readRexOrThrow(call);
  } catch (error) {
    if (error instanceof Unreadable) return null;
    throw error;
  }
}

async function readRexOrThrow(call: RexCall): Promise<RexRead | null> {
  const sessions = await call("session.list", {});
  if (!isJson(sessions)) return null;
  const live = new Set<string>();
  const panes = await Promise.all(
    list(sessions, "sessions").map(async (session) => {
      const sessionId = str(session.session_id);
      if (sessionId === null) return [];
      const reply = await call("session.list_blocks", { session_id: sessionId });
      if (!isJson(reply)) throw new Unreadable();
      const blocks = list(reply, "blocks");
      for (const block of blocks) {
        const blockId = str(block.block_id);
        if (blockId !== null) live.add(blockId);
      }
      return Promise.all(
        blocks.map(async (block): Promise<ObservedPane | null> => {
          const blockId = str(block.block_id);
          if (blockId === null) return null;
          const method = (name: string) =>
            call("block.method", { session_id: sessionId, block_id: blockId, method: name });
          const [status, process] = await Promise.all([
            method("program_status"),
            method("process"),
          ]);
          if (!isJson(status)) throw new Unreadable();
          // `murmur rex-feed`'s own records are its echo of the fleet.
          const top = summary(
            list(status, "records").filter(
              (record) => record.app !== FEED_APP && record.effective_app !== FEED_APP,
            ),
          );
          if (top === null) return null;
          const proc = isJson(process) ? process : {};
          const exit = isJson(proc.last_exit) ? proc.last_exit : null;
          const fg = isJson(proc.foreground)
            ? proc.foreground
            : isJson(proc.child)
              ? proc.child
              : {};
          const code = exit && typeof exit.exit_code === "number" ? exit.exit_code : null;
          const dead = !isJson(proc.child) && code !== null && code !== 0;
          const raw = String(top.state);
          const id = str(top.id);
          const state: PaneState = dead
            ? "crashed"
            : raw === "working"
              ? id === DELEGATES_RECORD
                ? "waiting"
                : "running"
              : (raw as PaneState);
          const message = str(top.msg);
          const kind = str(top.kind);
          const at = Date.parse(String(top.updated_at));
          const progress =
            typeof top.progress === "number" && top.progress <= 100 ? top.progress : null;
          return {
            server: { kind: "rex" },
            pane: asPaneId(blockId),
            session: asSessionId(sessionId),
            window: asWindowId(str(block.window_id) ?? sessionId),
            session_name: str(session.label),
            window_name: null,
            state,
            state_time: Number.isFinite(at) ? at : null,
            agent_name: null,
            workstream: null,
            role: null,
            driver: "human",
            harness: str(top.effective_app) ?? str(top.app),
            cli: str(fg.argv0)?.split("/").pop() ?? str(fg.name),
            pane_title: str(block.label),
            focused: false,
            runs_on: null,
            dead_status: dead && code !== null ? String(code) : null,
            title: str(top.title),
            message,
            progress,
            blocked_kind:
              state === "blocked" && kind && (BLOCKED_KINDS as readonly string[]).includes(kind)
                ? (kind as BlockedKind)
                : null,
            pending:
              state === "waiting" ? Math.max(1, Number(/\d+/.exec(message ?? "")?.[0] ?? 1)) : null,
            resume_command: null,
            resume_cwd: null,
            cwd: str(fg.cwd),
          };
        }),
      );
    }),
  );
  return {
    server: { kind: "rex" },
    panes: panes.flat().filter((pane): pane is ObservedPane => pane !== null),
    live,
  };
}
