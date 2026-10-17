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

const README_VERSION_PATTERN = /This README documents \*\*(\d+\.\d+\.\d+)\*\*/u;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
}

/**
 * The README ships inside the package and is its npm page, so it must speak
 * for the version it ships with (GenesisPay #1002): the "This README documents
 * **x.y.z**" header names the package version, every pinned install of the
 * package (`<name>@x.y.z`) uses it, and each range the header says it requires
 * (`` `^x.y.z` ``) is one of the package's `@genesis-tech/*` dependency ranges.
 * Older versions named in "since 1.4.0"-style prose are history and not checked.
 */
export function validateReadmeVersions(manifest, readme) {
  const problems = [];
  const header = readme.match(README_VERSION_PATTERN);
  if (!header) {
    problems.push("has no \"This README documents **x.y.z**\" header");
  } else if (header[1] !== manifest.version) {
    problems.push(`documents ${header[1]}, the package is ${manifest.version}`);
  }

  const pins = new RegExp(`${escapeRegExp(manifest.name)}@(\\d+\\.\\d+\\.\\d+)`, "gu");
  for (const [, pinned] of readme.matchAll(pins)) {
    if (pinned !== manifest.version) problems.push(`pins ${manifest.name}@${pinned}`);
  }

  if (header) {
    const headerParagraph = readme.slice(header.index).split(/\n\s*\n/u)[0];
    const ranges = new Set(
      Object.entries(manifest.dependencies ?? {})
        .filter(([name]) => name.startsWith("@genesis-tech/"))
        .map(([, range]) => range),
    );
    for (const [, range] of headerParagraph.matchAll(/`(\^\d+\.\d+\.\d+)`/gu)) {
      if (!ranges.has(range)) problems.push(`says it requires ${range}, which no @genesis-tech dependency declares`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`${manifest.name}: README.md ${problems.join("; ")}`);
  }
  return { version: manifest.version };
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
    validateReadmeVersions(manifest, readFileSync(resolve(repositoryRoot, "packages", directory, "README.md"), "utf8"));
    console.log(`${manifest.name}@${manifest.version}: ${result.files} files, ${result.targets} declared targets`);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) verifyPackages();
