import { asPaneId, type PaneId } from "./ids.js";
import type { TmuxServer } from "./types.js";

/**
 * The opaque address a consumer hands back to `murmur jump`.
 *
 * A pane id is unique per tmux server on a node, so the whole address is
 * host_id + server + pane. Three values with free-form text in them (a server
 * label may hold spaces) do not travel well as separate argv, so they ride as
 * one token. Consumers must treat it as opaque: only `jumpTarget` and
 * `parseJumpTarget` know the encoding.
 */
const PREFIX = "j1:";

export type JumpAddress = { host_id: string; server: TmuxServer; pane: PaneId };

export function jumpTarget(agent: { host_id: string; server: TmuxServer; pane: PaneId }): string {
  const body = JSON.stringify([agent.host_id, agent.server, agent.pane]);
  return PREFIX + Buffer.from(body, "utf8").toString("base64url");
}

export function parseJumpTarget(token: string): JumpAddress | null {
  if (!token.startsWith(PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(token.slice(PREFIX.length), "base64url").toString("utf8"),
    );
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [host_id, server, pane] = parsed as [unknown, unknown, unknown];
    if (typeof host_id !== "string" || typeof pane !== "string" || !validServer(server)) {
      return null;
    }
    return { host_id, server, pane: asPaneId(pane) };
  } catch {
    return null;
  }
}

function validServer(value: unknown): value is TmuxServer {
  if (typeof value !== "object" || value === null) return false;
  const server = value as { kind?: unknown; value?: unknown };
  if (server.kind === "default" || server.kind === "rex") return true;
  return (server.kind === "label" || server.kind === "path") && typeof server.value === "string";
}
