/**
 * Width measurement for the surfaces that lay text out in terminal cells: the
 * dash, the side panel and the picker.
 *
 * Split from `ansi.ts` so that nothing else pays for `string-width`, which
 * builds its Unicode regexes at load. `ansi.ts` sits on the static import graph
 * of every `murmur` command (via `view.ts`), and the extra load showed up as
 * ~20-30ms on `murmur status`, `clear` and `--version`, which tmux hooks and
 * status-line pollers run constantly.
 */

import stringWidth from "string-width";
import { isReset, plainText, SGR_RESET, scan } from "./ansi.js";

/**
 * Visible columns, which is the only width any layout here cares about.
 *
 * Measured in TERMINAL CELLS, not code points, and by the same library ink
 * measures with (`string-width`). A code-point count is the same number for
 * Latin text and exactly half the truth for the East Asian and emoji ranges,
 * where one code point occupies two cells -- so a glance line of CJK pane
 * output was clipped to twice the box's width, wrapped, and pushed the frame
 * past the viewport. ink then erased the wrong number of rows and left the
 * previous frame's rows stranded on screen.
 *
 * Sharing ink's measurement is the point: any second opinion about how wide a
 * character is desynchronises this clip from the layout it is clipping for, and
 * the disagreement only ever shows up as corruption on the reader's screen.
 */
export function visibleWidth(value: string): number {
  // `countAnsiEscapeCodes: false` is the default, and the input here is already
  // stripped to text -- but stripping first is what makes the count right for a
  // styled line, since string-width would otherwise measure the SGR bytes.
  return stringWidth(plainText(value));
}

/**
 * Clip to visible columns without ever cutting inside an escape sequence.
 *
 * A byte-index clip did both halves of this wrong: it counted escape bytes
 * toward the width, so a coloured line was clipped far short of the edge, and it
 * could cut mid-sequence -- leaving the terminal holding `ESC [ 3` and
 * swallowing the following text while it waited for a final byte, which blanked
 * the rest of the line.
 *
 * Styles that opened before the cut are kept, because the surviving text must
 * look the way it did in the pane, and a reset is appended when anything is
 * still in force at the edge so the style cannot escape into the dash chrome.
 *
 * Returns the input unchanged when it fits, and ignores a width of zero or less:
 * a narrow terminal must still show something.
 */
export function clipToWidth(value: string, width: number): string {
  if (width <= 0 || visibleWidth(value) <= width) return value;
  let out = "";
  let used = 0;
  let styled = false;
  for (const token of scan(value)) {
    if (token.kind === "sgr") {
      out += token.value;
      styled = !isReset(token.value);
      continue;
    }
    for (const character of token.value) {
      const cells = stringWidth(character);
      // A wide character that would straddle the edge is dropped rather than
      // half-printed: a terminal cannot render half a cell, so emitting it
      // would put one more column on the row than the layout reserved -- the
      // original overflow, reintroduced one character at a time.
      if (used + cells > width) break;
      out += character;
      used += cells;
    }
    if (used >= width) break;
  }
  return styled ? out + SGR_RESET : out;
}
