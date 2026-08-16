#!/usr/bin/env node

import { assignVerifiedVercelAlias } from "./lib/vercel-release.mjs";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`Missing --${name}.`);
  return value;
}

async function main() {
  const result = await assignVerifiedVercelAlias({
    deploymentUrl: option("deployment-url"),
    domain: option("domain"),
    channel: option("channel"),
    token: process.env.VERCEL_TOKEN,
    teamId: process.env.VERCEL_ORG_ID,
    projectId: process.env.VERCEL_PROJECT_ID,
  });
  process.stdout.write(`Verified ${result.domain} on Vercel deployment ${result.deploymentId}.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
