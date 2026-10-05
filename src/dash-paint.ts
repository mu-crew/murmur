import type { RenderState } from "./view.js";

// The one state vocabulary shared by status, pick and dash. State glyphs are
// classic Nerd Font `nf-fa-*` (Font Awesome 4) codepoints: single cell and
// stable across Nerd Font versions.
export const DASH_GLYPH: Record<RenderState, string> = {
  crashed: "\uf057", // nf-fa-times_circle
  error: "\uf071", // nf-fa-exclamation_triangle
  blocked: "\uf075", // nf-fa-comment
  done: "\uf058", // nf-fa-check_circle
  running: "\uf04b", // nf-fa-play
  waiting: "\uf252", // nf-fa-hourglass_half
  idle: "\uf186", // nf-fa-moon_o
};

export const DASH_COLOR: Record<RenderState, string> = {
  crashed: "#f38ba8",
  error: "#eba0ac",
  blocked: "#fab387",
  done: "#94e2d5",
  running: "#a6adc8",
  waiting: "#74c7ec",
  idle: "#6c7086",
};

export const DASH_CHROME = {
  // Deliberate nf-md exception shared with the tmux agent-attention segment:
  // this robot is clearer than nf-fa-android at status-bar size.
  robot: "\u{f06a9}", // nf-md-robot
  here: "\uf015", // nf-fa-home
  remote: "\uf233", // nf-fa-server
  crew: "\uf0c0", // nf-fa-users
  stale: "\uf017", // nf-fa-clock_o
};

export const DASH_CHROME_COLOR = {
  stale: "#f9e2af",
  furniture: "#6c7086",
  selectedFallback: "#b4befe",
  /** Key chords in the footer / robot in the header. */
  accent: "#cba6f7",
  /** Preference values beside a key. */
  text: "#cdd6f4",
  /** Soft secondary facts in the header (fetched, sort). */
  info: "#89b4fa",
};

/**
 * A host's accent: stable per short hostname, distinct between hosts at a glance.
 *
 * The same hash and palette order as the mu-crew dotfiles' tmux hostname pill
 * (crc32 of the short name, modulo this list), so a host has one color in the
 * status bar, the dash and a notification. Append only: reordering moves every
 * host's color.
 */
export const HOST_COLORS = [
  "#fab387", // peach
  "#89dceb", // sky
  "#cba6f7", // mauve
  "#a6e3a1", // green
  "#f9e2af", // yellow
  "#94e2d5", // teal
  "#f5c2e7", // pink
  "#eba0ac", // maroon
] as const;

/** CRC-32 (IEEE), as Python's `zlib.crc32`. Inline: `node:zlib` has it only from 20.15. */
function crc32(text: string): number {
  let crc = 0xffffffff;
  for (const byte of new TextEncoder().encode(text)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function hostColor(host: string): string {
  const short = host.split(".", 1)[0] ?? host;
  return HOST_COLORS[crc32(short) % HOST_COLORS.length] ?? HOST_COLORS[0];
}
