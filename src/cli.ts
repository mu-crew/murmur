#!/usr/bin/env node
// Static imports load before any statement runs, so the program lives in
// cli-main and is imported only after the compile cache is on. The optional
// call: Node 20 has no module.enableCompileCache.
import module from "node:module";

module.enableCompileCache?.();
await import("./cli-main.js");
