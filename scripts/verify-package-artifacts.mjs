import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PACKAGE_DIRECTORIES = ["protocol", "seller-sdk", "agent-sdk", "mcp-server"];
const LEGACY_ARTIFACT_PATTERN = /peerpay|peerdirect/i;

function collectPathStrings(value, paths) {
  if (typeof value === "string") {
    paths.add(value.replace(/^\.\//, ""));
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectPathStrings(item, paths);
    return;
  }

  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectPathStrings(item, paths);
  }
}

export function collectPublishTargets(manifest) {
  const targets = new Set();
  collectPathStrings(manifest.exports, targets);
  collectPathStrings(manifest.bin, targets);
  return [...targets];
}

export function readPackMetadata(output, packageName) {
  const parsed = JSON.parse(output);
  if (Array.isArray(parsed)) {
    return parsed.find((item) => item?.name === packageName) ?? parsed[0];
  }

  return parsed[packageName] ?? Object.values(parsed).find((item) => item?.name === packageName);
}

export function validatePackageArtifact(manifest, metadata) {
  if (!metadata || !Array.isArray(metadata.files)) {
    throw new Error(`${manifest.name}: npm pack returned no file manifest`);
  }

  const files = metadata.files.map((file) => file.path);
  const fileSet = new Set(files);
  const missingTargets = collectPublishTargets(manifest).filter((target) => !fileSet.has(target));
  const legacyArtifacts = files.filter((file) => LEGACY_ARTIFACT_PATTERN.test(file));

  if (!files.some((file) => file.startsWith("dist/"))) {
    throw new Error(`${manifest.name}: package contains no compiled dist files`);
  }
  if (missingTargets.length > 0) {
    throw new Error(`${manifest.name}: package is missing declared targets: ${missingTargets.join(", ")}`);
  }
  if (legacyArtifacts.length > 0) {
    throw new Error(`${manifest.name}: package contains legacy artifacts: ${legacyArtifacts.join(", ")}`);
  }

  return { files: files.length, targets: collectPublishTargets(manifest).length };
}

function verifyPackages() {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = resolve(scriptDirectory, "..");

  for (const directory of PACKAGE_DIRECTORIES) {
    const manifest = JSON.parse(
      readFileSync(resolve(repositoryRoot, "packages", directory, "package.json"), "utf8"),
    );
    const packed = spawnSync(
      "npm",
      ["pack", "--workspace", manifest.name, "--dry-run", "--json", "--ignore-scripts"],
      { cwd: repositoryRoot, encoding: "utf8" },
    );

    if (packed.status !== 0) {
      throw new Error(`${manifest.name}: npm pack failed\n${packed.stderr}`);
    }

    const metadata = readPackMetadata(packed.stdout, manifest.name);
    const result = validatePackageArtifact(manifest, metadata);
    console.log(`${manifest.name}@${manifest.version}: ${result.files} files, ${result.targets} declared targets`);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) verifyPackages();
