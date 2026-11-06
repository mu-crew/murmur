import { expect, test } from "vitest";
import { VERSION } from "../src/index.js";

test("package exports a version", () => {
  // Semver, with an optional pre-release (`2.0.0-next.0`) so an unreleased
  // build's `murmur --version` tells it apart from the release it follows.
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/);
});
