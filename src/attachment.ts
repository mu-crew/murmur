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
  const words = argv.replaceAll("'\\''", "'").replaceAll(/['"]/g, "").trim().split(/\s+/);
  const program = words[0]?.split("/").at(-1) ?? "";
  const options = TRANSPORTS[program];
  if (!options) return null;
  let user: string | null = null;
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (word === "--") return parse(program, words[index + 1], user);
    if (word.startsWith("--")) {
      if (!word.includes("=") && options.long.has(word.slice(2))) index += 1;
      continue;
    }
    if (word.startsWith("-") && word.length > 1) {
      // Clustered flags (`-tt`, `-At`); the first value-taking letter consumes
      // the rest of the word, or the next word when it ends the cluster.
      for (let at = 1; at < word.length; at += 1) {
        if (!options.short.includes(word[at] ?? "")) continue;
        const value = at + 1 < word.length ? word.slice(at + 1) : words[++index];
        if (program === "ssh" && word[at] === "l") user = value ?? null;
        break;
      }
      continue;
    }
    return parse(program, word, user);
  }
  return null;
}

function parse(
  program: string,
  word: string | undefined,
  login: string | null,
): Destination | null {
  if (!word) return null;
  const bare = word.replace(/^ssh:\/\//, "");
  const at = bare.lastIndexOf("@");
  const user = at >= 0 ? bare.slice(0, at) : login;
  let host = at >= 0 ? bare.slice(at + 1) : bare;
  if (word.startsWith("ssh://")) host = host.replace(/:\d+$/, "");
  return host ? { program, host, user } : null;
}

function sameHost(a: Destination, b: Destination): boolean {
  return a.host === b.host && (a.user === null || b.user === null || a.user === b.user);
}

export type AttachPeer = { target: string; jump_command: string };

/**
 * Whether `argv` connects to `peer`: a recognized transport the jump command
 * names, whose destination is the peer's ssh target or the jump command's own
 * destination (an ET template can name a host alias the ssh target does not).
 */
export function connectsToPeer(argv: string, peer: AttachPeer): boolean {
  const here = destination(argv);
  if (!here || !commandNames(peer.jump_command).includes(here.program)) return false;
  const viaTarget = parse("ssh", peer.target, null);
  const viaJump = destination(peer.jump_command);
  return (
    (viaTarget !== null && sameHost(here, viaTarget)) ||
    (viaJump !== null && sameHost(here, viaJump))
  );
}
