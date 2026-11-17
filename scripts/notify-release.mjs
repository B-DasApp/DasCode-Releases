#!/usr/bin/env node

// Final controller job: writes the stage table to the run summary and, when something failed or was
// cancelled, posts one line to an optional webhook. Public logs: only stage names and the run URL.

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { renderStageTable } from "./lib/release-summary.mjs";

const stageOrder = [
  ["authorize", "Authorize request"],
  ["acquire", "Acquire verified private build"],
  ["prepare-npm", "Canonicalize npm package"],
  ["check-relay", "Relay deployed for this source"],
  ["approve", "Human approval"],
  ["publish-github", "Publish desktop release"],
  ["publish-npm", "Publish npm package"],
  ["publish-web", "Deploy hosted web"],
  ["verify-publication", "Verify publication"],
];

export function summarizeStages(needs) {
  const stages = stageOrder.map(([key, name]) => ({ name, result: needs[key]?.result }));
  const failed = stages.find(({ result }) => result === "failure" || result === "cancelled");
  return { stages, failed };
}

export function alertMessage({ failed, channel, version, runUrl }) {
  const outcome = failed.result === "cancelled" ? "was cancelled" : "failed";
  return `DasCode ${channel} release ${version ? `${version} ` : ""}${outcome} at "${failed.name}". ${runUrl}`;
}

export async function notify({ needs, channel, version, runUrl, webhook, summaryFile, fetchImpl = fetch }) {
  const { stages, failed } = summarizeStages(needs);
  const table = renderStageTable(stages);
  if (summaryFile) appendFileSync(summaryFile, table, "utf8");
  if (!failed || !webhook) return { failed, posted: false };
  const message = alertMessage({ failed, channel, version, runUrl });
  const response = await fetchImpl(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // `content` for Discord, `text` for Slack-compatible hooks.
    body: JSON.stringify({ content: message, text: message }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Alert webhook returned HTTP ${response.status}.`);
  return { failed, posted: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  notify({
    needs: JSON.parse(process.env.NEEDS ?? "{}"),
    channel: process.env.RELEASE_CHANNEL ?? "unknown",
    version: process.env.RELEASE_VERSION,
    runUrl: process.env.RUN_URL ?? "",
    webhook: process.env.RELEASE_ALERT_WEBHOOK || undefined,
    summaryFile: process.env.GITHUB_STEP_SUMMARY,
  }).catch((error) => {
    // An alert problem must not turn a finished release red.
    process.stdout.write(`Alert could not be delivered: ${error instanceof Error ? error.message : "error"}.\n`);
  });
}
