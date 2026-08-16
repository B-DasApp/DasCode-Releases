#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFileSync, createWriteStream, renameSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import {
  SOURCE_REPOSITORY,
  SOURCE_REPOSITORY_ID,
  WORKER_CONTROL_REF,
  WORKER_CONTROL_SHA,
  WORKER_WORKFLOW_ID,
  WORKER_WORKFLOW_PATH,
} from "./lib/release-contract.mjs";

const apiRoot = "https://api.github.com";
const apiVersion = "2026-03-10";

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

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(token, path, init = {}, expectedStatuses = [200]) {
  const response = await fetch(`${apiRoot}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": apiVersion,
      "User-Agent": "dascode-public-release-controller",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (!expectedStatuses.includes(response.status)) {
    throw new Error(`GitHub API request failed with HTTP ${response.status}; response body suppressed.`);
  }
  return response;
}

function shortRef(fullRef) {
  if (fullRef.startsWith("refs/heads/")) return fullRef.slice("refs/heads/".length);
  if (fullRef.startsWith("refs/tags/")) return fullRef.slice("refs/tags/".length);
  throw new Error("Unsupported source ref namespace.");
}

function validateRun(run, expected) {
  invariant(String(run.id) === String(expected.runId), "Worker run ID mismatch.");
  invariant(String(run.workflow_id) === WORKER_WORKFLOW_ID, "Worker workflow ID mismatch.");
  invariant(run.event === "workflow_dispatch", "Worker run event mismatch.");
  invariant(run.path === WORKER_WORKFLOW_PATH, "Worker run workflow path mismatch.");
  invariant(run.head_sha === WORKER_CONTROL_SHA, "Worker run head SHA mismatch.");
  invariant(run.head_branch === shortRef(WORKER_CONTROL_REF), "Worker run control ref mismatch.");
  invariant(String(run.head_repository?.id) === SOURCE_REPOSITORY_ID, "Worker head repository ID mismatch.");
  invariant(String(run.repository?.id) === SOURCE_REPOSITORY_ID, "Worker repository ID mismatch.");
  invariant(run.head_repository?.full_name === SOURCE_REPOSITORY, "Worker head repository mismatch.");
  invariant(run.repository?.full_name === SOURCE_REPOSITORY, "Worker repository mismatch.");
  invariant(run.display_title === expected.title, "Worker run request identity mismatch.");
  invariant(run.run_attempt === 1, "A release worker run must be a first attempt, never a rerun.");
  const references = run.referenced_workflows ?? [];
  invariant(references.length === 1, "Worker run must reference exactly one reusable implementation workflow.");
  const implementation = references[0];
  invariant(
    implementation.path?.startsWith(`${SOURCE_REPOSITORY}/.github/workflows/release-worker.yml@`),
    "Worker reusable implementation path mismatch.",
  );
  invariant(implementation.sha === WORKER_CONTROL_SHA, "Worker reusable implementation SHA mismatch.");
  invariant(implementation.ref === WORKER_CONTROL_REF, "Worker reusable implementation ref mismatch.");
}

async function sleep(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function canaryMarkerSha(token, channel, sourceSha) {
  const response = await request(
    token,
    `/repos/${SOURCE_REPOSITORY}/contents/${encodeURIComponent(".canary-source.json")}?ref=${sourceSha}`,
    {},
    channel === "canary" ? [200] : [200, 404],
  );
  if (response.status === 404) return null;
  const content = await response.json();
  invariant(content.type === "file" && content.encoding === "base64", "Canary marker is not a regular file.");
  const marker = JSON.parse(Buffer.from(content.content, "base64").toString("utf8"));
  invariant(
    marker !== null && typeof marker === "object" && !Array.isArray(marker),
    "Canary marker must be an object.",
  );
  invariant(
    JSON.stringify(Object.keys(marker).sort()) ===
      JSON.stringify(["headSha", "pullRequest", "repository", "schemaVersion", "sourceRef"]),
    "Canary marker fields are not canonical.",
  );
  invariant(marker.schemaVersion === 1, "Canary marker schemaVersion mismatch.");
  invariant(marker.repository === "pingdotgg/t3code", "Canary marker repository mismatch.");
  invariant(marker.pullRequest === 2829, "Canary marker pull request mismatch.");
  invariant(marker.sourceRef === "refs/pull/2829/head", "Canary marker source ref mismatch.");
  invariant(/^[0-9a-f]{40}$/u.test(marker.headSha), "Canary marker has an invalid headSha.");
  const compareResponse = await request(
    token,
    `/repos/${SOURCE_REPOSITORY}/compare/${marker.headSha}...${sourceSha}`,
  );
  const comparison = await compareResponse.json();
  const imported = ["ahead", "identical"].includes(comparison.status);
  if (channel !== "canary") {
    invariant(!imported, "Stable and Nightly sources cannot contain the pinned Canary import.");
    return null;
  }
  invariant(imported, "Canary marker commit is not imported by source_sha.");
  return marker.headSha;
}

async function dispatch(token, args) {
  const channel = required(args, "channel");
  const sourceRef = required(args, "source-ref");
  const sourceSha = required(args, "source-sha");
  const requestId = required(args, "request-id");
  const repoResponse = await request(token, `/repos/${SOURCE_REPOSITORY}`);
  const repo = await repoResponse.json();
  invariant(String(repo.id) === SOURCE_REPOSITORY_ID && repo.full_name === SOURCE_REPOSITORY, "Private source repository identity mismatch.");
  const commitResponse = await request(token, `/repos/${SOURCE_REPOSITORY}/commits/${encodeURIComponent(sourceRef)}`);
  const commit = await commitResponse.json();
  invariant(commit.sha === sourceSha, "source_ref no longer resolves to the approved source_sha.");
  const workflowResponse = await request(token, `/repos/${SOURCE_REPOSITORY}/actions/workflows/${WORKER_WORKFLOW_ID}`);
  const workflow = await workflowResponse.json();
  invariant(String(workflow.id) === WORKER_WORKFLOW_ID, "Private worker workflow ID mismatch.");
  invariant(workflow.path === WORKER_WORKFLOW_PATH && workflow.state === "active", "Private worker workflow identity is not active.");
  const controlResponse = await request(
    token,
    `/repos/${SOURCE_REPOSITORY}/commits/${encodeURIComponent(WORKER_CONTROL_REF)}`,
  );
  const controlCommit = await controlResponse.json();
  invariant(controlCommit.sha === WORKER_CONTROL_SHA, "Pinned private worker-control ref moved away from its reviewed SHA.");
  const markerSha = await canaryMarkerSha(token, channel, sourceSha);

  const inputNames = [
    "relay-url", "clerk-publishable-key", "clerk-jwt-template", "clerk-cli-oauth-client-id",
    "posthog-key", "posthog-host", "relay-client-otlp-traces-url", "relay-client-otlp-traces-dataset",
    "relay-client-otlp-traces-token", "hosted-router-url", "hosted-latest-domain",
    "hosted-nightly-domain", "hosted-canary-domain",
  ];
  const inputs = {
    operation: "build-bundle",
    request_id: requestId,
    channel,
    source_ref: sourceRef,
    source_sha: sourceSha,
    worker_ref: WORKER_CONTROL_REF,
    worker_sha: WORKER_CONTROL_SHA,
    version: required(args, "version"),
    controller_repository: required(args, "controller-repository"),
    controller_run_id: required(args, "controller-run-id"),
    controller_run_attempt: required(args, "controller-run-attempt"),
    controller_workflow_sha: required(args, "controller-workflow-sha"),
  };
  for (const name of inputNames) inputs[name.replaceAll("-", "_")] = required(args, name);
  const response = await request(
    token,
    `/repos/${SOURCE_REPOSITORY}/actions/workflows/${WORKER_WORKFLOW_ID}/dispatches`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: shortRef(WORKER_CONTROL_REF), return_run_details: true, inputs }),
    },
    [200],
  );
  const result = await response.json();
  invariant(/^[1-9]\d*$/u.test(String(result.workflow_run_id)), "Dispatch response omitted the exact workflow run ID.");
  appendFileSync(required(args, "github-output"), `worker_run_id=${result.workflow_run_id}\ncanary_marker_sha=${markerSha ?? "null"}\n`, "utf8");
  process.stdout.write(`Dispatched exact private worker run ${result.workflow_run_id}; private logs will not be retrieved.\n`);
}

async function waitForRun(token, args) {
  const runId = required(args, "worker-run-id");
  const expected = {
    runId,
    sourceRef: required(args, "source-ref"),
    sourceSha: required(args, "source-sha"),
    title: `release-worker / ${required(args, "channel")} / ${required(args, "request-id")}`,
  };
  const timeoutAt = Date.now() + Number(args.get("timeout-seconds") ?? "2700") * 1000;
  let run;
  while (Date.now() < timeoutAt) {
    const response = await request(token, `/repos/${SOURCE_REPOSITORY}/actions/runs/${runId}`);
    run = await response.json();
    validateRun(run, expected);
    if (run.status === "completed") {
      invariant(run.conclusion === "success", `Private worker ended with ${run.conclusion ?? "no conclusion"}; logs were not retrieved.`);
      appendFileSync(required(args, "github-output"), "complete=true\nworker_run_attempt=1\n", "utf8");
      process.stdout.write("Private worker completed successfully.\n");
      return;
    }
    invariant(["queued", "in_progress", "pending", "requested", "waiting"].includes(run.status), "Worker entered an unknown state.");
    await sleep(15_000);
  }
  appendFileSync(required(args, "github-output"), "complete=false\n", "utf8");
  process.stdout.write("Worker is still active; a fresh App token will continue the bounded wait.\n");
}

async function downloadArtifact(token, url, destination, expectedDigest) {
  const first = await request(token, new URL(url).pathname, { redirect: "manual" }, [200, 302]);
  let response = first;
  if (first.status === 302) {
    const location = first.headers.get("location");
    invariant(location, "Artifact redirect had no location.");
    const target = new URL(location);
    invariant(target.protocol === "https:", "Artifact redirect must use HTTPS.");
    response = await fetch(target, { redirect: "error", signal: AbortSignal.timeout(10 * 60_000) });
    invariant(response.ok, `Artifact storage returned HTTP ${response.status}.`);
  }
  invariant(response.body, "Artifact download had no response body.");
  const temporary = `${destination}.partial`;
  const hash = createHash("sha256");
  const hashingStream = new TransformStream({ transform(chunk, controller) { hash.update(chunk); controller.enqueue(chunk); } });
  await pipeline(response.body.pipeThrough(hashingStream), createWriteStream(temporary, { mode: 0o600 }));
  invariant(`sha256:${hash.digest("hex")}` === expectedDigest, "Downloaded Actions artifact digest mismatch.");
  renameSync(temporary, destination);
}

async function download(token, args) {
  const runId = required(args, "worker-run-id");
  const expected = {
    runId,
    sourceRef: required(args, "source-ref"),
    sourceSha: required(args, "source-sha"),
    title: `release-worker / ${required(args, "channel")} / ${required(args, "request-id")}`,
  };
  const runResponse = await request(token, `/repos/${SOURCE_REPOSITORY}/actions/runs/${runId}`);
  const run = await runResponse.json();
  validateRun(run, expected);
  invariant(run.status === "completed" && run.conclusion === "success", "Worker is not successfully completed.");
  const response = await request(token, `/repos/${SOURCE_REPOSITORY}/actions/runs/${runId}/artifacts?per_page=100`);
  const artifacts = await response.json();
  invariant(Number.isSafeInteger(artifacts.total_count) && artifacts.total_count <= 100, "Worker artifact listing requires pagination and is refused.");
  const expectedName = `release-bundle-${required(args, "request-id")}`;
  const caseFoldedMatches = artifacts.artifacts?.filter((artifact) => artifact.name?.toLowerCase() === expectedName.toLowerCase()) ?? [];
  const matches = caseFoldedMatches.filter((artifact) => artifact.name === expectedName);
  invariant(caseFoldedMatches.length === 1 && matches.length === 1, "Worker must produce exactly one unambiguous final release bundle artifact.");
  const artifact = matches[0];
  invariant(!artifact.expired && String(artifact.workflow_run?.id ?? runId) === runId, "Worker artifact identity is invalid.");
  if (artifact.workflow_run) {
    invariant(String(artifact.workflow_run.repository_id) === SOURCE_REPOSITORY_ID, "Artifact source repository ID mismatch.");
    invariant(String(artifact.workflow_run.head_repository_id) === SOURCE_REPOSITORY_ID, "Artifact head repository ID mismatch.");
    invariant(artifact.workflow_run.head_sha === WORKER_CONTROL_SHA, "Artifact worker-control SHA mismatch.");
  }
  invariant(Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= 8 * 1024 ** 3, "Worker artifact size is invalid.");
  invariant(/^sha256:[0-9a-f]{64}$/u.test(artifact.digest), "Worker artifact has no valid immutable digest.");
  invariant(artifact.archive_download_url === `${apiRoot}/repos/${SOURCE_REPOSITORY}/actions/artifacts/${artifact.id}/zip`, "Worker artifact download identity mismatch.");
  await downloadArtifact(token, artifact.archive_download_url, required(args, "output"), artifact.digest);
  appendFileSync(required(args, "github-output"), `worker_run_attempt=1\nworker_artifact_id=${artifact.id}\nworker_artifact_digest=${artifact.digest}\n`, "utf8");
  process.stdout.write("Verified exact artifact identity and downloaded bytes against the REST digest.\n");
}

async function main() {
  const args = options(process.argv.slice(2));
  const command = required(args, "command");
  const token = process.env[required(args, "token-env")];
  invariant(token, "Missing source-reader App token.");
  if (command === "dispatch") await dispatch(token, args);
  else if (command === "wait") await waitForRun(token, args);
  else if (command === "download") await download(token, args);
  else throw new Error(`Unsupported command: ${command}.`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
