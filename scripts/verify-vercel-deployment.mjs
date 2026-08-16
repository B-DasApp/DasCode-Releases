#!/usr/bin/env node

import { verifyProtectedVercelDeployment } from "./lib/vercel-release.mjs";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`Missing --${name}.`);
  return value;
}

async function main() {
  const result = await verifyProtectedVercelDeployment({
    deploymentUrl: option("deployment-url"),
    channel: option("channel"),
    version: option("version"),
    sourceSha: option("source-sha"),
    verificationKey: option("verification-key"),
    token: process.env.VERCEL_TOKEN,
    teamId: process.env.VERCEL_ORG_ID,
    projectId: process.env.VERCEL_PROJECT_ID,
  });
  process.stdout.write(`Verified protected Vercel deployment ${result.deploymentId}.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
