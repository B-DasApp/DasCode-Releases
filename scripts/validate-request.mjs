#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import {
  CONTROLLER_REPOSITORY,
  CONTROLLER_REPOSITORY_ID,
  buildRequestId,
  validateReleaseRequest,
} from "./lib/release-contract.mjs";

const apiVersion = "2026-03-10";
const expectedWorkflowRef =
  "B-DasApp/DasCode-Releases/.github/workflows/release.yml@refs/heads/main";

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

async function latestStableTag(token) {
  if (!token) throw new Error("Missing workflow GitHub token for Stable release discovery.");
  const response = await fetch(
    `https://api.github.com/repos/${CONTROLLER_REPOSITORY}/releases/latest`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": apiVersion,
        "User-Agent": "dascode-public-release-controller",
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Unable to resolve the latest published Stable release (HTTP ${response.status}).`,
    );
  }
  const release = await response.json();
  if (release.draft !== false || release.prerelease !== false) {
    throw new Error("GitHub's latest release is not a published Stable release.");
  }
  if (!/^v\d+\.\d+\.\d+$/u.test(release.tag_name)) {
    throw new Error("The latest published Stable release must use a vX.Y.Z tag.");
  }
  return release.tag_name;
}

async function main() {
  const args = options(process.argv.slice(2));
  const repository = required(args, "controller-repository");
  const ref = required(args, "controller-ref");
  const refProtected = required(args, "controller-ref-protected");
  const event = required(args, "event");
  const defaultBranch = required(args, "default-branch");
  if (repository !== CONTROLLER_REPOSITORY) throw new Error("Controller repository identity mismatch.");
  if (required(args, "controller-repository-id") !== CONTROLLER_REPOSITORY_ID) throw new Error("Controller repository ID mismatch.");
  if (required(args, "controller-sha") !== required(args, "controller-workflow-sha")) {
    throw new Error("The selected workflow SHA must equal the protected controller commit SHA.");
  }
  if (required(args, "controller-workflow-ref") !== expectedWorkflowRef) {
    throw new Error("Release controller must run from the exact main-branch workflow path.");
  }
  if (event !== "workflow_dispatch") throw new Error("Release controller only accepts workflow_dispatch.");
  if (defaultBranch !== "main") throw new Error("The controller default branch must be main.");
  if (ref !== "refs/heads/main" || refProtected !== "true") {
    throw new Error("Release controller must run from the exact protected main branch.");
  }

  const runId = required(args, "controller-run-id");
  const runAttempt = required(args, "controller-run-attempt");
  if (runAttempt !== "1") {
    throw new Error("Do not rerun authorization; rerun only failed publication jobs or start a new request.");
  }
  const channel = required(args, "channel");
  const request = validateReleaseRequest({
    channel,
    sourceRef: required(args, "source-ref"),
    sourceSha: required(args, "source-sha"),
    runNumber: required(args, "controller-run-number"),
    now: required(args, "now"),
    latestStableTag:
      channel === "stable" ? undefined : await latestStableTag(process.env.GITHUB_TOKEN),
  });
  const requestId = buildRequestId({
    runId,
    runAttempt,
    channel: request.channel,
    sourceSha: request.sourceSha,
  });
  const outputPath = required(args, "github-output");
  const outputs = {
    request_id: requestId,
    channel: request.channel,
    source_ref: request.sourceRef,
    source_sha: request.sourceSha,
    version: request.version,
    tag: request.tag,
    npm_dist_tag: request.npmDistTag,
    prerelease: String(request.prerelease),
    make_latest: String(request.makeLatest),
    controller_run_attempt: runAttempt,
  };
  for (const [name, value] of Object.entries(outputs)) {
    appendFileSync(outputPath, `${name}=${value}\n`, "utf8");
  }
  process.stdout.write(`Authorized ${request.channel} release ${request.tag} from an exact source commit.\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
