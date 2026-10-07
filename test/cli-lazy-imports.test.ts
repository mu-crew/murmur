import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { builtArtifact } from "./helpers/built.js";

/**
 * Every module Node loads before `murmur <anything>` runs: the static import
 * closure of `dist/cli.js`. Follows `import ... from "./x.js"` and bare
 * `import "./x.js"`, and deliberately not `import("./x.js")`, which is the
 * lazy path the dash, side panel and picker take.
 */
function staticClosure(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (seen.has(file)) continue;
    const source = readFileSync(file, "utf8");
    seen.set(file, source);
    const edges = /^\s*import\s+(?:[^"';()]*?\s+from\s+)?["'](\.\/[^"']+)["']/gm;
    for (const match of source.matchAll(edges)) {
      pending.push(join(dirname(file), match[1] as string));
    }
  }
  return seen;
}

test("no module every command loads imports string-width", () => {
  const closure = staticClosure(builtArtifact("cli.js"));
  // Sanity: the walk really does follow chunk edges, or the assertion is vacuous.
  expect(closure.size).toBeGreaterThan(1);
  const offenders = [...closure]
    .filter(([, source]) =>
      /from\s+["']string-width["']|import\s+["']string-width["']/.test(source),
    )
    .map(([file]) => file);
  expect(offenders).toEqual([]);
});
