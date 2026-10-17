import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * The official MCP Registry verifies npm ownership by reading `mcpName` from the
 * published package.json of the exact version server.json names. A release
 * that bumps one file without the other cannot be published to the registry.
 */
function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8")) as Record<string, unknown>;
}

describe("MCP Registry listing (server.json)", () => {
  const pkg = readJson("../package.json");
  const server = readJson("../server.json");
  const npmEntry = (server.packages as Array<Record<string, unknown>>).find((entry) => entry.registryType === "npm");

  it("names the server exactly as the package's mcpName", () => {
    expect(server.name).toBe(pkg.mcpName);
  });

  it("lists the npm package at the package's own name and version", () => {
    expect(npmEntry?.identifier).toBe(pkg.name);
    expect(npmEntry?.version).toBe(pkg.version);
    expect(server.version).toBe(pkg.version);
  });

  it("declares the CLI's required environment variables, with the agent key secret", () => {
    const variables = npmEntry?.environmentVariables as Array<{ name: string; isRequired?: boolean; isSecret?: boolean }>;
    expect(variables.map((variable) => variable.name).sort()).toEqual(["GENESISPAY_AGENT_KEY", "GENESISPAY_BASE_URL"]);
    expect(variables.every((variable) => variable.isRequired)).toBe(true);
    expect(variables.find((variable) => variable.name === "GENESISPAY_AGENT_KEY")?.isSecret).toBe(true);
  });
});
