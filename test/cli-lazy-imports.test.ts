import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { builtArtifact } from "./helpers/built.js";

/**
 * Every module Node loads before `murmur <anything>` runs: the static import
 * closure of `dist/cli.js`. Follows `import ... from "./x.js"` and bare
 * `import "./x.js"`, and deliberately not `import("./x.js")`, which is the
 * lazy path the dash, side panel and picker take. The one exception is a
 * top-level `await import("./x.js")`: `dist/cli.js` loads the program that
 * way after enabling the compile cache, so it runs on every command.
 */
function staticClosure(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (seen.has(file)) continue;
    const source = readFileSync(file, "utf8");
    seen.set(file, source);
    const edges = /^(?:\s*import\s+(?:[^"';()]*?\s+from\s+)?|await import\()["'](\.\/[^"']+)["']/gm;
    for (const match of source.matchAll(edges)) {
      pending.push(join(dirname(file), match[1] as string));
    }
  }
  return seen;
}

function stringWidthImporters(entry: string): string[] {
  const closure = staticClosure(entry);
  // Sanity: the walk really does follow chunk edges, or the assertion is vacuous.
  expect(closure.size).toBeGreaterThan(1);
  return [...closure]
    .filter(([, source]) =>
      /from\s+["']string-width["']|import\s+["']string-width["']/.test(source),
    )
    .map(([file]) => file);
}

test("no module every command loads imports string-width", () => {
  expect(stringWidthImporters(builtArtifact("cli.js"))).toEqual([]);
});

test("the picker does not load string-width for ASCII rows", () => {
  // Loading it was the largest single cost of opening `murmur pick` (~50ms of
  // regex and segmenter construction on a loaded host), for rows that are
  // almost always plain ASCII. `ansi-width.ts` requires it on first non-ASCII
  // text instead, which this static walk deliberately does not follow.
  const chunk = readdirSync(builtArtifact()).find((file) => /^pick-[\w-]+\.js$/.test(file));
  expect(chunk).toBeDefined();
  expect(stringWidthImporters(builtArtifact(chunk as string))).toEqual([]);
});
