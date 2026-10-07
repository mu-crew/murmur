import { expect, test } from "vitest";
import { foldNavigation, previewStep, splitNavigationChunk } from "../src/dash-keys.js";
import { clampGlanceScroll } from "../src/dash-mouse.js";
import { dashNavigation, moveIndex } from "../src/dash-tick.js";

const NAV = "jkgG";

test("splits a merged chunk of navigation keys", () => {
  expect(splitNavigationChunk("jj", NAV)).toEqual(["j", "j"]);
  expect(splitNavigationChunk("jjk", NAV)).toEqual(["j", "j", "k"]);
  expect(splitNavigationChunk("gG", NAV)).toEqual(["g", "G"]);
});

test("leaves single keys, mixed text and escape sequences alone", () => {
  expect(splitNavigationChunk("j", NAV)).toBeNull();
  expect(splitNavigationChunk("jq", NAV)).toBeNull();
  expect(splitNavigationChunk("/j", NAV)).toBeNull();
  expect(splitNavigationChunk("\x1b[B", NAV)).toBeNull();
  expect(splitNavigationChunk("j\x1b", NAV)).toBeNull();
  expect(splitNavigationChunk("", NAV)).toBeNull();
});

function cardStep(total: number) {
  return (i: number, ch: string) =>
    ch === "g" ? 0 : ch === "G" ? total - 1 : moveIndex(i, ch === "j" ? 1 : -1, total, "clamp");
}

test("folding equals pressing the keys one at a time", () => {
  const step = cardStep(10);
  for (const start of [0, 4, 9]) expect(foldNavigation(["g", "j", "j"], start, step)).toBe(2);
  expect(foldNavigation(["k", "j"], 0, step)).toBe(1);
  expect(foldNavigation(["G", "k"], 3, step)).toBe(8);
  expect(foldNavigation(["j", "j", "j"], 8, step)).toBe(9);
});

// The single-key path in dash.tsx: dashNavigation, then clamp or pin to an edge.
// Kept independent of previewStep so the table checks previewStep against it.
function singleKeyPreview(offset: number, ch: string, lines: number, visible: number): number {
  const navKey = ch === "j" ? "down" : ch === "k" ? "up" : ch === "g" ? "home" : "end";
  const navigation = dashNavigation("preview", navKey, 1, visible);
  if (navigation.type === "preview-edge") {
    return navigation.edge === "top" ? 0 : Number.MAX_SAFE_INTEGER;
  }
  if (navigation.type !== "preview") throw new Error(`unexpected ${navigation.type}`);
  return clampGlanceScroll(offset + navigation.offset, lines, visible);
}

test.each(["Gk", "gj", "jG", "gjj", "kG"])(
  "preview: folded %s equals the single-key rules one at a time",
  (keys) => {
    const lines = 13;
    const visible = 1;
    const chunk = splitNavigationChunk(keys, NAV);
    expect(chunk).toEqual([...keys]);
    for (const start of [0, 4, 7, 12]) {
      const folded = foldNavigation(chunk ?? [], start, (o, ch) =>
        previewStep(o, ch, lines, visible),
      );
      const separate = [...keys].reduce((o, ch) => singleKeyPreview(o, ch, lines, visible), start);
      expect(folded).toBe(separate);
      expect(clampGlanceScroll(folded, lines, visible)).toBe(
        clampGlanceScroll(separate, lines, visible),
      );
    }
  },
);
