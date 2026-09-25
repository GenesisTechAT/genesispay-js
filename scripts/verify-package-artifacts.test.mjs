import { describe, expect, it } from "vitest";

import {
  collectPublishTargets,
  readPackMetadata,
  validatePackageArtifact,
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
