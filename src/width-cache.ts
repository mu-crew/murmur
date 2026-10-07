/**
 * Memoised `visibleWidth` for the dash's compact rows.
 *
 * Every keystroke renders the dash, and every render re-measures each cell of
 * every row; with ~70 panes that was most of the frame's CPU, spent on strings
 * that had not changed. The cache is BOUNDED because the dash is long-lived and
 * the strings it sees (ages, glance lines) churn without end -- ink's own
 * unbounded width cache once grew to 2.3GB. Clearing outright at the cap is
 * cruder than LRU and cheap enough: a refill costs one render's misses.
 */

import { visibleWidth } from "./ansi-width.js";

export const WIDTH_CACHE_LIMIT = 5000;

const cache = new Map<string, number>();

export function cachedWidth(value: string): number {
  const hit = cache.get(value);
  if (hit !== undefined) return hit;
  if (cache.size >= WIDTH_CACHE_LIMIT) cache.clear();
  const width = visibleWidth(value);
  cache.set(value, width);
  return width;
}

/** Test hook: the number of memoised strings. */
export function widthCacheSize(): number {
  return cache.size;
}
