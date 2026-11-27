import { expect, test } from "vitest";
import { isHarnessCli } from "../src/types.js";

test("isHarnessCli normalises the executable name", () => {
  for (const ok of ["pi", "/bin/claude", "pi.real", "/x/codex.real"])
    expect(isHarnessCli(ok)).toBe(true);
  for (const no of [
    "zsh",
    "node",
    "pi.js",
    "codex.mjs",
    "claude.cjs",
    "pi.real.bak",
    "",
    null,
    undefined,
  ])
    expect(isHarnessCli(no)).toBe(false);
});
