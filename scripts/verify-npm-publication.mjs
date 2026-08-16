#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const supportedDistTags = new Set(["latest", "nightly", "canary"]);

function numericComponents(version, distTag) {
  if (!supportedDistTags.has(distTag)) {
    throw new Error(`Unsupported npm dist-tag: ${distTag}.`);
  }
  const escapedTag = distTag.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern =
    distTag === "latest"
      ? /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u
      : new RegExp(
          `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)-${escapedTag}\\.(\\d{8})\\.([1-9]\\d*)$`,
          "u",
        );
  const match = pattern.exec(version);
  if (!match) {
    throw new Error(`npm version ${version} does not belong to dist-tag ${distTag}.`);
  }
  const components = match.slice(1).map(Number);
  if (components.some((value) => !Number.isSafeInteger(value))) {
    throw new Error(`npm version ${version} contains an unsafe numeric component.`);
  }
  return components;
}

export function comparePublicationVersions(left, right, distTag) {
  const leftComponents = numericComponents(left, distTag);
  const rightComponents = numericComponents(right, distTag);
  for (let index = 0; index < leftComponents.length; index += 1) {
    if (leftComponents[index] !== rightComponents[index]) {
      return leftComponents[index] - rightComponents[index];
    }
  }
  return 0;
}

export function assertCandidateAdvances(candidate, current, distTag) {
  if (comparePublicationVersions(candidate, current, distTag) <= 0) {
    throw new Error(
      `Refusing to move npm dist-tag ${distTag} from ${current} backward to ${candidate}.`,
    );
  }
}

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`Missing --${name}.`);
  return value;
}

async function registry() {
  const response = await fetch(`https://registry.npmjs.org/@das-org%2Fdascode?cache=${Date.now()}`, {
    headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}.`);
  return response.json();
}

function matches(document, version, distTag, integrity) {
  const published = document?.versions?.[version];
  if (!published) return false;
  if (published.dist?.integrity !== integrity) throw new Error("Published npm integrity does not match the verified tarball.");
  if (document["dist-tags"]?.[distTag] !== version) throw new Error("npm dist-tag does not point to the verified channel version.");
  return true;
}

function requireForwardPublication(document, version, distTag) {
  const current = document?.["dist-tags"]?.[distTag];
  if (current !== undefined) {
    if (typeof current !== "string") {
      throw new Error(`npm dist-tag ${distTag} has an invalid registry value.`);
    }
    assertCandidateAdvances(version, current, distTag);
  }
}

async function main() {
  const version = option("version");
  const distTag = option("dist-tag");
  const phase = option("phase");
  const bytes = readFileSync(option("tarball"));
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const deadline = Date.now() + (phase === "after" ? 5 * 60_000 : 0);
  do {
    const document = await registry();
    if (document?.versions?.[version]) {
      if (matches(document, version, distTag, integrity)) {
        const output = process.argv.includes("--github-output") ? option("github-output") : undefined;
        if (output) appendFileSync(output, "should_publish=false\n", "utf8");
        process.stdout.write("npm registry integrity and channel dist-tag are verified.\n");
        return;
      }
    } else {
      requireForwardPublication(document, version, distTag);
      if (phase === "before") {
        appendFileSync(option("github-output"), "should_publish=true\n", "utf8");
        process.stdout.write("npm version is unpublished and advances its channel dist-tag.\n");
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  } while (Date.now() < deadline);
  throw new Error("Timed out verifying npm publication in the registry.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
