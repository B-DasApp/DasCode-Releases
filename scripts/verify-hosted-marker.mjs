#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { validateWebReleaseMarker } from "./lib/release-contract.mjs";

const defaultSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Waits until `<origin>/__dascode/release.json` serves exactly this release's identity. A cache-busting
 * query keeps an intermediary from answering with a previous release.
 */
export async function verifyHostedMarker({
  origin,
  channel,
  version,
  sourceSha,
  verificationKey,
  attempts = 20,
  intervalMs = 5_000,
  fetchImpl = fetch,
  sleep = defaultSleep,
}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const url = `${origin.replace(/\/$/u, "")}/__dascode/release.json?verify=${verificationKey}-${attempt}`;
      const response = await fetchImpl(url, {
        headers: { "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const text = await response.text();
        if (text.length <= 4096) {
          validateWebReleaseMarker(JSON.parse(text), { channel, version, sourceSha });
          return;
        }
      }
    } catch {
      // Propagation lag or a stale edge answer; the bounded loop is the retry.
    }
    if (attempt !== attempts) await sleep(intervalMs);
  }
  throw new Error(`${origin} did not serve the exact release identity over HTTPS.`);
}

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`Missing --${name}.`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyHostedMarker({
    origin: option("origin"),
    channel: option("channel"),
    version: option("version"),
    sourceSha: option("source-sha"),
    verificationKey: option("verification-key"),
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
