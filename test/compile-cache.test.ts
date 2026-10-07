import { spawnSync } from "node:child_process";
import module from "node:module";
import { expect, test } from "vitest";
import { builtArtifact } from "./helpers/built.js";

/**
 * `dist/cli.js` turns on Node's module compile cache before it loads the
 * program, so each invocation skips recompiling the bundle. Node before 22.8
 * has no `module.enableCompileCache`, so there is nothing to assert there.
 * Strip the ambient cache variables so a parent NODE_COMPILE_CACHE cannot
 * enable the cache on the CLI's behalf.
 */
test.skipIf(typeof module.enableCompileCache !== "function")(
  "the CLI enables the Node compile cache",
  () => {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_DEBUG_NATIVE: "COMPILE_CACHE" };
    delete env.NODE_DISABLE_COMPILE_CACHE;
    delete env.NODE_COMPILE_CACHE;
    const result = spawnSync(process.execPath, [builtArtifact("cli.js"), "--version"], {
      env,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("[compile cache]");
  },
);
