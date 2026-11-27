import type { Command } from "commander";
import { loadIdentity, type NodeIdentity } from "../identity.js";
import { asPaneId } from "../ids.js";
import { parseJumpTarget } from "../jump-target.js";
import { deriveTmuxServer } from "../mux.js";
import { openStore, type Store } from "../store.js";
import type { TmuxServer } from "../types.js";

/**
 * Dismiss murmur's own attention for one pane: the `crashed` row it recorded
 * when the pane vanished mid-work.
 *
 * Everything else on a pane is its program's (OSC 7501), and vtmux clears
 * `done` and `error` itself when the pane is focused, so there is nothing
 * else here to clear. One `DELETE` keyed on the pane address: it cannot touch
 * anything but the crash record.
 *
 * Best effort, silent and total: a key binding or a script runs it.
 */
export function clearPane(raw: string, server: TmuxServer): number {
  let store: Store | undefined;
  try {
    if (!raw) return 0;
    store = openStore();
    // argv is the boundary: the pane id arrives as a bare string.
    return store.acknowledgePane({ server, pane: asPaneId(raw) });
  } catch {
    return 0;
  } finally {
    try {
      store?.close();
    } catch {
      // Silent and total.
    }
  }
}

/**
 * Dismiss the crash a `status --json` `jump_target` names: the address a
 * consumer such as tsesh already holds, Rex included. Only this host's crashes:
 * a peer's pane id means nothing here, so another host's token clears nothing.
 */
export function clearTarget(token: string, identity: NodeIdentity | null = loadIdentity()): number {
  const address = parseJumpTarget(token);
  if (!address || !identity || address.host_id !== identity.host_id) return 0;
  return clearPane(address.pane, address.server);
}

/**
 * The server `-L`/`-S`/`--rex` names, else the one `$TMUX` names, else the
 * default server.
 */
export function paneServer(
  options: { socketName?: string; socketPath?: string; rex?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): TmuxServer {
  if (options.rex) return { kind: "rex" };
  if (options.socketName) {
    return options.socketName === "default"
      ? { kind: "default" }
      : { kind: "label", value: options.socketName };
  }
  if (options.socketPath) return deriveTmuxServer(options.socketPath);
  const own = env.TMUX?.split(",")[0];
  if (own) {
    try {
      return deriveTmuxServer(own);
    } catch {
      // An unreadable $TMUX names nothing; fall through.
    }
  }
  return { kind: "default" };
}

export function registerClear(program: Command): void {
  program
    .command("clear")
    .description("Dismiss a crash murmur recorded for a pane")
    .option("--pane <pane-id>", "tmux pane id (or Rex block id with --rex)")
    .option("-L, --socket-name <name>", "tmux server socket name of the pane")
    .option("-S, --socket-path <path>", "tmux server socket path of the pane")
    .option("--rex", "the pane is a Rex block")
    .option("--target <jump-target>", "a status --json jump_target on this host, instead of --pane")
    .action(
      (options: {
        pane?: string;
        socketName?: string;
        socketPath?: string;
        rex?: boolean;
        target?: string;
      }) => {
        if (options.target !== undefined) {
          clearTarget(options.target);
          return;
        }
        clearPane(options.pane ?? "", paneServer(options));
      },
    );
}
