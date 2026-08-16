#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  filesForRoles,
  validateBundleDirectory,
} from "./lib/release-contract.mjs";

function options(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid option near ${name ?? "<end>"}.`);
    }
    values.set(name.slice(2), value);
  }
  return values;
}

function required(values, name) {
  const value = values.get(name);
  if (!value) throw new Error(`Missing --${name}.`);
  return value;
}

async function main() {
  const args = options(process.argv.slice(2));
  const root = required(args, "bundle-dir");
  const manifest = await validateBundleDirectory(root, {
    requestId: required(args, "request-id"),
    channel: required(args, "channel"),
    sourceRef: required(args, "source-ref"),
    sourceSha: required(args, "source-sha"),
    version: required(args, "version"),
    workerRunId: required(args, "worker-run-id"),
    workerRunAttempt: required(args, "worker-run-attempt"),
    controllerRunId: required(args, "controller-run-id"),
    controllerRunAttempt: required(args, "controller-run-attempt"),
    controllerWorkflowSha: required(args, "controller-workflow-sha"),
    canaryMarkerSha: required(args, "canary-marker-sha") === "null" ? null : required(args, "canary-marker-sha"),
  });
  const npmPath = filesForRoles(manifest, ["npm-package"])[0];
  const webPath = filesForRoles(manifest, ["web-prebuilt"])[0];
  const desktopPaths = filesForRoles(manifest, [
    "desktop-installer",
    "desktop-updater-manifest",
    "desktop-blockmap",
  ]);
  const outputPath = args.get("github-output");
  if (outputPath) {
    const outputs = {
      tag: manifest.release.tag,
      version: manifest.release.version,
      npm_dist_tag: manifest.release.npmDistTag,
      prerelease: String(manifest.release.prerelease),
      make_latest: String(manifest.release.makeLatest),
      hosted_domain: manifest.release.hostedDomain,
      npm_path: npmPath,
      web_path: webPath,
      desktop_paths_json: JSON.stringify(desktopPaths),
    };
    for (const [name, value] of Object.entries(outputs)) {
      appendFileSync(outputPath, `${name}=${value}\n`, "utf8");
    }
  }
  if (args.get("print-desktop-paths") === "true") {
    for (const path of desktopPaths) process.stdout.write(`${join(root, path)}\n`);
  } else {
    process.stdout.write(`Validated ${manifest.release.tag} release bundle.\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
