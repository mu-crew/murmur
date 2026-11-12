import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Tracked files carry no term from the local term list (one term per line,
// `#` comments) at $MU_PUBLIC_TERMS, else ~/.config/mu/public-terms.txt.
// Without that file the check passes.

const ROOT = join(import.meta.dirname, "..");

function localTerms(): string[] {
  const file = process.env.MU_PUBLIC_TERMS || join(homedir(), ".config", "mu", "public-terms.txt");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

function scanText(text: string, terms: readonly string[]): string[] {
  const hits: string[] = [];
  for (const [i, line] of text.split("\n").entries()) {
    const lower = line.toLowerCase();
    for (const term of terms) {
      if (lower.includes(term.toLowerCase())) hits.push(`${i + 1}: term ${term}`);
    }
  }
  return hits;
}

function trackedFiles(): string[] | undefined {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
    return out.split("\0").filter((f) => f.length > 0);
  } catch {
    return undefined; // not a git checkout (a tarball): nothing to guard
  }
}

describe("public tree", () => {
  it("scanText flags a listed term, case-insensitively", () => {
    expect(scanText("uses ACME hosts", ["acme"])).toHaveLength(1);
    expect(scanText("uses ACME hosts", [])).toEqual([]);
  });

  it("tracked text files carry no listed term", () => {
    const files = trackedFiles();
    const terms = localTerms();
    if (!files || terms.length === 0) return;
    const failures: string[] = [];
    for (const file of files) {
      let buf: Buffer;
      try {
        buf = readFileSync(join(ROOT, file));
      } catch {
        continue; // deleted in the working tree
      }
      if (buf.includes(0)) continue; // binary
      for (const hit of scanText(buf.toString("utf8"), terms)) failures.push(`${file}:${hit}`);
    }
    expect(failures).toEqual([]);
  });
});
