/**
 * The Rex local collector: Rex panes, read into the same shape as tmux ones.
 *
 * Rex keeps each terminal block's OSC 7501 records (`program_status`) and
 * OSC 7577 resume records (`program_resume_records`) itself, and knows its
 * program (`process`), so a Rex pane needs nothing from murmur but this read.
 * The whole read is one `rex do` fork running {@link WALK}, a Lua script that
 * walks every session in one server connection.
 *
 * Fail-silent by construction: no `rex` binary, no running Rex server, or any
 * reply murmur cannot read is "no Rex here" (`null`), never an error -- and
 * never evidence that a Rex pane is gone. `--autostart=false`, because a
 * status-bar tick must not start a Rex server.
 */
import { execFile } from "node:child_process";
import { findHelper } from "./helper-path.js";
import { asPaneId, asSessionId, asWindowId } from "./ids.js";
import { chosenPaneTitle, type ObservedPane, programState } from "./local.js";
import {
  BLOCKED_KINDS,
  type BlockedKind,
  DELEGATES_RECORD,
  type Driver,
  FEED_APP,
  isHarnessCli,
  ROLE_RECORD,
} from "./types.js";

/** Rex's panes murmur lists, and every block id Rex holds. */
export type RexRead = { server: { kind: "rex" }; panes: ObservedPane[]; live: Set<string> };

/** A reply murmur cannot read, part way through: the whole read is no evidence. */
class Unreadable extends Error {}

/** One `rex do` of a Lua script, answering its JSON result or null. */
export type RexCall = (script: string) => Promise<unknown>;

/**
 * The walk: every call's result as `{ ok = value }` or `{ err, code }`, so the
 * reader can tell an older Rex lacking a method (`method_not_found`) from a
 * reply it cannot read. A session must be attached before its view and blocks
 * can be read; it is detached again so the walk holds nothing.
 */
export const WALK = `
local function wrap(ok, value, err)
  if not ok then return { err = tostring(value) } end
  if value == nil then
    local e = tostring(err)
    return { err = e, code = string.match(e, "code=([%w_]+)") }
  end
  return { ok = value }
end
local function call(method, input) return wrap(pcall(rex.call, method, input)) end
local out = { server = call("server.status", {}), hosts = call("hosts.list", {}),
  sessions = call("session.list", {}), walked = {} }
if out.sessions.ok then
  for _, s in ipairs(out.sessions.ok.sessions or {}) do
    local id = s.session_id
    local entry = { session_id = id }
    if type(id) == "string" and id ~= "" then
      entry.view = wrap(pcall(rex.session.attach, { session_id = id }))
      if entry.view.ok then
        entry.blocks = call("session.list_blocks", { session_id = id })
        entry.methods = {}
        if entry.blocks.ok then
          for _, b in ipairs(entry.blocks.ok.blocks or {}) do
            if type(b.block_id) == "string" then
              local function m(name)
                return call("block.method", { session_id = id, block_id = b.block_id, method = name })
              end
              entry.methods[b.block_id] = { status = m("program_status"), process = m("process"),
                title = m("title"), resume = m("program_resume_records") }
            end
          end
        end
        pcall(rex.session.detach, { session_id = id })
      end
    end
    table.insert(out.walked, entry)
  end
end
return out
`;

type Json = Record<string, unknown>;
const isJson = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** Whether any record's argv0 basename or name is a known harness. */
const isHarnessProc = (records: unknown[]): boolean =>
  records.some((r) => isJson(r) && (isHarnessCli(str(r.argv0)) || isHarnessCli(str(r.name))));
const str = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;
/**
 * A list, where Lua's JSON writes an empty one as `{}` and Rex leaves a nil
 * slice out. Anything else is {@link Unreadable}: reading it as empty would
 * read every block in it as gone.
 */
const arr = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  if (isJson(value) && Object.keys(value).length === 0) return [];
  throw new Unreadable();
};
const list = (value: unknown, key: string): Json[] =>
  isJson(value) ? arr(value[key]).filter(isJson) : [];

/** The real call: `rex do -e WALK --json`, or null when `rex` is not installed. */
export function rexCli(binary = findHelper("rex")): RexCall | null {
  if (binary === null) return null;
  return (script) =>
    new Promise((resolve) => {
      execFile(
        binary,
        ["--autostart=false", "--timeout", "2s", "do", "-e", script, "--json"],
        { timeout: 5000, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
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

/**
 * A wrapped call's value: the value, `null` for a method this Rex lacks, and
 * {@link Unreadable} for any other failure (a gone block, a timeout).
 */
function value(result: unknown): unknown {
  if (!isJson(result)) throw new Unreadable();
  if ("ok" in result) return result.ok;
  if (result.code === "method_not_found") return null;
  throw new Unreadable();
}

const RESERVED = new Set(
  "if then else elif fi do done case esac while until for in { } ! function select time [[ ]] coproc".split(
    " ",
  ),
);

/** An argv as one POSIX shell line, quoted exactly as vtmux's `#{pane_resume_command}`. */
export function shellCommand(argv: readonly string[]): string {
  return argv
    .map((arg, i) => {
      if (i === 0 && RESERVED.has(arg)) return `'${arg}'`;
      if (arg !== "" && /^[A-Za-z0-9_@%+:,./-]+$/.test(arg)) return arg;
      return `'${arg.replaceAll("'", `'\\''`)}'`;
    })
    .join(" ");
}

/**
 * The resume record that speaks for the block: the chosen one, else the latest
 * reported. Rex lists newest first, so the first of a tie wins.
 */
function resumeRecord(records: readonly Json[]): Json | null {
  const usable = records.filter(
    (record) => Array.isArray(record.command) && record.command.length > 0,
  );
  const chosen = usable.find((record) => record.chosen === true);
  if (chosen) return chosen;
  let latest: Json | null = null;
  for (const record of usable) {
    if (latest === null || String(record.reported_at ?? "") > String(latest.reported_at ?? ""))
      latest = record;
  }
  return latest;
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

/** Rex's name for a window it labelled itself, like tmux's automatic-rename. */
const SYNTHETIC_WINDOW = /^Window [0-9a-f]+$/;
/** Rex's label for a terminal nobody named. */
const GENERIC_BLOCK = "shell";
/** mu's Rex topology: workstream `<ws>` is session `mu-<ws>`, its `_mu` window a plain shell. */
const MU_SESSION = /^mu-(.+)$/;
const MU_PLACEHOLDER = "_mu";

/**
 * Every Rex terminal murmur lists, or null when Rex cannot be asked. A
 * session's blocks or a block's status that cannot be read makes the whole
 * read null: reporting the rest would read that block as gone, and a block
 * gone mid-work is a crash.
 */
export async function readRex(call: RexCall | null = rexCli()): Promise<RexRead | null> {
  if (call === null) return null;
  try {
    const reply = await call(WALK);
    return isJson(reply) ? parseWalk(reply) : null;
  } catch (error) {
    if (error instanceof Unreadable) return null;
    throw error;
  }
}

function parseWalk(reply: Json): RexRead | null {
  if (!isJson(reply.sessions) || !("ok" in reply.sessions)) return null;
  const sessions = reply.sessions.ok;
  if (!isJson(sessions)) return null;
  const server = isJson(reply.server) && isJson(reply.server.ok) ? reply.server.ok : {};
  const serverHost = str(server.host_id);
  const hosts = isJson(reply.hosts) ? list(reply.hosts.ok, "hosts") : [];
  const hostLabel = (hostId: string) =>
    str(hosts.find((host) => host.host_id === hostId)?.label) ?? hostId;
  const walked = new Map(
    arr(reply.walked)
      .filter(isJson)
      .map((entry) => [str(entry.session_id), entry]),
  );

  const live = new Set<string>();
  const panes: ObservedPane[] = [];
  for (const session of list(sessions, "sessions")) {
    const sessionId = str(session.session_id);
    if (sessionId === null) continue;
    const entry = walked.get(sessionId);
    if (!entry) throw new Unreadable();
    const view = value(entry.view);
    const blocksReply = value(entry.blocks);
    if (!isJson(view) || !isJson(blocksReply)) throw new Unreadable();
    const windowNames = new Map(
      list(view.view ?? view, "windows").map((window) => {
        const label = str(window.label);
        return [str(window.window_id), label && !SYNTHETIC_WINDOW.test(label) ? label : null];
      }),
    );
    const sessionName = str(session.label);
    const workstream = sessionName ? (MU_SESSION.exec(sessionName)?.[1] ?? null) : null;
    const methods = isJson(entry.methods) ? entry.methods : {};

    for (const block of list(blocksReply, "blocks")) {
      const blockId = str(block.block_id);
      if (blockId === null) continue;
      live.add(blockId);
      const calls = methods[blockId];
      if (!isJson(calls)) throw new Unreadable();
      const status = value(calls.status);
      const resume = value(calls.resume);
      const titleReply = value(calls.title);
      const proc = isJson(calls.process) && isJson(calls.process.ok) ? calls.process.ok : {};
      if (status !== null && !isJson(status)) throw new Unreadable();
      if (resume !== null && !isJson(resume)) throw new Unreadable();
      const pane = blockPane({
        block,
        sessionId,
        sessionName,
        workstream,
        windowName: windowNames.get(str(block.window_id)) ?? null,
        records: list(status, "records"),
        resume: resumeRecord(list(resume, "records")),
        title: isJson(titleReply) ? str(titleReply.title) : null,
        proc,
        runsOn: (() => {
          const host = str(block.host_id);
          return host && serverHost && host !== serverHost ? hostLabel(host) : null;
        })(),
      });
      if (pane) panes.push(pane);
    }
  }
  return { server: { kind: "rex" }, panes, live };
}

function blockPane(block: {
  block: Json;
  sessionId: string;
  sessionName: string | null;
  workstream: string | null;
  windowName: string | null;
  records: Json[];
  resume: Json | null;
  title: string | null;
  proc: Json;
  runsOn: string | null;
}): ObservedPane | null {
  const { proc, resume } = block;
  const blockId = String(block.block.block_id);
  const label = str(block.block.label);
  // `murmur rex-feed`'s own records are its echo of the fleet; mu's role
  // record is identity, never the pane's state.
  const top = summary(
    block.records.filter(
      (record) =>
        record.app !== FEED_APP && record.effective_app !== FEED_APP && record.id !== ROLE_RECORD,
    ),
  );
  // mu's delegate count shows beside a running agent too, not only when it wins.
  // Only while working (a retained idle/done record is no pending work), and
  // never murmur's own feed echo.
  const delegates =
    block.records.find(
      (record) =>
        record.id === DELEGATES_RECORD &&
        record.state === "working" &&
        record.app !== FEED_APP &&
        record.effective_app !== FEED_APP,
    ) ?? null;
  const agentName =
    block.workstream !== null &&
    label !== null &&
    label !== MU_PLACEHOLDER &&
    label !== GENERIC_BLOCK
      ? label
      : null;
  // The crew role mu's pi reports on Rex (tmux's `@mu_role`), for a mu agent only.
  const roleRecord = block.records.find(
    (record) =>
      record.id === ROLE_RECORD &&
      record.state === "idle" &&
      record.app !== FEED_APP &&
      record.effective_app !== FEED_APP,
  );
  const roleTitle = roleRecord ? str(roleRecord.title) : null;
  const role =
    agentName !== null &&
    (roleTitle === "orchestrator" || roleTitle === "worker" || roleTitle === "delegate")
      ? roleTitle
      : null;
  // Listed like a tmux pane: an OSC 7501 record, a mu agent, or a live OSC 7577
  // record. Rex prunes a resume record once its owner exits, so a plain shell drops off.
  const fg = isJson(proc.foreground) ? proc.foreground : isJson(proc.child) ? proc.child : {};
  const cli = str(fg.argv0)?.split("/").pop() ?? str(fg.name);
  // A foreground known harness is listed idle before it reports anything.
  if (
    top === null &&
    agentName === null &&
    resume === null &&
    !isHarnessProc([proc.foreground, proc.child])
  )
    return null;

  const exit = isJson(proc.last_exit) ? proc.last_exit : null;
  const code = exit && typeof exit.exit_code === "number" ? exit.exit_code : null;
  const dead = !isJson(proc.child) && code !== null && code !== 0;
  const state = programState({
    dead,
    deadStatus: code === null ? null : String(code),
    state: top ? String(top.state) : "",
    id: top ? str(top.id) : null,
  });
  const message = top ? str(top.msg) : null;
  const kind = top ? str(top.kind) : null;
  const at = top ? Date.parse(String(top.updated_at)) : Number.NaN;
  const progress =
    top && typeof top.progress === "number" && top.progress <= 100 ? top.progress : null;
  const driver: Driver = agentName ? "orchestrated" : "human";
  // A mu agent's label is its name; anyone else's label is the pane's own title.
  const shownLabel = agentName === null && label !== GENERIC_BLOCK ? label : null;
  const command = resume ? (resume.command as unknown[]).map(String) : null;
  return {
    server: { kind: "rex" },
    pane: asPaneId(blockId),
    session: asSessionId(block.sessionId),
    window: asWindowId(str(block.block.window_id) ?? block.sessionId),
    session_name: block.sessionName,
    window_name: block.windowName,
    state,
    state_time: Number.isFinite(at) ? at : null,
    agent_name: agentName,
    workstream: agentName ? block.workstream : null,
    role,
    driver,
    harness: top ? (str(top.effective_app) ?? str(top.app)) : null,
    cli,
    pane_title: chosenPaneTitle(shownLabel ?? block.title ?? ""),
    // Rex does not say which session an app shows; `true` would drop alerts.
    focused: false,
    runs_on: block.runsOn,
    dead_status: dead && code !== null ? String(code) : null,
    title: top ? str(top.title) : null,
    message,
    progress,
    blocked_kind:
      state === "blocked" && kind && (BLOCKED_KINDS as readonly string[]).includes(kind)
        ? (kind as BlockedKind)
        : null,
    pending: delegates ? Math.max(1, Number(/\d+/.exec(str(delegates.msg) ?? "")?.[0] ?? 1)) : null,
    resume_command: command ? shellCommand(command) : null,
    resume_cwd: resume ? str(resume.cwd) : null,
    cwd: str(fg.cwd),
    untagged_mu: false,
  };
}
