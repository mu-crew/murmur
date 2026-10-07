import { expect, test, vi } from "vitest";

// Node 20.18 has no `require(esm)`: `createRequire(...)("string-width")` throws
// ERR_REQUIRE_ESM there. Stand in for that runtime by making the lazy require
// throw, so the only way `visibleWidth` can measure non-ASCII is the preload.
vi.mock("node:module", () => ({
  createRequire: () => () => {
    throw Object.assign(new Error("require() of ES Module"), { code: "ERR_REQUIRE_ESM" });
  },
}));

test("without require(esm), ensureStringWidth preloads string-width for visibleWidth", async () => {
  const { ensureStringWidth, visibleWidth } = await import("../src/ansi-width.js");
  // The mock is live: before the preload, non-ASCII hits the throwing require.
  expect(() => visibleWidth("\u00e9")).toThrow("require() of ES Module");
  await ensureStringWidth(false);
  expect(visibleWidth("\u00e9")).toBe(1);
  expect(visibleWidth("\u6f22\u5b57")).toBe(4);
});

test("with require(esm), ensureStringWidth leaves the lazy path alone", async () => {
  vi.resetModules();
  const { ensureStringWidth, visibleWidth } = await import("../src/ansi-width.js");
  await ensureStringWidth(true);
  expect(visibleWidth("ascii")).toBe(5);
  expect(() => visibleWidth("\u00e9")).toThrow("require() of ES Module");
});
