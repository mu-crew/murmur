import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { agentLabel } from "./agents.js";
import { DASH_COLOR, DASH_GLYPH, hostColor } from "./dash-paint.js";
import { configDir } from "./paths.js";
import type { Store } from "./store.js";
import type { AttentionKind } from "./types.js";
import type { PaneView } from "./view.js";

/**
 * Push notifications, as a user-supplied executable: `~/.config/murmur/on-attention`.
 *
 * murmur paints state; it does not know whether you want `notify-send`, a
 * phone push or a bell, so it runs one program per new attention event and
 * lets that decide. No config file, no format strings -- the same shape as a
 * git hook.
 *
 * Fired from `collect` and nowhere else, because collect is the one place that
 * sees every node: local rows, freshly pulled peer snapshots, and the `crashed`
 * rows only reconciliation can write. The cost is latency -- an event fires on
 * the next status-bar tick, not the instant it is raised.
 */
export const ALERT_HOOK = "on-attention";

/**
 * How old an event may be and still fire.
 *
 * Bounds the backlog on the first collect after installing the hook, after a
 * store rebuild, or after a long-unreachable peer comes back: those are not
 * news. Compared against the OWNING node's clock, so skew shifts it by minutes
 * at worst.
 */
export const ALERT_WINDOW_MS = 15 * 60_000;

/** How long a claim outlives its event, so a lagging reader cannot re-fire it. */
const RETAIN_MS = 60 * 60_000;

export type AlertEvent = {
  key: string;
  kind: AttentionKind;
  message: string;
  requested_at: number;
  agent: string;
  host: string;
  local: boolean;
  pane: string;
  session_name: string | null;
  window_name: string | null;
  workstream: string | null;
  driver: PaneView["driver"];
  /** The host's accent, as the tmux hostname pill and the dash color it. */
  host_color: string;
  /** The kind's glyph and color, as every murmur surface paints it. */
  glyph: string;
  kind_color: string;
};

/** One event per attention request, keyed so a re-raised request is new. */
export function alertEvents(views: readonly PaneView[]): AlertEvent[] {
  return views.flatMap((view) =>
    view.attention.map((entry) => ({
      key: [
        view.host_id,
        view.server.kind,
        "value" in view.server ? view.server.value : "",
        view.pane,
        entry.kind,
        entry.requested_at,
      ].join("\0"),
      kind: entry.kind,
      message: entry.message,
      requested_at: entry.requested_at,
      agent: agentLabel(view),
      host: view.host,
      local: view.local,
      pane: view.pane,
      session_name: view.session_name,
      window_name: view.window_name,
      workstream: view.workstream,
      driver: view.driver,
      host_color: hostColor(view.host),
      glyph: DASH_GLYPH[entry.kind],
      kind_color: DASH_COLOR[entry.kind],
    })),
  );
}

export type AlertRunner = (hook: string, event: AlertEvent) => void;

/**
 * Run the hook detached, with the event in the environment.
 *
 * Environment rather than stdin: `murmur status` exits as soon as it prints,
 * and a pipe write still in flight then is lost. Output is discarded and the
 * exit code ignored -- a broken hook must not break the status bar.
 */
export const runHook: AlertRunner = (hook, event) => {
  const child = spawn(hook, [], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      MURMUR_KIND: event.kind,
      MURMUR_AGENT: event.agent,
      MURMUR_HOST: event.host,
      MURMUR_LOCAL: event.local ? "1" : "0",
      MURMUR_PANE: event.pane,
      MURMUR_MESSAGE: event.message,
      MURMUR_HOST_COLOR: event.host_color,
      MURMUR_GLYPH: event.glyph,
      MURMUR_KIND_COLOR: event.kind_color,
      MURMUR_EVENT: JSON.stringify(event),
    },
  });
  child.on("error", () => {});
  child.unref();
};

/** The hook path, or null when none is installed or it is not executable. */
export function alertHook(dir = configDir()): string | null {
  const path = join(dir, ALERT_HOOK);
  try {
    accessSync(path, constants.X_OK);
    return path;
  } catch {
    return null;
  }
}

/**
 * Fire the hook once for each attention event not yet alerted. Returns the
 * events fired.
 *
 * Does nothing without a hook, not even a store write, so a node that never
 * opted in pays one `access` per collect.
 */
export function fireAlerts(
  store: Store,
  views: readonly PaneView[],
  now: number,
  hook: string | null = alertHook(),
  run: AlertRunner = runHook,
): AlertEvent[] {
  if (hook === null) return [];
  const events = alertEvents(views);
  const fresh = events.filter((event) => now - event.requested_at <= ALERT_WINDOW_MS);
  const won = new Set(
    store.claimAlerts(
      fresh.map((event) => event.key),
      events.map((event) => event.key),
      now,
      RETAIN_MS,
    ),
  );
  const fired = fresh.filter((event) => won.has(event.key));
  for (const event of fired) {
    try {
      run(hook, event);
    } catch {
      // A hook that cannot start is the user's to notice; murmur stays quiet.
    }
  }
  return fired;
}
