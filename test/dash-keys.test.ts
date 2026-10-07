import { expect, test } from "vitest";
import { foldNavigation, splitNavigationChunk } from "../src/dash-keys.js";
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
