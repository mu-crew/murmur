import { createRequire } from "node:module";

/**
 * This node's murmur version, read from the manifest.
 *
 * Read rather than restated, because two copies of one fact drift and npm bumps
 * the manifest. Its own module because a bundle may sit at more than one depth
 * below the package root (`dist/index.js` today, a chunk in a subdirectory
 * tomorrow), and one hardcoded `"../package.json"` would throw in the other.
 *
 * Hence both candidates in order, and a throw if neither works: a version this
 * node cannot state belongs in a snapshot even less than a wrong one.
 */
function readVersion(): string {
  const require = createRequire(import.meta.url);
  for (const candidate of ["../package.json", "../../package.json"]) {
    try {
      return (require(candidate) as { version: string }).version;
    } catch {
      // Wrong depth for this bundle; try the next.
    }
  }
  throw new Error("cannot locate package.json to read the murmur version");
}

export const MURMUR_VERSION: string = readVersion();
