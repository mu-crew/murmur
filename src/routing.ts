/**
 * Routing identity: what an action must name to reach the right place, and the
 * checks that decline when it cannot be named. A pane id is meaningful only on
 * one tmux server of one host; a tmux client only while the same process
 * holds it. Each check here answers "is this provably that one", never "could
 * it be": a wrong match focuses, moves or kills someone else's thing, a missing
 * one only costs a fast path or a hint. See ARCHITECTURE § A tmux server and
 * pane id are the agent's address.
 *
 * The host half (an ssh argv's effective route) is `connectsToPeer` in
 * attachment.ts.
 */

import type { TmuxServer } from "./types.js";

/**
 * A tmux client, as one value: tty, client process and creation second. The
 * tty is recycled and the second repeats on a fast reconnect -- a wrapper that
 * detached and a human attached on the same terminal shared `name created`, so
 * a retarget moved the human. The pid is unique while the client lives. Every
 * writer and reader of a client marker uses this format, so they compare one
 * string; a marker from an older murmur matches nothing, which declines.
 */
export const CLIENT_IDENTITY_FORMAT = "#{client_name} #{client_pid} #{client_created}";

/**
 * Local session option stamping a jump wrapper with the route it holds: host
 * and remote tmux server. A wrapper's NAME is a readable label, hashed and
 * not injective (labels `Aa` and `BB` collide), so reuse, retarget and kill
 * act only on a session whose stamp is this jump's route.
 */
export const WRAPPER_ROUTE_OPTION = "@murmur_wrapper_route";

export function wrapperRoute(target: { host_id: string; server: TmuxServer }): string {
  const { server } = target;
  const value = server.kind === "default" ? "" : server.value;
  // base64url so no tmux option quoting can alter it on the way back.
  return Buffer.from(JSON.stringify([target.host_id, server.kind, value])).toString("base64url");
}

/** tmux global flags that take no value and do not choose the server. */
const NO_VALUE_FLAGS = /^-[2CDlNuv]+$/;

const flat = (text: string) => text.replaceAll("'\\''", "").replaceAll(/['"\\]/g, "");

/**
 * Whether a local pane's attach argv provably addresses `server`.
 *
 * The argv is `ps` output or a rendered command, quoted zero to several levels
 * deep, so quotes are flattened away and a selector value may hold spaces.
 * tmux reads its global flags in any order (`tmux -u -L x attach`), so the
 * expected `-L`/`-S` selector is found among them and everything else must be
 * a no-value flag. Anything not positively read declines: an unknown flag,
 * `-f`/`-c`/`-T` (whose values cannot be delimited), `-S` beside a label
 * (tmux ignores `-L` then), or more than one `tmux ... attach`.
 */
export function argvAddressesServer(argv: string, server: TmuxServer): boolean {
  const attaches = [
    ...flat(argv).matchAll(/(?:^|[\s/])tmux\s(.*?)\s*\battach(?:-session)?(?=\s|$)/g),
  ];
  // No tmux attach at all (mu's direct recipe runs the agent in the ssh) is
  // not a selector, so it addresses the default server, as tmux would.
  if (attaches.length === 0) return server.kind === "default";
  const [only] = attaches;
  if (!only || attaches.length > 1) return false;
  let globals = ` ${only[1] ?? ""} `;
  if (server.kind !== "default") {
    const flag = server.kind === "label" ? "L" : "S";
    const value = flat(server.value);
    const form = [` -${flag} ${value} `, ` -${flag}${value} `].find((candidate) =>
      globals.includes(candidate),
    );
    if (!form) return false;
    globals = globals.replace(form, " ");
  }
  return globals
    .trim()
    .split(/\s+/)
    .every((word) => word === "" || NO_VALUE_FLAGS.test(word));
}
