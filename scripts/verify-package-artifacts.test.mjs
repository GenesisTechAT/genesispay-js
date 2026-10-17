import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  collectPublishTargets,
  readPackMetadata,
  validatePackageArtifact,
  validateReadmeVersions,
} from "./verify-package-artifacts.mjs";

const manifest = {
  name: "@genesis-tech/example",
  exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
  bin: { example: "./dist/cli.js" },
};

const validMetadata = {
  name: manifest.name,
  files: [
    { path: "dist/index.d.ts" },
    { path: "dist/index.js" },
    { path: "dist/cli.js" },
    { path: "README.md" },
  ],
};

describe("verify-package-artifacts", () => {
  it("collects conditional exports and binaries", () => {
    expect(collectPublishTargets(manifest)).toEqual([
      "dist/index.d.ts",
      "dist/index.js",
      "dist/cli.js",
    ]);
  });

  it("reads both npm array and keyed pack metadata", () => {
    expect(readPackMetadata(JSON.stringify([validMetadata]), manifest.name)).toEqual(validMetadata);
    expect(readPackMetadata(JSON.stringify({ [manifest.name]: validMetadata }), manifest.name)).toEqual(
      validMetadata,
    );
  });

  it("accepts an artifact containing every declared runtime target", () => {
    expect(validatePackageArtifact(manifest, validMetadata)).toEqual({ files: 4, targets: 3 });
  });

  it("rejects a package whose compiled output is absent", () => {
    expect(() =>
      validatePackageArtifact(manifest, { name: manifest.name, files: [{ path: "README.md" }] }),
    ).toThrow("contains no compiled dist files");
  });

  it("rejects stale legacy output", () => {
    expect(() =>
      validatePackageArtifact(manifest, {
        ...validMetadata,
        files: [...validMetadata.files, { path: "dist/peerpay-settlement.js" }],
      }),
    ).toThrow("contains legacy artifacts");
  });
});

describe("validateReadmeVersions (#1002)", () => {
  const sdk = {
    name: "@genesis-tech/example",
    version: "1.2.3",
    dependencies: { "@genesis-tech/genesispay-protocol": "^0.7.0", zod: "^4.0.0" },
  };
  const readme = [
    "# @genesis-tech/example",
    "",
    "This README documents **1.2.3**, which requires protocol `^0.7.0`.",
    "",
    "    npm install @genesis-tech/example@1.2.3",
    "",
    "Since 1.0.0 the client retries; zod `^4.0.0` is bundled.",
  ].join("\n");

  it("accepts a README that speaks for the version it ships with", () => {
    expect(validateReadmeVersions(sdk, readme)).toEqual({ version: "1.2.3" });
  });

  it.each([
    ["a stale header", readme.replace("**1.2.3**", "**1.2.2**"), "documents 1.2.2, the package is 1.2.3"],
    ["a stale install pin", readme.replace("example@1.2.3", "example@1.2.2"), "pins @genesis-tech/example@1.2.2"],
    ["a stale required range", readme.replace("`^0.7.0`", "`^0.6.0`"), "requires ^0.6.0"],
    ["no header", readme.replace("This README documents", "This file covers"), "has no"],
  ])("refuses %s", (_label, text, message) => {
    expect(() => validateReadmeVersions(sdk, text)).toThrow(message);
  });
});

// The real READMEs: `packages/` sits next to `scripts/` in the public repo and
// three levels up from this skeleton in the private monorepo.
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packagesDirectory = [resolve(scriptDirectory, "..", "packages"), resolve(scriptDirectory, "../../..", "packages")]
  .find((candidate) => existsSync(resolve(candidate, "protocol", "package.json")));

describe.runIf(packagesDirectory)("every package README names its own version (#1002)", () => {
  it.each(["protocol", "seller-sdk", "agent-sdk", "mcp-server"])("packages/%s", (directory) => {
    const manifest = JSON.parse(readFileSync(resolve(packagesDirectory, directory, "package.json"), "utf8"));
    const readme = readFileSync(resolve(packagesDirectory, directory, "README.md"), "utf8");
    expect(validateReadmeVersions(manifest, readme)).toEqual({ version: manifest.version });
  });
});
