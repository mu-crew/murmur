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

import { createRequire } from "node:module";
import { isReset, plainText, SGR_RESET, scan } from "./ansi.js";

type StringWidth = typeof import("string-width").default;

let loadedStringWidth: StringWidth | undefined;

/**
 * Text that is one cell per code point without asking: printable ASCII, plus
 * the narrow symbols murmur's own rows carry (`◆` current pane, `→` remote host,
 * `…` truncation, `·` and `—` separators). Without those, any fleet with a peer
 * would load the library on its first remote row.
 */
const SINGLE_CELL = /^[ -~\u00b7\u2014\u2026\u2192\u25c6]*$/;

/**
 * Cell width of plain text, loading `string-width` only for text that needs it.
 *
 * `string-width` builds `\p{RGI_Emoji}` and an `Intl.Segmenter` when it loads,
 * which measured ~50ms on a loaded host -- the largest single cost of opening
 * `murmur pick`, whose rows are almost always plain ASCII. Those characters are
 * one cell each in string-width too (a test pins the agreement), so that case
 * is answered here and the library is required on the first string
 * that holds anything else. That `require` of an ES module needs
 * `require(esm)` (Node >=20.19 / >=22.12); on older Nodes `ensureStringWidth`
 * has already loaded the library, so the `require` is never reached.
 */
function cells(text: string): number {
  if (SINGLE_CELL.test(text)) return text.length;
  loadedStringWidth ??= (createRequire(import.meta.url)("string-width") as { default: StringWidth })
    .default;
  return loadedStringWidth(text);
}

/**
 * Preload `string-width` where `cells` could not `require` it.
 *
 * `package.json` advertises Node >=20, but synchronous `require` of an ES
 * module only works where `process.features.require_module` is set; on Node
 * 20.18 it throws `ERR_REQUIRE_ESM` on the first non-ASCII cell. The dash, side
 * panel and picker await this before they measure anything, so older Nodes pay
 * the load up front and modern ones keep the lazy, usually-skipped path.
 */
export async function ensureStringWidth(
  requireModule: boolean | undefined = process.features.require_module,
): Promise<void> {
  if (requireModule || loadedStringWidth) return;
  loadedStringWidth = (await import("string-width")).default;
}

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
  return cells(plainText(value));
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
      const size = cells(character);
      // A wide character that would straddle the edge is dropped rather than
      // half-printed: a terminal cannot render half a cell, so emitting it
      // would put one more column on the row than the layout reserved -- the
      // original overflow, reintroduced one character at a time.
      if (used + size > width) break;
      out += character;
      used += size;
    }
    if (used >= width) break;
  }
  return styled ? out + SGR_RESET : out;
}
