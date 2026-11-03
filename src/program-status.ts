/**
 * The fleet as OSC 7501 program status records, for `murmur rex-feed`.
 *
 * A terminal that supports the Program Status Protocol (Rex) keeps a set of
 * records per pane and marks the pane's tab from them. murmur cannot write
 * records onto another pane -- a record can only come from the program writing
 * that pane's output -- so the feed runs in a pane of its own and reports the
 * fleet there: one record per agent that wants a human, and a root summary.
 *
 * Which agents: exactly the ones the status pill counts (`statusRollup`):
 * every human-driven agent that is not idle, and crew agents only in the
 * NEEDS_HUMAN states. A `done` crew worker is its supervisor's business.
 *
 * Spec: https://www.superlogical.com/rex/docs/build/program-status
 */
import { agentLabel, terminalText } from "./agents.js";
import type { Status } from "./status.js";
import { NEEDS_HUMAN, oneLiner, type PaneView, type RenderState, renderState } from "./view.js";

export type ProgramState = "idle" | "working" | "blocked" | "done" | "error";

/** One record as the feed reports it. `id` is under `crew/`; root has none. */
export type ProgramRecord = {
  id: string | null;
  state: ProgramState;
  kind?: "question";
  title?: string;
  msg?: string;
};

/**
 * murmur's seven words in the protocol's five. `crashed` is an `error`: the
 * protocol has no word for a process that died, and both mean "go look".
 * `waiting` (delegates out) is still working on its own account.
 */
const STATE: Record<RenderState, ProgramState | null> = {
  crashed: "error",
  error: "error",
  blocked: "blocked",
  done: "done",
  running: "working",
  waiting: "working",
  idle: null,
};

/** Whether a pane gets a record: the pill's rule, and never idle. */
export function reported(pane: PaneView): boolean {
  const state = renderState(pane);
  if (STATE[state] === null) return false;
  return pane.driver === "human" || (NEEDS_HUMAN as readonly RenderState[]).includes(state);
}

/**
 * A record id that stays the same for a pane across ticks and never collides:
 * the protocol's segment charset is `[A-Za-z0-9_.+-]`, at most 32 bytes, so
 * the host id and pane address are hashed rather than spelled.
 */
export function recordId(pane: Pick<PaneView, "host_id" | "server" | "pane">): string {
  return `crew/${fnv1a(JSON.stringify([pane.host_id, pane.server, pane.pane]))}`;
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (const byte of Buffer.from(s, "utf8")) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function paneRecord(pane: PaneView): ProgramRecord {
  const state = STATE[renderState(pane)] ?? "idle";
  const where = pane.local ? agentLabel(pane) : `${pane.host} · ${agentLabel(pane)}`;
  const msg = oneLiner(pane) || (pane.freshness === "stale" ? "stale" : "");
  return {
    id: recordId(pane),
    state,
    // murmur's blocked carries no kind; question is the protocol's nearest
    // (an agent waiting for an answer).
    ...(state === "blocked" ? { kind: "question" as const } : {}),
    title: where,
    ...(msg ? { msg } : {}),
  };
}

/**
 * The root record: the most urgent state among the reported agents, so the
 * feed's own tab shows the fleet at a glance, and a count line.
 */
export function rootRecord(records: readonly ProgramRecord[]): ProgramRecord {
  const order: ProgramState[] = ["error", "blocked", "done", "working"];
  const top = order.find((s) => records.some((r) => r.state === s)) ?? "idle";
  const counts = order
    .map((s) => [s, records.filter((r) => r.state === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`);
  return {
    id: null,
    state: top,
    ...(top === "blocked" ? { kind: "question" as const } : {}),
    msg: counts.length > 0 ? counts.join(", ") : "nothing needs you",
  };
}

/** Every record the feed should hold for this view, root first. */
export function fleetRecords(view: Status): ProgramRecord[] {
  const panes = view.panes.filter(reported).map(paneRecord);
  return [rootRecord(panes), ...panes];
}

/** The `OSC 7501 ; … ST` sequence for one record. */
export function formatRecord(r: ProgramRecord): string {
  const pairs = [`state=${r.state}`];
  if (r.id !== null) pairs.push(`id=${r.id}`);
  pairs.push("app=murmur");
  if (r.kind) pairs.push(`kind=${r.kind}`);
  if (r.title) pairs.push(`title=${b64(r.title, 192)}`);
  if (r.msg) pairs.push(`msg=${b64(r.msg, 2048)}`);
  return `\x1b]7501;${pairs.join(":")}\x1b\\`;
}

export function formatClear(id: string | null): string {
  return id === null ? "\x1b]7501;state=clear\x1b\\" : `\x1b]7501;state=clear:id=${id}\x1b\\`;
}

/**
 * The spec refuses a report whose decoded text holds a control character, or
 * is over its limit (192 bytes for a title, 2048 for a message), and discards
 * it whole. So both are made safe here rather than lost.
 */
function b64(text: string, maxBytes: number): string {
  let s = terminalText(text);
  while (Buffer.byteLength(s, "utf8") > maxBytes) s = [...s].slice(0, -1).join("");
  return Buffer.from(s, "utf8").toString("base64");
}

/**
 * What to write to move the terminal from `sent` to `next`: a report for each
 * record that is new or changed, and a clear for each that went away. Each
 * report replaces its record whole, so an unchanged one is not re-sent.
 */
export function diffRecords(
  sent: ReadonlyMap<string | null, string>,
  next: readonly ProgramRecord[],
): { writes: string[]; now: Map<string | null, string> } {
  const now = new Map<string | null, string>();
  const writes: string[] = [];
  for (const r of next) {
    const seq = formatRecord(r);
    now.set(r.id, seq);
    if (sent.get(r.id) !== seq) writes.push(seq);
  }
  for (const id of sent.keys()) {
    if (!now.has(id)) writes.push(formatClear(id));
  }
  return { writes, now };
}
