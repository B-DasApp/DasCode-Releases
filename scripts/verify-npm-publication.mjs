#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const supportedDistTags = new Set(["latest", "nightly"]);
const packageName = "@das-org/dascode";
const encodedPackageName = "@das-org%2Fdascode";
const registryBaseUrl = "https://registry.npmjs.org";
// npm accepts a trusted publish before every public read path has observed it.
// Keep the verification bounded while allowing the version and tag views to
// converge independently.
const publicationVerificationTimeoutMs = 15 * 60_000;
const prepublicationVerificationTimeoutMs = 30_000;
const registryRequestTimeoutMs = 15_000;
const retryIntervalMs = 5_000;

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

export class TransientRegistryError extends Error {
  constructor(message, retryAfterMs = 0) {
    super(message);
    this.name = "TransientRegistryError";
    this.retryAfterMs = retryAfterMs;
  }
}

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`Missing --${name}.`);
  return value;
}

function parseRetryAfter(value, now) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now()) : 0;
}

async function fetchRegistryJson(label, url, { fetchImpl, now, timeoutMs }) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new TransientRegistryError(`${label} request timed out or failed.`);
  }
  if (response.status === 404) return undefined;
  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    throw new TransientRegistryError(
      `${label} request returned HTTP ${response.status}.`,
      parseRetryAfter(response.headers.get("retry-after"), now),
    );
  }
  if (!response.ok) {
    throw new Error(`${label} request returned HTTP ${response.status}.`);
  }
  try {
    return await response.json();
  } catch {
    throw new TransientRegistryError(`${label} response was not valid JSON.`);
  }
}

export function createRegistryReader({
  fetchImpl = fetch,
  now = Date.now,
  baseUrl = registryBaseUrl,
} = {}) {
  return async function readRegistry(version, timeoutMs = registryRequestTimeoutMs) {
    const versionUrl = new URL(
      `${encodedPackageName}/${encodeURIComponent(version)}`,
      `${baseUrl}/`,
    );
    const tagsUrl = new URL(`-/package/${encodedPackageName}/dist-tags`, `${baseUrl}/`);
    // npm-registry-fetch documents write=true reads as cache-revalidated. These
    // are still unauthenticated GETs and never mutate registry state.
    versionUrl.searchParams.set("write", "true");
    tagsUrl.searchParams.set("write", "true");
    const [metadata, distTags] = await Promise.all([
      fetchRegistryJson("npm version metadata", versionUrl, {
        fetchImpl,
        now,
        timeoutMs,
      }),
      fetchRegistryJson("npm dist-tags", tagsUrl, { fetchImpl, now, timeoutMs }),
    ]);
    return { metadata, distTags };
  };
}

function currentDistTag(distTags, distTag) {
  if (distTags === undefined) return undefined;
  if (!distTags || typeof distTags !== "object" || Array.isArray(distTags)) {
    throw new Error("npm registry returned invalid dist-tag metadata.");
  }
  const current = distTags[distTag];
  if (current !== undefined && typeof current !== "string") {
    throw new Error(`npm dist-tag ${distTag} has an invalid registry value.`);
  }
  return current;
}

function assertIntegrity(metadata, version, integrity) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("npm registry returned invalid version metadata.");
  }
  if (metadata.name !== packageName || metadata.version !== version) {
    throw new Error("npm registry returned metadata for an unexpected package version.");
  }
  if (metadata.dist?.integrity !== integrity) {
    throw new Error("Published npm integrity does not match the verified tarball.");
  }
}

function evaluateSnapshot({ metadata, distTags }, { phase, version, distTag, integrity }) {
  const current = currentDistTag(distTags, distTag);
  if (current !== undefined && current !== version) {
    assertCandidateAdvances(version, current, distTag);
  }

  if (metadata !== undefined) {
    assertIntegrity(metadata, version, integrity);
    if (current === version) return { status: "verified", shouldPublish: false };
    if (phase === "after") {
      return {
        status: "pending",
        reason:
          current === undefined
            ? `version ${version} is visible but dist-tag ${distTag} is not yet visible`
            : `version ${version} is visible but dist-tag ${distTag} still points to ${current}`,
      };
    }
    throw new Error("npm dist-tag does not point to the verified channel version.");
  }

  if (phase === "before") {
    if (current === version) {
      throw new Error(
        `npm dist-tag ${distTag} points to ${version}, but that version's metadata is unavailable.`,
      );
    }
    return { status: "verified", shouldPublish: true };
  }

  return {
    status: "pending",
    reason:
      current === version
        ? `dist-tag ${distTag} points to ${version}, but its version metadata is not yet visible`
        : `version ${version} metadata is not yet visible`,
  };
}

function elapsedLabel(elapsedMs) {
  return `${(elapsedMs / 1_000).toFixed(1)}s`;
}

export async function verifyNpmPublication({
  phase,
  version,
  distTag,
  integrity,
  readRegistry = createRegistryReader(),
  now = Date.now,
  sleep = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)),
  log = (message) => process.stdout.write(`${message}\n`),
  timeoutMs =
    phase === "after"
      ? publicationVerificationTimeoutMs
      : prepublicationVerificationTimeoutMs,
  intervalMs = retryIntervalMs,
  requestTimeoutMs = registryRequestTimeoutMs,
}) {
  if (phase !== "before" && phase !== "after") {
    throw new Error(`Unsupported npm verification phase: ${phase}.`);
  }
  numericComponents(version, distTag);
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let attempt = 0;
  let lastPendingReason = "registry state has not been checked";

  while (true) {
    const remainingBeforeRequest = deadline - now();
    if (attempt > 0 && remainingBeforeRequest <= 0) {
      throw new Error(
        `Timed out verifying npm publication after ${elapsedLabel(now() - startedAt)} and ${attempt} attempts; last pending reason: ${lastPendingReason}.`,
      );
    }
    attempt += 1;
    let result;
    let retryAfterMs = 0;
    try {
      const snapshot = await readRegistry(
        version,
        Math.min(requestTimeoutMs, Math.max(1, remainingBeforeRequest)),
      );
      result = evaluateSnapshot(snapshot, { phase, version, distTag, integrity });
    } catch (error) {
      if (!(error instanceof TransientRegistryError)) throw error;
      lastPendingReason = error.message;
      retryAfterMs = error.retryAfterMs;
      result = { status: "pending", reason: lastPendingReason };
    }

    const elapsedMs = Math.max(0, now() - startedAt);
    if (result.status === "verified") {
      log(
        `npm publication verification attempt ${attempt} succeeded after ${elapsedLabel(elapsedMs)}.`,
      );
      return { shouldPublish: result.shouldPublish, attempts: attempt, elapsedMs };
    }

    lastPendingReason = result.reason;
    log(
      `npm publication verification attempt ${attempt} after ${elapsedLabel(elapsedMs)} is pending: ${lastPendingReason}.`,
    );
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new Error(
        `Timed out verifying npm publication after ${elapsedLabel(now() - startedAt)} and ${attempt} attempts; last pending reason: ${lastPendingReason}.`,
      );
    }
    await sleep(Math.min(remaining, Math.max(intervalMs, retryAfterMs)));
  }
}

async function main() {
  const version = option("version");
  const distTag = option("dist-tag");
  const phase = option("phase");
  const bytes = readFileSync(option("tarball"));
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const result = await verifyNpmPublication({ phase, version, distTag, integrity });
  if (phase === "before") {
    appendFileSync(
      option("github-output"),
      `should_publish=${String(result.shouldPublish)}\n`,
      "utf8",
    );
  }
  process.stdout.write(
    result.shouldPublish
      ? "npm version is unpublished and advances its channel dist-tag.\n"
      : "npm registry integrity and channel dist-tag are verified.\n",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
