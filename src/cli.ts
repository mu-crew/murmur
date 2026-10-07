#!/usr/bin/env node
// Static imports load before any statement runs, so the program lives in
// cli-main and is imported only after the compile cache is on. The optional
// call: Node before 22.8 has no module.enableCompileCache.
import module from "node:module";

module.enableCompileCache?.();
await import("./cli-main.js");
