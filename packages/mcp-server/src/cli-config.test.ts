import { GenesisPayAgent } from "@genesis-tech/genesispay-agent";
import { describe, expect, it } from "vitest";

import { agentFromEnvironment } from "./cli-config.js";

const KEY = "gp_ag_test";

describe("agentFromEnvironment (stdio CLI)", () => {
  it("#947: refuses a plain-http GENESISPAY_BASE_URL off this machine before the server starts", () => {
    for (const baseUrl of ["http://genesispay.example", "http://localhost.evil.example"]) {
      expect(() => agentFromEnvironment({ GENESISPAY_AGENT_KEY: KEY, GENESISPAY_BASE_URL: baseUrl })).toThrow(
        /invalid configuration: .*must be https/,
      );
    }
  });

  it("#947: the configuration error the CLI prints to stderr does not echo URL credentials", () => {
    let message = "";
    try {
      agentFromEnvironment({ GENESISPAY_AGENT_KEY: KEY, GENESISPAY_BASE_URL: "http://user:s3cret@genesispay.example?token=t0ken" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/invalid configuration: .*must be https/);
    expect(message).not.toMatch(/s3cret|t0ken|user:/);
    expect(message).not.toContain(KEY);
  });

  function configurationError(env: Record<string, string>): string {
    try {
      agentFromEnvironment(env);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return "";
  }

  it("#976: swapped variables (the agent key in GENESISPAY_BASE_URL) never print the key", () => {
    const agentKey = "gp_ag_swapped_key";
    const message = configurationError({ GENESISPAY_AGENT_KEY: "https://genesispay.example", GENESISPAY_BASE_URL: agentKey });
    expect(message).toMatch(/invalid configuration/);
    expect(message).not.toContain("swapped_key");
    expect(configurationError({ GENESISPAY_AGENT_KEY: KEY, GENESISPAY_BASE_URL: KEY })).not.toContain(KEY);
  });

  it("#976: never prints the configured agent key, whatever its format", () => {
    const agentKey = "unprefixed-agent-secret-976";
    const message = configurationError({
      GENESISPAY_AGENT_KEY: agentKey,
      GENESISPAY_BASE_URL: `http://genesispay.example/${agentKey}`,
    });
    expect(message).toMatch(/invalid configuration/);
    expect(message).not.toContain(agentKey);
  });

  it("#976: an https GENESISPAY_BASE_URL with userinfo is refused without printing it", () => {
    for (const baseUrl of ["https://alice:s3cret@genesispay.example", "http:///alice:s3cret@genesispay.example"]) {
      const message = configurationError({ GENESISPAY_AGENT_KEY: KEY, GENESISPAY_BASE_URL: baseUrl });
      expect(message, baseUrl).toMatch(/invalid configuration/);
      expect(message, baseUrl).not.toMatch(/s3cret|alice/);
      expect(message, baseUrl).not.toContain(KEY);
    }
  });

  it("#947: accepts https and loopback http", () => {
    for (const baseUrl of ["https://genesispay.example", "http://localhost:3000", "http://127.0.0.1:3000"]) {
      expect(agentFromEnvironment({ GENESISPAY_AGENT_KEY: KEY, GENESISPAY_BASE_URL: baseUrl })).toBeInstanceOf(
        GenesisPayAgent,
      );
    }
  });

  it("names both variables when one is missing", () => {
    expect(() => agentFromEnvironment({ GENESISPAY_AGENT_KEY: KEY })).toThrow(/missing configuration[\s\S]*GENESISPAY_BASE_URL/);
    expect(() => agentFromEnvironment({ GENESISPAY_BASE_URL: "https://genesispay.example" })).toThrow(
      /missing configuration[\s\S]*GENESISPAY_AGENT_KEY/,
    );
  });
});
