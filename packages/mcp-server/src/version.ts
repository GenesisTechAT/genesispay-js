import { createRequire } from "node:module";

/**
 * The version this server reports in the MCP `initialize` handshake, read from
 * the package manifest so it can never drift from what npm installed.
 *
 * `createRequire` rather than a JSON import: `package.json` sits outside the
 * `rootDir` of `tsc -b`, and the relative path resolves identically from
 * `src/` (tests) and `dist/` (the published build), both one level below the
 * manifest. npm always ships `package.json`, whatever `files` lists.
 */
function readPackageVersion(): string {
  const require = createRequire(import.meta.url);
  const manifest: unknown = require("../package.json");

  if (
    typeof manifest === "object" &&
    manifest !== null &&
    "version" in manifest &&
    typeof manifest.version === "string" &&
    manifest.version.length > 0
  ) {
    return manifest.version;
  }

  throw new Error("genesispay-mcp: package.json carries no version.");
}

export const GENESISPAY_MCP_VERSION = readPackageVersion();
