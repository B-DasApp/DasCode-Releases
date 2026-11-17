#!/usr/bin/env node

// Fails closed unless the relay was successfully deployed for the newest relay change contained in
// the release source commit. The hosted web build talks to the relay, so it must not go live ahead of
// a relay migration or API change that it needs. Read-only GitHub API calls on the private repo.

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { SOURCE_REPOSITORY } from "./lib/release-contract.mjs";
import { fetchRead } from "./lib/transient-retry.mjs";

const apiRoot = "https://api.github.com";
const relayPaths = "infra/relay";
const deployWorkflow = "deploy-relay.yml";
const deployBranch = "dascode/main";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * @param {{ get: (path: string) => Promise<any> }} github
 * @returns {Promise<{ relayCommit: string | null, deployRunId: number | null }>}
 */
export async function findRelayDeployment(github, sourceSha) {
  const changes = await github.get(
    `/repos/${SOURCE_REPOSITORY}/commits?sha=${sourceSha}&path=${relayPaths}&per_page=1`,
  );
  invariant(Array.isArray(changes), "Relay change lookup returned an unexpected shape.");
  if (changes.length === 0) return { relayCommit: null, deployRunId: null };
  const relayCommit = changes[0].sha;
  invariant(/^[0-9a-f]{40}$/u.test(relayCommit), "Relay change lookup returned an invalid commit.");

  const runs = await github.get(
    `/repos/${SOURCE_REPOSITORY}/actions/workflows/${deployWorkflow}/runs?branch=${deployBranch}&per_page=50`,
  );
  invariant(Array.isArray(runs.workflow_runs), "Relay deploy listing returned an unexpected shape.");
  let pending = null;
  for (const run of runs.workflow_runs) {
    if (!/^[0-9a-f]{40}$/u.test(run.head_sha ?? "")) continue;
    // The run deploys its own head, so it covers the relay change when that change is an ancestor.
    const contains = run.head_sha === relayCommit
      || (await github.get(`/repos/${SOURCE_REPOSITORY}/compare/${relayCommit}...${run.head_sha}`)).status === "ahead";
    if (!contains) continue;
    if (run.status === "completed" && run.conclusion === "success") {
      return { relayCommit, deployRunId: run.id };
    }
    if (run.status !== "completed" && pending === null) pending = run.id;
  }
  throw new Error(
    pending === null
      ? `No successful relay deploy contains relay change ${relayCommit.slice(0, 12)}; deploy the relay first, then rerun the failed jobs.`
      : `Relay deploy run ${pending} for relay change ${relayCommit.slice(0, 12)} is still running; rerun the failed jobs after it succeeds.`,
  );
}

function githubClient(token, fetchImpl) {
  return {
    async get(path) {
      const response = await fetchRead(`${apiRoot}${path}`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2026-03-10",
          "User-Agent": "dascode-public-release-controller",
        },
      }, { fetchImpl, timeoutMs: 60_000 });
      invariant(response.status === 200, `GitHub API request failed with HTTP ${response.status}; response body suppressed.`);
      return response.json();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const option = (name) => {
    const index = process.argv.indexOf(`--${name}`);
    const value = index >= 0 ? process.argv[index + 1] : undefined;
    if (!value || value.startsWith("--")) throw new Error(`Missing --${name}.`);
    return value;
  };
  const token = process.env[option("token-env")];
  invariant(token, "Missing source-reader App token.");
  findRelayDeployment(githubClient(token, fetch), option("source-sha"))
    .then(({ relayCommit, deployRunId }) => {
      const line = relayCommit === null
        ? "No relay change in this source commit; nothing to wait for."
        : `Relay change ${relayCommit.slice(0, 12)} is deployed (relay deploy run ${deployRunId}).`;
      process.stdout.write(`${line}\n`);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${line}\n`, "utf8");
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
