#!/usr/bin/env node

// Credential-free, read-only check of what users can actually fetch after every publish stage:
// the immutable GitHub release against the verified bundle, then the hosted web identity. The npm
// registry is verified by the publish jobs through verify-npm-publication.mjs.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CONTROLLER_REPOSITORY,
  parseSha256Sums,
  releaseAssetNames,
  releaseAssetPaths,
} from "./lib/release-contract.mjs";
import { fetchRead } from "./lib/transient-retry.mjs";
import { verifyHostedMarker } from "./verify-hosted-marker.mjs";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

/** Pure comparison of the published release against the verified bundle. */
export function verifyReleaseAssets({ release, manifest, sumsText }) {
  const expectedTag = manifest.release.tag;
  invariant(release.tag_name === expectedTag, "Published release tag mismatch.");
  invariant(release.draft === false, "Published release is still a draft.");
  invariant(release.immutable === true, "Published release is not immutable.");
  invariant(release.prerelease === manifest.release.prerelease, "Published release prerelease flag mismatch.");

  const sums = parseSha256Sums(sumsText);
  const byBasename = new Map(manifest.files.map((file) => [file.path.split("/").at(-1), file]));
  const expectedNames = releaseAssetNames(releaseAssetPaths("", manifest)).sort();
  const assets = release.assets ?? [];
  const actualNames = assets.map((asset) => asset.name).sort();
  invariant(
    JSON.stringify(actualNames) === JSON.stringify(expectedNames),
    `Published asset list differs from the verified bundle (expected ${expectedNames.length}, found ${actualNames.length}).`,
  );
  const sumsDigest = `sha256:${createHash("sha256").update(sumsText).digest("hex")}`;
  for (const asset of assets) {
    invariant(asset.state === "uploaded", `Asset ${asset.name} is not fully uploaded.`);
    if (asset.name === "SHA256SUMS") {
      invariant(asset.digest === sumsDigest, "Published SHA256SUMS does not match the verified bundle.");
      continue;
    }
    const path = asset.name === "release-manifest.json" ? asset.name : byBasename.get(asset.name)?.path;
    invariant(path && sums.has(path), `Asset ${asset.name} is not listed in SHA256SUMS.`);
    invariant(asset.digest === `sha256:${sums.get(path)}`, `Published digest mismatch for ${asset.name}.`);
    const file = byBasename.get(asset.name);
    if (file) invariant(asset.size === file.size, `Published size mismatch for ${asset.name}.`);
  }
  return expectedNames.length;
}

export async function verifyPublication({ bundleDir, token, fetchImpl, sleep, hostedOptions = {} }) {
  const manifest = JSON.parse(readFileSync(join(bundleDir, "release-manifest.json"), "utf8"));
  const sumsText = readFileSync(join(bundleDir, "SHA256SUMS"), "utf8");
  const response = await fetchRead(
    `https://api.github.com/repos/${CONTROLLER_REPOSITORY}/releases/tags/${encodeURIComponent(manifest.release.tag)}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": "dascode-public-release-controller",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    },
    { fetchImpl, sleep, timeoutMs: 30_000 },
  );
  invariant(response.status === 200, `Published release lookup returned HTTP ${response.status}.`);
  const count = verifyReleaseAssets({ release: await response.json(), manifest, sumsText });

  const identity = {
    channel: manifest.channel,
    version: manifest.release.version,
    sourceSha: manifest.source.sha,
    verificationKey: `${manifest.source.sha}-${manifest.controller.runId}-${manifest.controller.runAttempt}-final`,
    fetchImpl,
    sleep,
    ...hostedOptions,
  };
  const origins = [`https://${manifest.release.hostedDomain}`];
  if (manifest.channel === "stable") origins.push("https://code.bclouder.dev");
  for (const origin of origins) await verifyHostedMarker({ origin, ...identity });
  return { assets: count, origins };
}

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`Missing --${name}.`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyPublication({ bundleDir: option("bundle-dir"), token: process.env.GITHUB_TOKEN })
    .then(({ assets, origins }) => {
      process.stdout.write(`Verified ${assets} published assets and hosted identity at ${origins.join(", ")}.\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
