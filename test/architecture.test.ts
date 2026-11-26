import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

/**
 * Boundaries ARCHITECTURE.md asserts, checked rather than trusted.
 *
 * Each of these was true when written and true when a sweep looked for
 * violations -- and nothing would have failed if it stopped being true. A
 * boundary stated only in prose is a boundary that drifts on the first patch
 * that finds it inconvenient.
 */

function walkSource(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walkSource(path);
    return /\.tsx?$/.test(path) ? [path] : [];
  });
}

function sourceFiles(): string[] {
  return walkSource("src");
}

test("only the store owns SQL", () => {
  // ARCHITECTURE.md § The units: the store is the only module that speaks SQL,
  // which is what makes "one writer per fact" checkable by reading one file.
  // A direct database import anywhere else would have passed the whole suite.
  const offenders = sourceFiles()
    .filter((path) => path !== join("src", "store.ts"))
    .filter((path) => {
      const source = readFileSync(path, "utf8");
      // Import of the driver, or a statement built outside the store. Matched
      // on code shapes rather than the bare words, since the words appear in
      // prose comments across the tree -- collector.ts explains better-sqlite3's
      // synchronous behaviour without using it.
      return (
        /from\s+["']better-sqlite3["']/.test(source) ||
        /\b(?:prepare|exec)\(\s*[`"']\s*(?:SELECT|INSERT|UPDATE|DELETE|CREATE)\b/i.test(source)
      );
    });

  expect(offenders).toEqual([]);
});

test("no source file writes crashed attention outside the store", () => {
  // A `crashed` row of murmur's own is the local read's conclusion: a pane
  // vanished mid-work, which only the store's memory of the last collect can
  // say. Every other crash is the multiplexer's (`pane_dead_status`), mapped
  // in one place. A literal reaching an attention row some other way would be
  // a third, unaccountable writer.
  const offenders = sourceFiles()
    .filter((path) => path !== join("src", "store.ts"))
    .filter((path) => {
      // Comment lines stripped first: a scanner that cannot tell code from
      // prose reports an explanation as the violation.
      const code = readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
        .join("\n");
      return /kind:\s*["']crashed["']/.test(code);
    });

  expect(offenders).toEqual([]);
});

test("only the ansi module decides what escape sequences survive", () => {
  // The dash now consumes arbitrary terminal bytes (`capture-pane -e`), and the
  // allow-list that keeps a preview from painting outside its box is worth
  // exactly as much as its being the ONLY such decision in the tree. A second
  // hand-rolled escape regex somewhere else is how the two drift and one of
  // them stops refusing OSC 52.
  //
  // Two known owners predate the allow-list and are named rather than matched
  // around: `paint.ts` builds its own SGR pattern to measure and clip picker
  // cells, and `dash-mouse.ts` parses the terminal's SGR mouse reports on the
  // way IN. Listing them is what makes a THIRD one fail this test.
  const owners = [join("src", "ansi.ts"), join("src", "paint.ts"), join("src", "dash-mouse.ts")];
  const offenders = sourceFiles()
    .filter((path) => !owners.includes(path))
    .filter((path) => {
      const source = readFileSync(path, "utf8");
      // Prose is excluded by requiring the ESC byte itself, not the word --
      // either spelled in a literal, or constructed. `String.fromCharCode(27)`
      // plus `new RegExp` is how this repo already writes such a pattern (a
      // bare \u001b in a regex trips biome's noControlCharactersInRegex), so a
      // scanner that only looked for regex literals could not see the two
      // hand-rolled ones it exists to find.
      return (
        /\/[^\n/]*(?:\\u001b|\\x1b|\\e)[^\n/]*\/[gimsuy]*/.test(source) ||
        /String\.fromCharCode\(\s*27\s*\)/.test(source) ||
        /new RegExp\([^\n)]*(?:\\u001b|\\x1b|\\e)/.test(source)
      );
    });

  expect(offenders).toEqual([]);
});
