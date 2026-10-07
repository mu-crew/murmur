import { expect, test } from "vitest";
import { foldNavigation, previewStep, splitNavigationChunk } from "../src/dash-keys.js";
import { clampGlanceScroll } from "../src/dash-mouse.js";
import { moveIndex } from "../src/dash-tick.js";

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

test("preview: folded Gk equals G then k through the single-key rules", () => {
  const lines = 13;
  const visible = 1;
  // G pins to the end with the unclamped sentinel, as the single-key path does.
  expect(previewStep(4, "G", lines, visible)).toBe(Number.MAX_SAFE_INTEGER);
  // k then clamps from the sentinel.
  const separate = clampGlanceScroll(Number.MAX_SAFE_INTEGER - 1, lines, visible);
  const step = (o: number, ch: string) => previewStep(o, ch, lines, visible);
  expect(foldNavigation(["G", "k"], 4, step)).toBe(separate);
  expect(foldNavigation(["g", "j", "j"], 7, step)).toBe(2);
  expect(foldNavigation(["k"], 0, step)).toBe(0);
});
