import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const pkg = JSON.parse(read("package.json"));
const lock = JSON.parse(read("package-lock.json"));

/** Lowest version a node engines range admits, e.g. ">=22.12.0" -> [22, 12]. */
function floor(range: string): [number, number] {
  const m = range.match(/(\d+)(?:\.(\d+))?[^|]*$/);
  return [Number(m?.[1]), Number(m?.[2] ?? 0)];
}

describe("Node runtime floor", () => {
  it("engines admits every runtime dependency's own floor", () => {
    const [major, minor] = floor(pkg.engines.node);
    for (const name of Object.keys(pkg.dependencies)) {
      const range: string | undefined = lock.packages[`node_modules/${name}`]?.engines?.node;
      if (!range) continue;
      const [m, n] = floor(range);
      expect(major * 1000 + minor, `${name} needs ${range}`).toBeGreaterThanOrEqual(m * 1000 + n);
    }
  });

  it("README and the bundle target state the same floor", () => {
    const [major] = floor(pkg.engines.node);
    expect(read("README.md")).toContain(`Node ${major}`);
    expect(read("tsup.config.ts")).not.toMatch(new RegExp(`node(?!${major})\\d+"`));
  });

  it("CI runs the declared floor next to the current Node", () => {
    const [major, minor] = floor(pkg.engines.node);
    const ci = read(".github/workflows/check.yml");
    expect(ci).toContain(`${major}.${minor}`);
    expect(ci).toContain("matrix.node");
  });
});
