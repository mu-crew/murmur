/**
 * Reading a hook's payload from stdin, bounded. Shared by `murmur notify` and
 * `murmur hook`.
 */

/** How long `murmur notify` waits for a piped payload before proceeding on flags alone. */
export const STDIN_DEADLINE_MS = 250;

/**
 * Whatever is on stdin, or "" when nothing arrives in time.
 *
 * BOUNDED, as a bug fix rather than caution. `isTTY` catches a notifier run from
 * a terminal but says nothing about a non-TTY stdin that never closes -- an
 * inherited pipe the parent never writes to, the ordinary shape of a plugin host
 * spawning a hook without redirecting stdin. Reading to EOF then waits forever:
 *
 *     sleep 30 | murmur notify --source codex     # hung; exit 124 under timeout
 *
 * A hung hook is a bad failure: it is a child of the agent process, it holds a
 * store handle, a harness that waits on its hook stalls, and its output goes
 * nowhere. The flags suffice for every documented consumer, so the deadline
 * degrades to exactly the flags-only behaviour codex relies on today.
 *
 * Two details stop the deadline becoming a different hang. The `data` listener
 * is removed BY REFERENCE, since a live handler keeps the stream referenced; and
 * the stream is `unref`ed rather than paused, since `pause()` stops the flow but
 * leaves the handle on the event loop -- verified with
 * `process._getActiveHandles()`, which still reported a Socket after a paused
 * read, work done and row written, and the process would not exit. `unref`, not
 * `destroy`: this is declining to wait, not tearing down the parent's pipe.
 */
export async function readStdin(deadlineMs = STDIN_DEADLINE_MS): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  return new Promise<string>((resolve) => {
    const onData = (chunk: Buffer) => chunks.push(chunk);
    const done = () => {
      process.stdin.off("data", onData);
      // Optional because only a PIPE is a Socket. Redirect stdin from a file or
      // /dev/null -- which `sh -lc` does, so it is the codex hook's own path --
      // and `process.stdin` is an fs ReadStream with no `unref`, so calling it
      // unconditionally threw TypeError and took the hook down. Nothing is lost:
      // those reach EOF on their own, and only the endless pipe needed releasing.
      process.stdin.unref?.();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    // Unreffed so the deadline itself cannot be what holds the process open.
    const timer = setTimeout(done, deadlineMs);
    timer.unref?.();
    process.stdin.on("data", onData);
    process.stdin.once("end", () => {
      clearTimeout(timer);
      done();
    });
    process.stdin.once("error", () => {
      clearTimeout(timer);
      done();
    });
  });
}
