import { readFileSync } from "node:fs";
import { join } from "node:path";
import { paneReport } from "../../src/cli/pane.js";
import type { Harness } from "../../src/harnesses.js";
import { type HookContext, harnessHookEvent } from "../../src/hook.js";
import { type HookPayload, mapHookPayload } from "../../src/hook-rows.js";
import { asPaneId, asSessionId, asWindowId } from "../../src/ids.js";
import { drainInbox, type InboxHost } from "../../src/inbox.js";
import type { InboxEvent } from "../../src/inbox-event.js";
import { type ProcessRow, placeEvent } from "../../src/process-chain.js";
import type { Store } from "../../src/store.js";
import type { Location } from "../../src/types.js";
import { fakeMux } from "./fake-mux.js";

/**
 * The recorded U0 hook calls (test/fixtures/u0-*.jsonl) and the pane they were
 * recorded in, for the hook-row tests.
 *
 * Each line is one hook call as recorded: the payload on stdin, the hook's
 * `$TMUX`/`$TMUX_PANE` when it had them (Muse's hooks have neither), and its
 * process chain from the hook up to the tmux server. Paths, argv, model names
 * and the user's email are scrubbed; pids, ids, event order and every field a
 * row reads are as recorded.
 */

export type FixtureLine = {
  u0_line: number;
  event: string;
  payload: HookPayload;
  env: Record<string, string>;
  chain: { pid: number; args: string }[];
};

export type FixtureName = "claude" | "codex" | "cursor-agent" | "muse" | "muse-settings";

export function fixture(name: FixtureName): FixtureLine[] {
  return readFileSync(join(import.meta.dirname, "..", "fixtures", `u0-${name}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as FixtureLine);
}

/** The recorded chain as a process table: each entry is the parent of the one before. */
export function tableOf(chain: FixtureLine["chain"]): Map<number, ProcessRow> {
  const table = new Map<number, ProcessRow>();
  chain.forEach((entry, index) => {
    table.set(entry.pid, {
      pid: entry.pid,
      ppid: chain[index + 1]?.pid ?? 0,
      started: null,
      args: entry.args,
    });
  });
  return table;
}

export const NOW = 1_800_000_000_000;
export const SERVER = 7399;
export const ROOT = 79888;

export function contextOf(line: FixtureLine, over: Partial<HookContext> = {}): HookContext {
  return {
    table: tableOf(line.chain),
    self: line.chain[0]?.pid as number,
    env: line.env,
    now: NOW,
    ...over,
  };
}

export function hook(harness: Harness, line: FixtureLine): InboxEvent | null {
  return harnessHookEvent(harness, line.payload, contextOf(line));
}

/** The event written for one call, or why nothing was: `row`, else the chain's reason. */
export function outcome(harness: Harness, line: FixtureLine): string {
  if (mapHookPayload(harness, line.payload) === null) return "row";
  const event = hook(harness, line);
  if (event) return event.event;
  const placed = placeEvent(tableOf(line.chain), line.chain[0]?.pid as number, {
    tmuxEnv: line.env.TMUX,
  });
  return placed.kind === "drop" ? placed.reason : placed.kind;
}

export function location(): Location {
  return {
    server: { kind: "default" },
    session: asSessionId("$0"),
    window: asWindowId("@0"),
    pane: asPaneId("%72"),
    session_name: "work",
    window_name: null,
  };
}

/** The recorded server and pane; every recorded harness process alive. */
export function host(over: Partial<InboxHost> = {}): InboxHost {
  return {
    isAlive: () => true,
    serverFor: (pid) => (pid === SERVER ? { kind: "default" } : null),
    panes: () => new Map([[ROOT, { location: location(), focused: false }]]),
    piRunsUnder: () => false,
    ...over,
  };
}

export function drain(store: Store, over: Partial<InboxHost> = {}) {
  return drainInbox(store, {
    host: host(over),
    mux: fakeMux({ panesInWindow: () => [asPaneId("%72")] }),
  });
}

export function report(store: Store) {
  return paneReport(store, asPaneId("%72"), { kind: "default" }, false);
}

/** The pane in one line: state, runs, session prefix, and the last text when asked. */
export function view(store: Store, withText = false): string {
  const pane = report(store);
  if (!pane.agent) return pane.state === null ? "released" : `released ${pane.state}`;
  const session = pane.agent.session_id?.slice(0, 8) ?? "?";
  const text = withText ? ` text=${JSON.stringify(pane.agent.last_text)}` : "";
  return `${pane.state} runs=${pane.agent.run_count} session=${session}${text}`;
}

export function attention(store: Store): string[] {
  return report(store).attention.map((row) => `${row.kind}:${row.message}`);
}
