import { clampGlanceScroll } from "./dash-mouse.js";

/**
 * Navigation keys ink delivers merged.
 *
 * When the event loop is busy, ink (7.x `input-parser.js`) hands queued
 * printable keys to `useInput` as ONE string: three fast `j` presses arrive as
 * `"jjj"`. Escape sequences and backspace are split, letters are not. Every
 * binding compares the input exactly, so a merged chunk matched nothing and the
 * presses were lost.
 */

/** The navigation keys of both the dash and the side panel. */
export const NAVIGATION_KEYS = "jkgG";

/**
 * The characters of `input` when it is a merged run of navigation keys, or
 * null when it must be handled as it is: a single key (the normal path), or
 * anything containing another character. Text such as a paste then can never
 * run `q`, `i` or `/`.
 */
export function splitNavigationChunk(input: string, keys: string): string[] | null {
  if (input.length < 2) return null;
  const chars = [...input];
  return chars.every((ch) => keys.includes(ch)) ? chars : null;
}

/**
 * Apply `chars` in order from `start`, one `step` per key, so the result
 * equals pressing them one at a time.
 */
export function foldNavigation(
  chars: readonly string[],
  start: number,
  step: (index: number, ch: string) => number,
): number {
  return chars.reduce(step, start);
}

/**
 * One preview-scroll key, mirroring the single-key path exactly: `g` is the
 * top, `G` is `Number.MAX_SAFE_INTEGER` UNCLAMPED (the pin-to-end sentinel),
 * and `j`/`k` clamp `offset ± 1` into the scrollable range.
 */
export function previewStep(
  offset: number,
  ch: string,
  lineCount: number,
  visible: number,
): number {
  if (ch === "g") return 0;
  if (ch === "G") return Number.MAX_SAFE_INTEGER;
  return clampGlanceScroll(offset + (ch === "j" ? 1 : -1), lineCount, visible);
}
