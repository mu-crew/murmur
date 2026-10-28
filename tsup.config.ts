import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      cli: "src/cli.ts",
    },
    format: ["esm"],
    dts: {
      entry: { index: "src/index.ts" },
      compilerOptions: { ignoreDeprecations: "6.0" },
    },
    // dist/extension/ belongs to the second config; both build in parallel.
    clean: ["!extension/**"],
    target: "node20",
    esbuildOptions(options) {
      options.jsx = "automatic";
    },
    // Required for the lazy dash import to survive the bundle. With splitting
    // off, esbuild inlines `await import("./dash.js")` back into the single
    // chunk, so ink is statically imported again and every `murmur status` --
    // which the tmux status bar runs on a loop -- pays ~0.22s to load a TUI it
    // never renders. See src/cli/dash-register.ts.
    splitting: true,
    sourcemap: true,
    outDir: "dist",
    shims: false,
  },
  {
    // The pi extension: pi loads dist/extension/murmur-pi.js standalone (the
    // package.json `pi` manifest), so it must not share chunks with the CLI.
    // store.js is its own entry: the extension imports it lazily, so a missing
    // better-sqlite3 fails that import (swallowed) rather than the extension load.
    entry: { "murmur-pi": "extension/murmur-pi.ts", store: "extension/store.ts" },
    format: ["esm"],
    clean: true,
    target: "node20",
    splitting: false,
    sourcemap: true,
    outDir: "dist/extension",
    shims: false,
  },
]);
