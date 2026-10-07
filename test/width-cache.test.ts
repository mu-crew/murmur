import { expect, test } from "vitest";
import { visibleWidth } from "../src/ansi-width.js";
import { cachedWidth, WIDTH_CACHE_LIMIT, widthCacheSize } from "../src/width-cache.js";

const ESC = "\u001b";

test("cached widths match visibleWidth, on a miss and on a hit", () => {
  for (const value of [
    "",
    "worker-3",
    "エージェント",
    "agent 🚀 ✅",
    `${ESC}[1;32mgreen${ESC}[0m 日本`,
  ]) {
    expect(cachedWidth(value)).toBe(visibleWidth(value));
    expect(cachedWidth(value)).toBe(visibleWidth(value));
  }
});

test("the cache is bounded: reaching the limit evicts", () => {
  for (let i = 0; i <= WIDTH_CACHE_LIMIT; i++) cachedWidth(`evict-${i}`);
  expect(widthCacheSize()).toBeLessThanOrEqual(WIDTH_CACHE_LIMIT);
  expect(widthCacheSize()).toBeLessThan(WIDTH_CACHE_LIMIT / 2);
  expect(cachedWidth(`evict-${WIDTH_CACHE_LIMIT}`)).toBe(
    visibleWidth(`evict-${WIDTH_CACHE_LIMIT}`),
  );
});
