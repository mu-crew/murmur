import type { Command } from "commander";
import { anchorLookup } from "../anchors.js";
import {
  type HookContext,
  type HookWrite,
  type MuHookTarget,
  muHookEvent,
  muRemoteEvent,
  parseMuHookInput,
  placeHarnessHook,
} from "../hook.js";
import { type HookPayload, hasHookRow } from "../hook-rows.js";
import type { InboxEvent } from "../inbox-event.js";
import { remoteKeyName, writeInboxEvent, writeRemoteEvent } from "../inbox-file.js";
import { paneAddress } from "../mux.js";
import { readProcessTable } from "../process-chain.js";
import type { TmuxServer } from "../types.js";
import { parsePayload } from "./notify.js";
import { paneServer } from "./pane.js";
import { readStdin } from "./stdin.js";

/**
 * `murmur hook <harness>`: what a hook harness runs on each hooked event.
 *
 * One payload on stdin becomes at most one event file in the pane's inbox. It
 * opens no database, takes no lock, calls no tmux and prints nothing, and it
 * exits 0 whatever happens: a hook's exit status and output are the harness's
 * to interpret (claude reads exit 2 from a Stop hook as "block the stop"), and
 * a murmur problem must never cost the agent its turn.
 *
 * `murmur hook mu` is mu's door into the same inbox, and the one form that
 * reports failure: mu is a program that can act on it.
 */

/**
 * How long a harness hook waits for its payload. Longer than `notify`'s: a
 * harness always writes the payload and closes the pipe, and a payload lost to
 * a slow start is a turn murmur never sees. The bound only matters for a pipe
 * that never closes.
 */
const HOOK_STDIN_DEADLINE_MS = 2000;

function context(): HookContext | null {
  const table = readProcessTable();
  if (!table) return null;
  return { table, self: process.pid, env: process.env, anchor: anchorLookup(), now: Date.now() };
}

/** One placed event, written to its pane's inbox or its remote area. Never throws. */
export function writeHookEvent(write: HookWrite): boolean {
  return write.area === "inbox" ? writeInboxEvent(write.event) : writeRemoteEvent(write.event);
}

/** One harness payload, mapped, placed and written. Never throws. */
export function runHarnessHook(name: string, payload: HookPayload): boolean {
  try {
    if (!hasHookRow(name)) return false;
    const found = context();
    if (!found) return false;
    const placed = placeHarnessHook(name, payload, found);
    return placed !== null && writeHookEvent(placed);
  } catch {
    return false;
  }
}

/** The server pid, pane root pid and socket of one pane, from tmux. */
function resolvePane(pane: string, server: TmuxServer): MuHookTarget | string {
  const address = paneAddress(pane, server);
  if (address === null) return `no such pane: ${pane}`;
  const { server_pid, root_pid, socket } = address;
  return { server_pid, root_pid, tmux: `${socket},${server_pid},0`, tmux_pane: pane };
}

/** mu's event, placed and written, or the reason it was not. */
export function runMuHook(
  payload: HookPayload,
  options: {
    pane?: string;
    remote?: string;
    socketName?: string;
    socketPath?: string;
    by?: InboxEvent["by"];
  },
): string | null {
  const input = parseMuHookInput(payload, options.by);
  if (typeof input === "string") return input;
  if (options.remote !== undefined) {
    // A remote worker's key, on the worker's node: no pane here to place it in.
    return writeRemoteEvent(muRemoteEvent(input, options.remote, Date.now()))
      ? null
      : "the event could not be written to the remote area";
  }
  let target: MuHookTarget | null = null;
  if (options.pane !== undefined) {
    const resolved = resolvePane(options.pane, paneServer(options));
    if (typeof resolved === "string") return resolved;
    target = resolved;
  }
  const found = context();
  if (!found) return "could not read the process table";
  const event = muHookEvent(input, found, target);
  if (typeof event === "string") return event;
  return writeInboxEvent(event) ? null : "the event could not be written to the pane's inbox";
}

export function registerHook(program: Command): void {
  program
    .command("hook")
    .description(
      "Record one hook event in the pane's inbox (claude, codex, cursor-agent, muse), or one of mu's (mu)",
    )
    .argument(
      "<harness>",
      "claude, codex, cursor-agent or muse, as a harness hook; mu, for mu's own",
    )
    .argument("[ignored...]", "anything a harness appends")
    .option("--pane <pane>", "mu only: the pane the event is about (default: the pane it runs in)")
    .option("--remote <key>", "mu only: a remote worker's key, on its node, instead of a pane")
    .option("-L, --socket-name <name>", "mu only: tmux server socket name, with --pane")
    .option("-S, --socket-path <path>", "mu only: tmux server socket path, with --pane")
    .option(
      "--by <origin>",
      "mu only: whose event it is, mu (default) or harness: one the harness reported on a remote node, relayed",
    )
    // A flag a harness appends must not make commander print and exit 1 before
    // the action runs: it lands in `ignored`, and only mu is refused for one.
    .allowUnknownOption()
    .action(
      async (
        name: string,
        ignored: string[],
        options: {
          pane?: string;
          remote?: string;
          socketName?: string;
          socketPath?: string;
          by?: string;
        },
      ) => {
        if (name === "mu") {
          const unknown = ignored.find((arg) => arg.startsWith("-"));
          if (unknown !== undefined) {
            process.stderr.write(`murmur: hook mu: unknown option: ${unknown}\n`);
            process.exitCode = 2;
            return;
          }
          const by = options.by ?? "mu";
          if (by !== "mu" && by !== "harness") {
            process.stderr.write(`murmur: hook mu: --by must be mu or harness, not ${by}\n`);
            process.exitCode = 2;
            return;
          }
          if (options.pane !== undefined && !/^%\d+$/.test(options.pane)) {
            process.stderr.write(`murmur: not a tmux pane id: ${options.pane}\n`);
            process.exitCode = 2;
            return;
          }
          if (options.remote !== undefined) {
            if (options.pane !== undefined) {
              process.stderr.write("murmur: hook mu: --pane and --remote are exclusive\n");
              process.exitCode = 2;
              return;
            }
            if (remoteKeyName(options.remote) === null) {
              process.stderr.write(
                `murmur: not a usable remote key: ${JSON.stringify(options.remote)}\n`,
              );
              process.exitCode = 2;
              return;
            }
          }
          const failure = runMuHook(parsePayload(await readStdin(HOOK_STDIN_DEADLINE_MS)), {
            ...options,
            by,
          });
          if (failure !== null) {
            process.stderr.write(`murmur: hook mu: ${failure}\n`);
            process.exitCode = 1;
          }
          return;
        }
        // A harness hook. Exit 0 whatever happens below. cursor-agent's CLI
        // treats empty stdout as a failed hook (`empty_stdout`) and tracking
        // never sticks; reply `{}` like muzzle. Other harnesses stay silent.
        try {
          if (!hasHookRow(name)) return;
          runHarnessHook(name, parsePayload(await readStdin(HOOK_STDIN_DEADLINE_MS)));
        } catch {
          // Nothing to report to: the harness owns this process's output.
        } finally {
          if (name === "cursor-agent") process.stdout.write("{}\n");
        }
      },
    );
}
