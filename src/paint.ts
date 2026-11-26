import { agentLabel, agentLocation, terminalText } from "./agents.js";
import { warmSocketCommand } from "./channel.js";
import { DASH_GLYPH, hostColor } from "./dash-paint.js";
import { type GlanceRunner, type GlanceRunnerAsync, glance, glanceAsync } from "./glance.js";
import type { Status } from "./status.js";
import type { Store } from "./store.js";
import { age, isVisible, type PaneView, renderState } from "./view.js";

export { isVisible };

export const SIDE_PREVIEW_MIN_COLUMNS = 150;

export type GlancePlacement = "right" | "bottom";

export function glancePlacement(columns: number): GlancePlacement {
  return columns > 0 && columns < SIDE_PREVIEW_MIN_COLUMNS ? "bottom" : "right";
}

export function glanceShare(placement: GlancePlacement, preview = 0.75): number {
  return placement === "bottom" ? 0.6 : preview;
}

/** Trailing capture-pane lines kept for a scrollable dash glance. */
export const PREVIEW_PANE_TAIL_LINES = 2_000;

export type PreviewOptions = {
  /** How many trailing lines of capture-pane text to keep. */
  paneTailLines?: number;
};

function tailLines(text: string, maxLines: number): string {
  if (maxLines <= 0) return text;
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(-maxLines).join("\n");
}

// The state glyphs, under the name the preview and notice use. The map lives
// with the dash vocabulary so every murmur surface paints one state with one symbol.
export const GLYPH = DASH_GLYPH;

// Mirrors the window-glyph colours: red needs you now, peach needs you soon,
// teal is finished-unseen, grey is busy or idle and carries no signal.
export const COLOUR: Record<string, string> = {
  crashed: "\u001b[31m",
  error: "\u001b[35m",
  blocked: "\u001b[33m",
  done: "\u001b[36m",
  running: "\u001b[37m",
  waiting: "\u001b[34m",
  idle: "\u001b[90m",
};
/**
 * A host in its accent, as truecolor SGR: the same color the dash, the side
 * panel and the notification hook give it, so a host reads the same
 * everywhere. Local rows say "here" but keep this machine's color.
 */
function hostSgr(host: string): string {
  const hex = hostColor(host);
  const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  return `\u001b[38;2;${r};${g};${b}m`;
}
const BOLD = "\u001b[1m";
export const DIM = "\u001b[2m";
export const RESET = "\u001b[0m";

/** How many gated peers the header names before it stops. */
const NOTICE_PEERS = 3;

/**
 * The header line for peers that need an interactive session, or null.
 *
 * A header line rather than a row: a synthetic row would break the invariant
 * that every row is a jumpable pane, and a glance is unreachable when the peer
 * contributes no rows at all -- which is exactly when a lapsed session leaves
 * the reader blind.
 *
 * Sorted oldest-first because that is the peer whose rows are most likely to
 * mislead, and TRIMMED with no counter: a truncated list plus a count is more
 * furniture than one header line can carry, and `murmur doctor` has the full
 * list.
 */
export function sessionNotice(peers: Status["peers"], now = Date.now()): string | null {
  const gated = peers
    .filter((peer) => peer.needs_session)
    // Null sorts first: never-reached is the oldest thing there is.
    .sort((left, right) => (left.fetched_at ?? 0) - (right.fetched_at ?? 0));
  if (gated.length === 0) return null;

  const named = gated.slice(0, NOTICE_PEERS).map((peer) => peer.name);
  const oldest = gated[0];
  // NOT `const age` -- `age` is already imported from view.js at the top of
  // this file, so that would shadow the function called on the next line.
  const seen =
    oldest?.fetched_at === null || oldest?.fetched_at === undefined
      ? "never"
      : // `age()` returns "" under a minute, which would read as "last seen )".
        age(now - oldest.fetched_at) || "just now";

  // BOLD and `blocked`'s yellow, not DIM. This is the one header line that asks
  // the reader to DO something, and DIM is this file's code for furniture --
  // secondary facts and labels wear it. Rendering an action in the
  // same weight as scenery is how it goes unread, which is the whole failure the
  // notice exists to prevent.
  //
  // Yellow rather than a new colour: COLOUR's documented vocabulary is "red
  // needs you now, peach needs you soon", and a lapsed login is exactly the
  // latter -- nothing is broken and nothing is lost, but the rows below are
  // ageing until you act. Reusing `blocked`'s colour keeps one meaning per hue
  // instead of teaching the reader a fourth.
  //
  // The `!` prefix is `blocked`'s glyph, so the line reads as the same class of
  // thing in the glyph column's own alphabet. The remedy stays undimmed because
  // it is the part meant to be copied.
  const attention = `${BOLD}${COLOUR.blocked ?? ""}`;
  // The remedy is `warmSocketCommand`, not a hand-written `ssh <host>`. The
  // shorter form shipped once and could not be relied on: OpenSSH defaults to
  // `ControlMaster no` and `ControlPath none`, so on a machine with no
  // ssh_config of its own a plain `ssh` leaves no socket where murmur looks --
  // the reader ran it, murmur still could not collect, and the notice kept
  // telling them to do the thing that had just failed. Built from the same
  // constant as `ControlPath`, so the suggestion cannot drift from where murmur
  // looks.
  //
  // Keyed on TARGET, not name: `peer add <name> [target]` takes them separately,
  // so a command built from the name is not guaranteed to run.
  const oldestTarget = oldest?.target ?? named[0] ?? "";
  return (
    `${attention}${GLYPH.blocked} ${named.join(", ")}: re-auth needed${RESET}` +
    `${COLOUR.blocked ?? ""} (last seen ${seen}) \u2014 ${BOLD}${warmSocketCommand(oldestTarget)}${RESET}`
  );
}

function timestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function previewText(
  store: Store,
  agent: PaneView,
  // The already-resolved peer list, passed DOWN rather than re-read. `runPreview`
  // has called `status()` once already, and this runs per keypress as the cursor
  // moves, so a second read would double the ~20ms warm-socket probe
  // `needs_session` pays -- on the one path in murmur that cannot afford it.
  peers: Status["peers"],
  run?: GlanceRunner,
  options: PreviewOptions = {},
): string {
  return previewBody(agent, peers, glance(store, agent, undefined, run), options);
}

/** `previewText` with the remote capture awaited instead of blocking on. */
export async function previewTextAsync(
  store: Store,
  agent: PaneView,
  peers: Status["peers"],
  run?: GlanceRunnerAsync,
  options: PreviewOptions = {},
): Promise<string> {
  return previewBody(agent, peers, await glanceAsync(store, agent, undefined, run), options);
}

function previewBody(
  agent: PaneView,
  peers: Status["peers"],
  pane: string | null,
  options: PreviewOptions,
): string {
  const state = renderState(agent);
  const colour = COLOUR[state] ?? "";
  const head = [
    // Same one chain the row uses, not a fork whose true branch was what
    // `agentLabel` does first anyway.
    `${colour}${GLYPH[state] ?? "?"} ${state}${RESET}  ${BOLD}${agentLabel(agent)}${RESET}`,
    // Whether "where" is this machine decides if the glance below is a local
    // capture-pane or an ssh, so it is stated rather than inferred.
    agent.local
      ? `${hostSgr(agent.host)}here${RESET}  ${DIM}${agentLocation(agent)}${RESET}`
      : `${hostSgr(agent.host)}\u2192 ${terminalText(agent.host)}${RESET}  ${DIM}${agentLocation(agent)}${RESET}`,
  ];
  // Three independent facts, each named, visible at once: `activity` is what the
  // pane's process said, `attention` is who is wanted, `freshness` is how
  // recently we reached the node that said either.
  const facts = [
    `activity ${agent.activity ?? "none (attention only)"}`,
    agent.attention.length
      ? `wants    ${agent.attention.map((entry) => entry.kind).join(", ")}`
      : "",
    agent.workstream ? `stream   ${terminalText(agent.workstream)}` : "",
    agent.role ? `role     ${terminalText(agent.role)}` : "",
    agent.pane_title ? `title    ${terminalText(agent.pane_title)}` : "",
    agent.harness ? `harness  ${terminalText(agent.harness)}` : "",
    agent.cli ? `cli      ${terminalText(agent.cli)}` : "",
    agent.blocked_kind ? `needs    ${agent.blocked_kind}` : "",
    agent.resume_command ? `resume   ${terminalText(agent.resume_command)}` : "",
    agent.driver === "orchestrated" ? "driver   orchestrated (crew)" : "",
    // Two ages, never one. A node polled a second ago can be serving a
    // three-hour-old fact, and collapsing them is how that read as fresh.
    agent.updated_at === null ? "" : `said     ${timestamp(agent.updated_at)}`,
    agent.local
      ? ""
      : `fetched  ${agent.fetched_at === null ? "never" : timestamp(agent.fetched_at)}`,
    agent.freshness === "stale" ? `${DIM}host is stale: fields below are last-known${RESET}` : "",
  ].filter(Boolean);

  // The glance is the point of the preview: what the agent is actually doing.
  // No history section, because there is no history -- the store holds current
  // state only, the accepted price of one writer owning each fact.
  // Named, not guessed. The generic message is honest when murmur does not know
  // why a capture failed; when it does know, saying so is the difference between
  // a dead end and an action. Matched on `host`, which `paneViews` sets from
  // `peer.name` -- the name the operator typed, and so the name they can ssh.
  const gatedPeer = agent.local
    ? undefined
    : peers.find((peer) => peer.needs_session && peer.name === agent.host);
  const paneTail = options.paneTailLines ?? PREVIEW_PANE_TAIL_LINES;
  const live = pane?.trimEnd()
    ? [`${DIM}\u2500\u2500 pane \u2500\u2500${RESET}`, tailLines(pane.trimEnd(), paneTail)]
    : [
        `${DIM}\u2500\u2500 pane \u2500\u2500${RESET}`,
        gatedPeer
          ? `${DIM}needs an interactive session \u2014 ${warmSocketCommand(gatedPeer.target)}${RESET}`
          : `${DIM}unavailable (host unreachable, or pane gone)${RESET}`,
      ];

  return [...head, "", ...facts, "", ...live].join("\n");
}
