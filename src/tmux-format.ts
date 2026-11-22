// tmux 3.8 can rewrite control bytes (including tabs) in format output.
// Use printable pipes, and escape both pipe and the escape marker in text fields.
const TMUX_FIELD_SEPARATOR = "|";

export function tmuxFormat(...fields: string[]): string {
  return fields.join(TMUX_FIELD_SEPARATOR);
}

export function tmuxText(field: string): string {
  return `#{s/~/~0/;s/[|]/~1/:${field}}`;
}

export function splitTmuxFields(row: string): string[] {
  return row
    .split(TMUX_FIELD_SEPARATOR)
    .map((field) => field.replace(/~[01]/g, (token) => (token === "~0" ? "~" : "|")));
}
