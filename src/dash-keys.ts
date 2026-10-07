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
