#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateNpmArchive } from "./lib/release-contract.mjs";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function prepareNpmPublication({ archivePath, version, outputDir }) {
  const absoluteOutput = resolve(outputDir);
  try {
    lstatSync(absoluteOutput);
    throw new Error(`Canonical npm output already exists: ${absoluteOutput}.`);
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
  }

  mkdirSync(absoluteOutput, { mode: 0o700 });
  const extracted = join(absoluteOutput, "extracted");
  const packed = join(absoluteOutput, "packed");
  const extractor = fileURLToPath(new URL("./safe-extract-npm.py", import.meta.url));
  execFileSync("python3", [extractor, resolve(archivePath), extracted], {
    stdio: "inherit",
    timeout: 5 * 60_000,
  });
  mkdirSync(packed, { mode: 0o700 });

  const userConfig = join(absoluteOutput, "user.npmrc");
  const globalConfig = join(absoluteOutput, "global.npmrc");
  writeFileSync(userConfig, "", { mode: 0o600 });
  writeFileSync(globalConfig, "", { mode: 0o600 });
  const isolatedNpmEnvironment = {
    ...process.env,
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    NPM_CONFIG_PROVENANCE: "false",
    NPM_CONFIG_REGISTRY: "https://registry.npmjs.org",
    NPM_CONFIG_USERCONFIG: userConfig,
  };
  const npmVersion = execFileSync("npm", ["--version"], {
    cwd: absoluteOutput,
    encoding: "utf8",
    env: isolatedNpmEnvironment,
  }).trim();
  invariant(npmVersion === "11.16.0", "Canonical npm CLI must be exactly 11.16.0.");
  const output = execFileSync(
    "npm",
    [
      "pack",
      join(extracted, "package"),
      "--pack-destination",
      packed,
      "--ignore-scripts",
      "--json",
      "--registry=https://registry.npmjs.org",
    ],
    {
      encoding: "utf8",
      cwd: absoluteOutput,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 5 * 60_000,
      env: isolatedNpmEnvironment,
    },
  );
  const result = JSON.parse(output);
  const records = Array.isArray(result)
    ? result
    : result !== null && typeof result === "object"
      ? Object.values(result)
      : [];
  invariant(records.length === 1, "npm pack returned an ambiguous result.");
  const filename = records[0]?.filename;
  invariant(
    typeof filename === "string" && basename(filename) === filename && filename.endsWith(".tgz"),
    "npm pack returned an unsafe filename.",
  );
  const canonicalPath = join(packed, filename);
  validateNpmArchive(canonicalPath, version);
  return canonicalPath;
}

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`Missing --${name}.`);
  return value;
}

function main() {
  const path = prepareNpmPublication({
    archivePath: option("archive"),
    version: option("version"),
    outputDir: option("output-dir"),
  });
  appendFileSync(option("github-output"), `path=${path}\n`, "utf8");
  process.stdout.write("Prepared and revalidated a canonical npm publication archive.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
