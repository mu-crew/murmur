#!/usr/bin/env node
// Static imports load before any statement runs, so the program lives in
// cli-main and is imported only after the compile cache is on. This file's
// static graph stays builtins-only (compile-cache, dirs, paths).
import { join } from "node:path";
import { enableCompileCacheIn } from "./compile-cache.js";
import { stateDir } from "./paths.js";

enableCompileCacheIn(join(stateDir(), "compile-cache"));
await import("./cli-main.js");
