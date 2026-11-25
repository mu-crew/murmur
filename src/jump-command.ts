import { CLIENT_IDENTITY_FORMAT } from "./routing.js";
import type { PaneIdentity, PeerRecord, TmuxServer } from "./types.js";

export const ATTACH_PLACEHOLDER = "{attach}";
export const PANE_PLACEHOLDER = "{pane}";

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function legacyDefaultJumpCommand(target: string): string {
  return `ssh -t ${shellQuote(target)} tmux attach -t ${shellQuote(shellQuote(PANE_PLACEHOLDER))}`;
}

function generatedPaneJumpCommand(target: string): string {
  return `ssh -t ${shellQuote(target)} env LC_CTYPE=C.UTF-8 tmux attach -t ${shellQuote(shellQuote(PANE_PLACEHOLDER))}`;
}

/** Today's remote attach command, represented as an opaque command template. */
export function defaultJumpCommand(target: string): string {
  return `ssh -t ${shellQuote(target)} env LC_CTYPE=C.UTF-8 ${ATTACH_PLACEHOLDER}`;
}

/** Upgrade only murmur's generated defaults; custom commands stay opaque. */
export function currentJumpCommand(template: string, target: string): string {
  return template === legacyDefaultJumpCommand(target) ||
    template === generatedPaneJumpCommand(target)
    ? defaultJumpCommand(target)
    : template;
}

/** Preserve a custom transport while replacing its legacy tmux command. */
export function suggestedJumpCommand(template: string, target: string): string {
  const migrated = template.replace(/(["'])tmux attach -t \{pane\}\1/, ATTACH_PLACEHOLDER);
  return migrated === template ? defaultJumpCommand(target) : migrated;
}

/**
 * `tmux attach` to the pane. Each of `marks` names a server-global option the
 * attaching client records itself in, as `CLIENT_IDENTITY_FORMAT`:
 * commands after `attach` in the same list run as the client that just
 * attached, so only an attach that happened can mark, and only its own client.
 */
export function tmuxAttachCommand(
  { server, pane }: PaneIdentity,
  marks: readonly string[] = [],
): string {
  const selector =
    server.kind === "default"
      ? ""
      : ` ${server.kind === "label" ? "-L" : "-S"} ${shellQuote(server.value)}`;
  const mark = marks
    .map((option) => ` ';' set-option -gF ${option} '${CLIENT_IDENTITY_FORMAT}'`)
    .join("");
  return `tmux${selector} attach -t ${shellQuote(pane)}${mark}`;
}

/** Substitute values into a peer-owned transport without parsing or rewriting it. */
export function renderJumpCommand(
  template: string,
  destination: PaneIdentity,
  marks: readonly string[] = [],
): string {
  // One pass, so a placeholder spelled inside a substituted value (a socket
  // path containing `{pane}`) is never rewritten.
  return template.replaceAll(/\{attach\}|\{pane\}/g, (placeholder) =>
    placeholder === ATTACH_PLACEHOLDER
      ? shellQuote(tmuxAttachCommand(destination, marks))
      : destination.pane,
  );
}

export function supportsServer(template: string, server: TmuxServer): boolean {
  return server.kind === "default" || !template.includes(PANE_PLACEHOLDER);
}

/**
 * A shell command on one line, meaning the same thing: a backslash-newline
 * continuation is a space, any other newline a `;`. The remediation is printed
 * on one stderr line, and joining the lines with a space instead would turn a
 * continuation into `\\ ` and the next line's indent into part of an argument.
 */
function singleLineShell(command: string): string {
  return command
    .replaceAll(/\\\r?\n[ \t]*/g, " ")
    .replaceAll(/[ \t]*\r?\n\s*/g, "; ")
    .trim();
}

/**
 * The refusal for a `{pane}` template and a named-server pane, shared by
 * `murmur jump` and `murmur jump-command` so both name the same fix. `{pane}`
 * is a bare %N, which the remote resolves on its DEFAULT server.
 */
export function unsupportedServerMessage(
  peer: Pick<PeerRecord, "name" | "jump_command">,
  target: string,
  label: string,
  pane: string,
): string {
  const name = /^[\w.-]+$/.test(peer.name) ? peer.name : shellQuote(peer.name);
  const fix = shellQuote(singleLineShell(suggestedJumpCommand(peer.jump_command, target)));
  return (
    `murmur: ${peer.name}'s jump command uses {pane}, which cannot identify the tmux server holding ${label} (${pane})\n\n` +
    `update it:\n  murmur peer set ${name} --jump-command ${fix}`
  );
}
