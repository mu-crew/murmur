import { execFileSync } from "node:child_process";
import { type Harness, harnessFromArgv } from "./harnesses.js";

/**
 * Where a hook event belongs, read from the process table rather than the
 * environment.
 *
 * A harness may start its hooks with a cleared environment, so they see no
 * `$TMUX`, no `$TMUX_PANE` and none of mu's variables. The process
 * chain is the one thing every harness's hook can read: walk parents from the
 * hook up to the tmux server, and the pane root is the ancestor whose parent is
 * the server.
 *
 * Pure over a table, so every rule here is testable with the chains recorded
 * from real harnesses, and one `ps` call per hook is the whole cost.
 */

export type ProcessRow = {
  pid: number;
  ppid: number;
  /** Start time in seconds since the epoch, from `ps -o lstart=`; null when unreadable. */
  started: number | null;
  args: string;
};

export type ProcessTable = ReadonlyMap<number, ProcessRow>;

/**
 * The fixed-width `lstart` column: `Wed Nov  5 10:00:00 2026`, 24 characters
 * under the C locale on macOS and procps alike.
 */
const LSTART = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;

/** Parse `ps -A -o pid=,ppid=,lstart=,args=` output. Rows that do not parse are skipped. */
export function parseProcessTable(output: string): Map<number, ProcessRow> {
  const table = new Map<number, ProcessRow>();
  for (const line of output.split("\n")) {
    const match = LSTART.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const parsed = Date.parse(match[3] ?? "");
    table.set(pid, {
      pid,
      ppid,
      started: Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null,
      args: (match[4] ?? "").trim(),
    });
  }
  return table;
}

/** One `ps` for the whole table, or null when it cannot be read. */
export function readProcessTable(): Map<number, ProcessRow> | null {
  try {
    const output = execFileSync("ps", ["-A", "-o", "pid=,ppid=,lstart=,args="], {
      encoding: "utf8",
      timeout: 3000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      // `lstart` is spelled in the locale; C keeps it parseable.
      env: { ...process.env, LC_ALL: "C" },
    });
    return parseProcessTable(output);
  } catch {
    return null;
  }
}

/**
 * Whether a process is a tmux server, by argv. The server keeps the argv of
 * the client that started it (`tmux new-session -d …`) on macOS, and procps
 * shows `tmux: server (…)` on Linux. A tmux CLIENT never has pane processes
 * under it, so the first tmux ancestor of a pane process is its server.
 */
export function isTmuxServerArgs(args: string): boolean {
  const first = args.trim().split(/\s+/)[0] ?? "";
  const base = first.slice(first.lastIndexOf("/") + 1);
  return base === "tmux" || base === "tmux:";
}

/** The server pid named by `$TMUX` (`socket,pid,session`), or null. */
export function tmuxServerPid(tmuxEnv: string | undefined): number | null {
  const pid = Number(tmuxEnv?.split(",")[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** An anchor mu wrote for a process it started. See `src/anchors.ts`. */
export type AnchorLookup = (process: ProcessRow) => AgentAnchor | null;

export type AgentAnchor = {
  agent_name: string | null;
  workstream: string | null;
  role: string | null;
  cli: string | null;
  orchestrator: boolean;
  remote_key: string | null;
};

export type Placement =
  | {
      kind: "local";
      server_pid: number;
      root_pid: number;
      /** The harness process: the run's member nearest the hook. */
      owner_pid: number;
      harness: Harness;
      anchor: AgentAnchor | null;
    }
  | { kind: "remote"; remote_key: string; owner_pid: number; harness: Harness; anchor: AgentAnchor }
  | { kind: "drop"; reason: "no-process" | "no-harness" | "nested" | "no-server" };

export type PlaceOptions = {
  /** `$TMUX`, when the hook has it: field 2 names the server outright. */
  tmuxEnv?: string | undefined;
  anchor?: AnchorLookup;
};

/** Bound on the walk, against a cycle in a table read mid-fork. */
const MAX_DEPTH = 64;

/**
 * Place an event from the process `self` (the hook) in its pane, or drop it.
 *
 * - The walk ends at the tmux server: the pid `$TMUX` names, else the first
 *   ancestor whose argv is tmux's. The pane root is the ancestor right below it.
 * - Harnesses are matched by argv. An adjacent run of one harness, nothing
 *   between, is ONE harness: a launcher and the binary it starts.
 * - A second, separate harness before the server means the event comes from a
 *   nested agent, and it is dropped. So is a chain with no harness in it.
 * - An anchor with a remote key routes the event to the remote area, never the
 *   inbox, whether or not the chain reaches a tmux server: that pane belongs to
 *   the origin node.
 * - A chain that never reaches a tmux server, with no remote key, is dropped.
 *   claude's detached children, reparented to init, fire `SessionEnd` with
 *   `$TMUX_PANE` still set, and must not land in any pane.
 *
 * The anchor is the first ancestor's whose start time matched (the lookup
 * checks that), searched from the hook upward.
 */
export function placeEvent(
  table: ProcessTable,
  self: number,
  options: PlaceOptions = {},
): Placement {
  const serverHint = tmuxServerPid(options.tmuxEnv);
  let current = table.get(self);
  if (!current) return { kind: "drop", reason: "no-process" };

  let owner: { pid: number; harness: Harness } | null = null;
  // The harness of the run the walk is in, or null when the last process was not one.
  let run: Harness | null = null;
  let anchor: AgentAnchor | null = null;
  let child: ProcessRow | null = null;

  for (let depth = 0; depth < MAX_DEPTH && current; depth += 1) {
    const isServer =
      serverHint !== null ? current.pid === serverHint : isTmuxServerArgs(current.args);
    if (isServer) {
      if (!child) return { kind: "drop", reason: "no-process" };
      if (!owner) return { kind: "drop", reason: "no-harness" };
      if (anchor?.remote_key) return remote(owner, anchor, anchor.remote_key);
      return {
        kind: "local",
        server_pid: current.pid,
        root_pid: child.pid,
        owner_pid: owner.pid,
        harness: owner.harness,
        anchor,
      };
    }
    // The hook process itself is never the harness, whatever its argv says.
    const harness = current.pid === self ? null : harnessFromArgv(current.args);
    if (harness !== null) {
      if (owner === null) owner = { pid: current.pid, harness };
      else if (run !== harness) return { kind: "drop", reason: "nested" };
    }
    run = harness;
    if (anchor === null && options.anchor) anchor = options.anchor(current);
    if (current.pid <= 1 || current.ppid === current.pid) break;
    child = current;
    current = table.get(current.ppid);
  }

  if (owner && anchor?.remote_key) return remote(owner, anchor, anchor.remote_key);
  return { kind: "drop", reason: owner ? "no-server" : "no-harness" };
}

function remote(
  owner: { pid: number; harness: Harness },
  anchor: AgentAnchor,
  key: string,
): Placement {
  return { kind: "remote", remote_key: key, owner_pid: owner.pid, harness: owner.harness, anchor };
}

/** `pid` and every ancestor of it, from the table. */
export function ancestry(table: ProcessTable, pid: number): Set<number> {
  const seen = new Set<number>();
  let current = table.get(pid);
  while (current && !seen.has(current.pid) && seen.size < MAX_DEPTH) {
    seen.add(current.pid);
    if (current.ppid === current.pid) break;
    current = table.get(current.ppid);
  }
  return seen;
}

/**
 * The nearest harness other than pi that `pid` runs inside, below the tmux
 * server `serverPid`: the pid of a claude, codex, cursor-agent or muse among
 * its ancestors, or null.
 *
 * Null too when the walk never reaches that server, so a table read mid-fork
 * or a process outside the server's tree reads as "not nested" -- what a pi
 * claim did before the check existed.
 */
export function outerHarness(table: ProcessTable, pid: number, serverPid: number): number | null {
  let found: number | null = null;
  let current = table.get(pid);
  for (let depth = 0; depth < MAX_DEPTH && current; depth += 1) {
    if (current.pid === serverPid) return found;
    const harness = current.pid === pid ? null : harnessFromArgv(current.args);
    if (found === null && harness !== null && harness !== "pi") found = current.pid;
    if (current.pid <= 1 || current.ppid === current.pid) break;
    current = table.get(current.ppid);
  }
  return null;
}

/**
 * Whether any process at or below `root` is the given harness. The subtree of
 * `except`, when given, is not searched.
 */
export function treeRuns(
  table: ProcessTable,
  root: number,
  harness: Harness,
  except?: number,
): boolean {
  const children = new Map<number, number[]>();
  for (const row of table.values()) {
    const list = children.get(row.ppid);
    if (list) list.push(row.pid);
    else children.set(row.ppid, [row.pid]);
  }
  const pending = [root];
  const seen = new Set<number>();
  while (pending.length > 0) {
    const pid = pending.pop() as number;
    if (seen.has(pid) || pid === except) continue;
    seen.add(pid);
    const row = table.get(pid);
    if (row && harnessFromArgv(row.args) === harness) return true;
    pending.push(...(children.get(pid) ?? []));
  }
  return false;
}

/**
 * The harness a pane runs, found from its root downward: the shallowest
 * harness process at or below `root`, then down its run of same-harness
 * children (a launcher and the binary it starts) to the member a hook would
 * see first. That member is the `owner_pid` `placeEvent` records for the
 * pane's own hooks, so an event written about the pane from outside it
 * (`murmur hook mu --pane`) passes the same owner gate.
 *
 * Null when no harness runs in the pane. A tie at the shallowest depth reads
 * the lowest pid, and a run stops where it forks into two same-harness
 * children.
 */
export function paneHarness(
  table: ProcessTable,
  root: number,
): { pid: number; harness: Harness; top: number } | null {
  const children = childrenOf(table);
  let level = [root];
  const seen = new Set<number>();
  for (let depth = 0; depth < MAX_DEPTH && level.length > 0; depth += 1) {
    const found = level
      .filter((pid) => table.has(pid))
      .sort((left, right) => left - right)
      .map((pid) => ({ pid, harness: harnessFromArgv((table.get(pid) as ProcessRow).args) }))
      .find((entry) => entry.harness !== null);
    if (found?.harness) {
      let pid = found.pid;
      for (let step = 0; step < MAX_DEPTH; step += 1) {
        const same = (children.get(pid) ?? []).filter(
          (child) => harnessFromArgv(table.get(child)?.args ?? "") === found.harness,
        );
        if (same.length !== 1) break;
        pid = same[0] as number;
      }
      return { pid, harness: found.harness, top: found.pid };
    }
    const next: number[] = [];
    for (const pid of level) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      next.push(...(children.get(pid) ?? []));
    }
    level = next;
  }
  return null;
}

/** Each pid's children, in table order. A row that is its own parent is skipped. */
function childrenOf(table: ProcessTable): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const row of table.values()) {
    if (row.pid === row.ppid) continue;
    const list = children.get(row.ppid);
    if (list) list.push(row.pid);
    else children.set(row.ppid, [row.pid]);
  }
  return children;
}

/** Shells, by argv[0] basename; a login shell's leading `-` is dropped first. */
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "mksh", "tcsh", "csh"]);

function isShell(args: string): boolean {
  const argv0 = args.trim().split(/\s+/)[0] ?? "";
  return SHELLS.has(argv0.replace(/^-/, "").split("/").pop() ?? "");
}

/**
 * What a pane with no local harness runs: the shallowest process at or below
 * `root` that is not a shell, the lowest pid on a tie. For an ssh pane that is
 * the session's transport (`ssh`, or whatever the host profile starts), which
 * lives exactly as long as the remote session -- unlike the pane's login
 * shell, which outlives it.
 *
 * Null when the pane holds only shells: nothing in it can stand for an agent.
 */
export function paneProgram(table: ProcessTable, root: number): number | null {
  const children = childrenOf(table);
  let level = [root];
  const seen = new Set<number>();
  for (let depth = 0; depth < MAX_DEPTH && level.length > 0; depth += 1) {
    const found = level
      .filter((pid) => !seen.has(pid) && table.has(pid))
      .sort((left, right) => left - right)
      .find((pid) => !isShell((table.get(pid) as ProcessRow).args));
    if (found !== undefined) return found;
    const next: number[] = [];
    for (const pid of level) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      next.push(...(children.get(pid) ?? []));
    }
    level = next;
  }
  return null;
}
