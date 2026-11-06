import { createHash } from "node:crypto";
import { linkSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir } from "./dirs.js";
import type { InboxEvent, RemoteEvent } from "./inbox-event.js";
import { homeStateDir } from "./paths.js";

/**
 * The write side of the pane inbox and the remote area: one event, one file,
 * appearing whole.
 *
 * Split from the drain (`src/inbox.ts`) so a writer loads nothing it does not
 * need: the hook command, and pi's extension in its store-free mode, which must
 * never pull in the store or a native module.
 */

/** Past this many waiting files a pane's hook stops writing. `doctor` reports it. */
export const INBOX_PANE_CAP = 10_000;

/**
 * `~/.local/state/murmur2/inbox`, under the home directory whatever
 * `XDG_STATE_HOME` says (see `homeStateDir`): Muse's hooks never see that
 * variable, and every writer and reader must name the same directory.
 */
export function inboxDir(): string {
  return join(homeStateDir(), "inbox");
}

/**
 * The directory name for one pane: a hash of the tmux server pid and the pane
 * root pid. Both are what the hook can see; the drain maps them to a pane.
 */
export function inboxKey(serverPid: number, rootPid: number): string {
  return createHash("sha256").update(`${serverPid}:${rootPid}`).digest("hex").slice(0, 32);
}

/** Wall-clock nanoseconds, zero-padded so name order is time order. */
function nanoseconds(): bigint {
  return BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));
}

function eventName(ns: bigint, pid: number): string {
  return `${ns.toString().padStart(20, "0")}-${String(pid).padStart(10, "0")}.json`;
}

/**
 * Write one event into its pane's inbox. Never throws, prints nothing, and
 * answers whether the event landed.
 */
export function writeInboxEvent(
  event: InboxEvent,
  dir = inboxDir(),
  cap = INBOX_PANE_CAP,
): boolean {
  return writeEventFile(dir, "tmp", inboxKey(event.server_pid, event.root_pid), event, cap);
}

/**
 * The remote area: events of workers whose pane is on another node (D11),
 * written here by their hooks and read only by `murmur pane --remote`. Nothing
 * else on this node reads it: the drain, the store and the snapshot never see a
 * remote worker, so the origin node stays the one writer of that pane's row.
 */
export function remoteDir(): string {
  return join(homeStateDir(), "remote");
}

/** Where a writer that died between write and link leaves its file. Dot-named: no key encodes to it. */
export const REMOTE_TMP = ".tmp";

/** An encoded name past this length would not fit a filename with its suffix. */
const REMOTE_NAME_MAX = 240;

/**
 * A remote key as a file name, or null for one that cannot be.
 *
 * Keys are `<origin host>/<origin pane key>`, so they hold a `/` and often a
 * `%`. Percent-encoded, with `.` and the other characters `encodeURIComponent`
 * leaves alone encoded as well, the name is reversible, holds no separator, and
 * can never be `.`, `..`, the tmp directory or end in `.json` or `.lock`.
 */
export function remoteKeyName(key: string): string | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (key === "" || /[\u0000-\u001f\u007f]/.test(key)) return null;
  const name = encodeURIComponent(key).replace(
    /[.!~*'()]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return name.length <= REMOTE_NAME_MAX ? name : null;
}

/** Write one event into its key's remote area. Never throws; answers whether it landed. */
export function writeRemoteEvent(
  event: RemoteEvent,
  dir = remoteDir(),
  cap = INBOX_PANE_CAP,
): boolean {
  const name = remoteKeyName(event.remote_key);
  return name !== null && writeEventFile(dir, REMOTE_TMP, name, event, cap);
}

/**
 * Write one JSON document as the next event file of `dir/<key>/`. Never throws.
 *
 * Written whole under `dir/<tmpName>/`, then LINKED into place: `link` is atomic
 * like `rename`, and unlike it refuses to replace a file, so two events with one
 * name (the same pid in the same nanosecond) cannot overwrite each other -- the
 * second steps its timestamp and tries again.
 */
export function writeEventFile(
  dir: string,
  tmpName: string,
  key: string,
  document: unknown,
  cap = INBOX_PANE_CAP,
): boolean {
  let temporary: string | null = null;
  try {
    const keyDir = join(dir, key);
    const tmp = join(dir, tmpName);
    ensureDir(tmp);
    makeDir(keyDir);
    let waiting = 0;
    try {
      waiting = readdirSync(keyDir).length;
    } catch {
      waiting = 0;
    }
    if (waiting >= cap) return false;
    let ns = nanoseconds();
    const written = join(
      tmp,
      `${eventName(ns, process.pid)}.${Math.random().toString(36).slice(2)}`,
    );
    temporary = written;
    writeFileSync(written, JSON.stringify(document), { flag: "wx" });
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const target = join(keyDir, eventName(ns, process.pid));
      try {
        linkSync(written, target);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST") {
          ns += 1n;
          continue;
        }
        if (!directoryGone(code)) {
          // A filesystem without hard links: rename is still atomic.
          try {
            renameSync(written, target);
            temporary = null;
            return true;
          } catch (renameError) {
            if (!directoryGone((renameError as NodeJS.ErrnoException).code)) throw renameError;
          }
        }
        // A drain removed the directory since the mkdir: it emptied it, or its
        // server died. Recreated, so the event is not lost to a race.
        makeDir(keyDir);
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    if (temporary !== null) {
      try {
        unlinkSync(temporary);
      } catch {
        // Gone already, or renamed into place.
      }
    }
  }
}

/**
 * Whether a link or rename failed because the target directory was removed
 * under it: ENOENT, or EINVAL, which macOS returns for a directory unlinked
 * between the lookup and the link.
 */
function directoryGone(code: string | undefined): boolean {
  return code === "ENOENT" || code === "EINVAL";
}

/** `mkdir` that treats "already there" as success, under a parent that exists. */
function makeDir(path: string): void {
  try {
    mkdirSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}
