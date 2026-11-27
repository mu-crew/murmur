import type { RexCall } from "../../src/rex.js";

/** One fake Rex block: each method's reply, `null` for a reply Rex could not give. */
export type FakeBlock = {
  status: unknown;
  process: unknown;
  label?: string | null;
  title?: unknown;
  resume?: unknown;
  window?: string;
  host_id?: string;
};

export type FakeSession = {
  session_id?: string;
  label?: string;
  windows?: { window_id: string; label: string }[];
  blocks: Record<string, FakeBlock>;
};

const NOT_FOUND = { err: "block not found (status=404 code=not_found)", code: "not_found" };
const wrap = (value: unknown) => (value === null ? NOT_FOUND : { ok: value });
/** Lua's JSON writes an empty list as `{}`, and so does the fake. */
const lua = (items: unknown[]) => (items.length === 0 ? {} : items);

/**
 * A fake `rex do` answering the walk the way Rex does, so a test drives the
 * whole reader through its one seam. `calls` counts the forks.
 */
export function rexWalk(sessions: FakeSession[], server = { host_id: "host-here" }) {
  const calls: string[] = [];
  const call: RexCall = async (script) => {
    calls.push(script);
    return {
      server: { ok: server },
      hosts: { ok: { hosts: lua([{ id: "host:x", label: "me@far", host_id: "host-far" }]) } },
      sessions: {
        ok: { sessions: lua(sessions.map(({ session_id, label }) => ({ session_id, label }))) },
      },
      walked: lua(
        sessions.map((session) => ({
          session_id: session.session_id,
          view: { ok: { client_id: "client:1", view: { windows: lua(session.windows ?? []) } } },
          blocks: {
            ok: {
              blocks: lua(
                Object.entries(session.blocks).map(([id, block]) => ({
                  block_id: id,
                  window_id: block.window ?? "w-1",
                  label: block.label ?? null,
                  host_id: block.host_id ?? server.host_id,
                })),
              ),
            },
          },
          methods: Object.fromEntries(
            Object.entries(session.blocks).map(([id, block]) => [
              id,
              {
                status: wrap(block.status),
                process: wrap(block.process),
                title: "title" in block ? block.title : { ok: { title: "" } },
                resume: "resume" in block ? block.resume : { ok: { records: {} } },
              },
            ]),
          ),
        })),
      ),
    };
  };
  return { call, calls };
}
