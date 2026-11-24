/**
 * Whether a local pane's process is connected to a given peer. Shared by the
 * jump hint (`status` crediting `attached_pane`) and the busy-channel
 * diagnosis (`attachmentHoldingPeer`), so the two cannot disagree about which
 * local pane belongs to which host.
 *
 * A pane id, an agent name or a transport name is not evidence of the HOST:
 * two peers can both report `%9`, and any foreground `ssh` matches a jump
 * command that starts with ssh. A wrong match is worse than none -- jump
 * focuses an unrelated local pane, and the busy diagnosis says to close one --
 * so only a destination read from the argv counts, and only for a transport
 * whose argv we know how to read. Anything else declines.
 */

import { execFileSync } from "node:child_process";
import { helperPath } from "./helper-path.js";

/** Program names in a jump command, the gate on which local panes are read. */
export function commandNames(command: string): string[] {
  return [...command.matchAll(/(?:^|[\s'"/])([\w.-]+)(?=$|[\s'"])/g)].flatMap((match) => {
    const name = match[1]?.replace(/^-+/, "");
    return name ? [name] : [];
  });
}

/**
 * Options that take a value, per recognized transport, so the destination is
 * the first operand rather than an option's value. Long options are only read
 * in `--name=value` form unless listed.
 */
const TRANSPORTS: Record<string, { short: string; long: ReadonlySet<string> }> = {
  ssh: { short: "BbcDEeFIiJLlmOoPpQRSWw", long: new Set() },
  et: {
    short: "cprtu",
    long: new Set([
      "command",
      "port",
      "tunnel",
      "reversetunnel",
      "jumphost",
      "jport",
      "ssh-option",
      "terminal-path",
      "serverfifo",
    ]),
  },
  mosh: { short: "p", long: new Set(["ssh", "port", "server", "client", "family", "predict"]) },
};

type Destination = { program: string; host: string; user: string | null };

/**
 * The transport and destination an argv connects to, or null when the program
 * is not one we can read. The argv is `ps` output or a rendered template: quotes
 * are flattened, since only the leading words matter.
 */
function destination(argv: string): Destination | null {
  const words = wordsOf(argv);
  const program = words[0]?.split("/").at(-1) ?? "";
  const options = TRANSPORTS[program];
  if (!options) return null;
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (word === "--") return parse(program, words[index + 1]);
    if (word.startsWith("--")) {
      if (!word.includes("=") && options.long.has(word.slice(2))) index += 1;
      continue;
    }
    if (word.startsWith("-") && word.length > 1) {
      // Clustered flags (`-tt`, `-At`); the first value-taking letter consumes
      // the rest of the word, or the next word when it ends the cluster.
      for (let at = 1; at < word.length; at += 1) {
        if (!options.short.includes(word[at] ?? "")) continue;
        if (at + 1 === word.length) index += 1;
        break;
      }
      continue;
    }
    return parse(program, word);
  }
  return null;
}

function parse(program: string, word: string | undefined): Destination | null {
  if (!word) return null;
  const bare = word.replace(/^ssh:\/\//, "");
  const at = bare.lastIndexOf("@");
  const user = at >= 0 ? bare.slice(0, at) : null;
  let host = at >= 0 ? bare.slice(at + 1) : bare;
  if (word.startsWith("ssh://")) host = host.replace(/:\d+$/, "");
  return host ? { program, host, user } : null;
}

function sameHost(a: Destination, b: Destination): boolean {
  return a.host === b.host && (a.user === null || b.user === null || a.user === b.user);
}

export type AttachPeer = { target: string; jump_command: string };

/** Where ssh actually connects once config and `-o` overrides apply. */
type SshEnd = { host: string; user: string; port: string };

/**
 * Resolve ssh arguments (options, destination, maybe a command) the way ssh
 * itself would, via `ssh -G`. That reads ssh_config and applies `-o`, so
 * `ssh -o HostName=b a` is credited to b, not a. No connection is made.
 * `extra` goes before the arguments; tests pass `-F /dev/null`.
 */
export type SshResolver = (args: readonly string[]) => SshEnd | null;

export function sshResolver(extra: readonly string[] = []): SshResolver {
  // Memoized per resolver: one status pass asks about the same argv and peer
  // target once per candidate row.
  const memo = new Map<string, SshEnd | null>();
  return (args) => {
    const key = args.join("\0");
    const known = memo.get(key);
    if (known !== undefined) return known;
    let end: SshEnd | null = null;
    try {
      const out = execFileSync(helperPath("ssh"), [...extra, "-G", ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2_000,
      });
      const field = (name: string) => out.match(new RegExp(`^${name} (.+)$`, "m"))?.[1];
      const host = field("hostname");
      const user = field("user");
      const port = field("port");
      if (host && user && port) end = { host: host.toLowerCase(), user, port };
    } catch {
      // No ssh, a bad option, a hung `Match exec`: unresolved, so no match.
    }
    memo.set(key, end);
    return end;
  };
}

function wordsOf(argv: string): string[] {
  return argv.replaceAll("'\\''", "'").replaceAll(/['"]/g, "").trim().split(/\s+/);
}

/**
 * Whether `argv` connects to `peer`: a recognized transport the jump command
 * names, whose destination is the peer's ssh target or the jump command's own
 * destination (an ET template can name a host alias the ssh target does not).
 * For ssh the effective destination (host, user, port) is compared, never the
 * operand alone: `-o HostName=`, `-p`, `-l` and ssh_config all reroute it.
 */
export function connectsToPeer(
  argv: string,
  peer: AttachPeer,
  resolve: SshResolver = sshResolver(),
): boolean {
  const here = destination(argv);
  if (!here || !commandNames(peer.jump_command).includes(here.program)) return false;
  if (here.program === "ssh") {
    const end = resolve(wordsOf(argv).slice(1));
    if (!end) return false;
    const same = (other: SshEnd | null) =>
      other !== null &&
      other.host === end.host &&
      other.user === end.user &&
      other.port === end.port;
    const jump = wordsOf(peer.jump_command);
    return (
      same(resolve([peer.target])) ||
      (jump[0]?.split("/").at(-1) === "ssh" && same(resolve(jump.slice(1))))
    );
  }
  const viaTarget = parse("ssh", peer.target);
  const viaJump = destination(peer.jump_command);
  return (
    (viaTarget !== null && sameHost(here, viaTarget)) ||
    (viaJump !== null && sameHost(here, viaJump))
  );
}
