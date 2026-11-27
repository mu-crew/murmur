import { expect, test } from "vitest";
import { isHarnessCli } from "../src/types.js";

test("isHarnessCli normalises the executable name", () => {
  for (const ok of [
    "pi",
    "/bin/claude",
    "pi.real",
    "/x/codex.real",
    "pi.js",
    "codex.mjs",
    "claude.cjs",
  ])
    expect(isHarnessCli(ok)).toBe(true);
  for (const no of ["zsh", "node", "pi.real.bak", "", null, undefined])
    expect(isHarnessCli(no)).toBe(false);
});
