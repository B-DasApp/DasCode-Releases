import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  expectedReleaseAssets,
  recovery,
  validateCurrentRecoveryRun,
  validateBoundedContentLength,
  validateNpmDocument,
  validateOriginalArtifacts,
  validateOriginalJobs,
  validateOriginalRun,
  validatePublicMarker,
  validatePublishedRelease,
  validateRecoveryInvocation,
  validateReleaseAssets,
  validateReleaseTag,
} from "../scripts/recover-canary-web-20260816-8.mjs";

const workflow = readFileSync(
  new URL("../.github/workflows/recover-canary-web-20260816-8.yml", import.meta.url),
  "utf8",
);

const originalRunName = `release-controller / canary / ${recovery.sourceSha}`;
const recoveryRunName = `recover-canary-web / ${recovery.tag}`;

function repository() {
  return { id: recovery.repositoryId, full_name: recovery.repository };
}

function invocation() {
  return {
    repository: recovery.repository,
    repositoryId: String(recovery.repositoryId),
    event: "workflow_dispatch",
    defaultBranch: "main",
    ref: "refs/heads/main",
    refProtected: "true",
    sha: "a".repeat(40),
    workflowSha: "a".repeat(40),
    workflowRef:
      "B-DasApp/DasCode-Releases/.github/workflows/recover-canary-web-20260816-8.yml@refs/heads/main",
    runId: "40000000000",
    runAttempt: "1",
  };
}

function originalRun() {
  return {
    id: recovery.originalRunId,
    run_number: recovery.originalRunNumber,
    run_attempt: recovery.originalRunAttempt,
    workflow_id: recovery.originalWorkflowId,
    name: originalRunName,
    display_title: originalRunName,
    path: ".github/workflows/release.yml",
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "failure",
    head_branch: "main",
    head_sha: recovery.originalControllerSha,
    repository: repository(),
    head_repository: repository(),
  };
}

function jobs() {
  const records = [
    [95222547714, "Authorize immutable request", "success"],
    [95222565779, "Acquire verified private build", "success"],
    [95224045140, "Canonicalize npm package without credentials", "success"],
    [95224119076, "Publish frozen npm package", "success"],
    [95224257604, "Publish public desktop release", "success"],
    [95224507681, "Deploy prebuilt static web release", "failure"],
  ].map(([id, name, conclusion]) => ({
    id,
    name,
    conclusion,
    status: "completed",
    run_id: recovery.originalRunId,
    run_attempt: 1,
    head_sha: recovery.originalControllerSha,
    workflow_name: originalRunName,
  }));
  return { total_count: records.length, jobs: records };
}

function artifact({ id, name, size, digest, expiresAt }) {
  return {
    id,
    name,
    size_in_bytes: size,
    digest,
    expired: false,
    expires_at: expiresAt,
    archive_download_url:
      `https://api.github.com/repos/${recovery.repository}/actions/artifacts/${id}/zip`,
    workflow_run: {
      id: recovery.originalRunId,
      head_branch: "main",
      head_sha: recovery.originalControllerSha,
      repository_id: recovery.repositoryId,
      head_repository_id: recovery.repositoryId,
    },
  };
}

function artifacts() {
  const records = [
    artifact({
      id: 9269859366,
      name: "canonical-npm-dcr-31970670335-1-canary-5d237e478973",
      size: 10284768,
      digest: "sha256:89b075c545760f1e5ccced05c139e72003e47b56fb3b9597dcf09bb45880ce20",
      expiresAt: "2026-09-15T20:42:15Z",
    }),
    artifact({
      id: 9269851447,
      name: "verified-release-bundle-dcr-31970670335-1-canary-5d237e478973",
      size: 811118148,
      digest: "sha256:1d4c564d7d898bb66323760bba2c85713908a1fd5ebb6cac0570673549ee1336",
      expiresAt: "2026-09-15T20:41:29Z",
    }),
  ];
  return { total_count: records.length, artifacts: records };
}

function publishedRelease() {
  return {
    id: recovery.releaseId,
    tag_name: recovery.tag,
    name: `DasCode ${recovery.tag}`,
    body:
      `Verified canary release built from source commit ${recovery.sourceSha}.\n\n` +
      "Desktop signing: the Windows artifact is unsigned. macOS artifacts are unsigned manual-install previews; reliable automatic updates and native passkeys require a future signed and notarized build.\n\n" +
      `Controller contract: {"channel":"canary","sourceSha":"${recovery.sourceSha}","makeLatest":false}`,
    target_commitish: "main",
    draft: false,
    prerelease: true,
    immutable: true,
  };
}

test("accepts only a first-attempt protected-main recovery dispatch", () => {
  assert.doesNotThrow(() => validateRecoveryInvocation(invocation()));
  for (const mutation of [
    { refProtected: "false" },
    { ref: "refs/heads/recovery" },
    { runAttempt: "2" },
    { workflowSha: "b".repeat(40) },
  ]) {
    assert.throws(() => validateRecoveryInvocation({ ...invocation(), ...mutation }));
  }
});

test("uses the evaluated run-name while keeping the workflow identity separate", () => {
  const input = invocation();
  const run = {
    id: Number(input.runId),
    run_attempt: 1,
    event: "workflow_dispatch",
    status: "in_progress",
    conclusion: null,
    head_branch: "main",
    head_sha: input.sha,
    path: ".github/workflows/recover-canary-web-20260816-8.yml",
    name: recoveryRunName,
    display_title: recoveryRunName,
    workflow_id: 400000001,
    repository: repository(),
    head_repository: repository(),
  };
  assert.doesNotThrow(() => validateCurrentRecoveryRun(run, input, 400000001));
  assert.throws(
    () => validateCurrentRecoveryRun({ ...run, name: "Recover Canary web 0.0.33-canary.20260816.8" }, input, 400000001),
    /run-name/,
  );
});

test("locks the original failed run and all six job outcomes", () => {
  assert.doesNotThrow(() => validateOriginalRun(originalRun()));
  assert.doesNotThrow(() => validateOriginalJobs(jobs()));
  assert.throws(
    () => validateOriginalRun({ ...originalRun(), name: "Release controller" }),
    /run-name/,
  );
  const changedJobs = jobs();
  changedJobs.jobs.at(-1).conclusion = "success";
  assert.throws(() => validateOriginalJobs(changedJobs), /outcome mismatch/);
});

test("locks both original artifact identities and rejects expired or changed bytes", () => {
  assert.doesNotThrow(() =>
    validateOriginalArtifacts(artifacts(), Date.parse("2026-08-16T00:00:00Z")),
  );
  const changedDigest = artifacts();
  changedDigest.artifacts[1].digest = `sha256:${"0".repeat(64)}`;
  assert.throws(
    () => validateOriginalArtifacts(changedDigest, Date.parse("2026-08-16T00:00:00Z")),
    /digest mismatch/,
  );
  assert.throws(
    () => validateOriginalArtifacts(artifacts(), Date.parse("2026-10-01T00:00:00Z")),
    /expired/,
  );
});

test("locks the live npm Canary tag and exact registry integrity", () => {
  const document = {
    name: recovery.npmPackage,
    "dist-tags": { canary: recovery.version },
    versions: {
      [recovery.version]: {
        name: recovery.npmPackage,
        version: recovery.version,
        dist: {
          integrity: recovery.npmIntegrity,
          shasum: recovery.npmShasum,
          tarball:
            "https://registry.npmjs.org/@das-org/dascode/-/dascode-0.0.33-canary.20260816.8.tgz",
        },
      },
    },
  };
  assert.doesNotThrow(() => validateNpmDocument(document));
  assert.throws(
    () => validateNpmDocument({ ...document, "dist-tags": { canary: "0.0.33-canary.20260816.9" } }),
    /dist-tag mismatch/,
  );
  const changedIntegrity = structuredClone(document);
  changedIntegrity.versions[recovery.version].dist.integrity = `sha512-${"A".repeat(88)}`;
  assert.throws(() => validateNpmDocument(changedIntegrity), /integrity mismatch/);
});

test("locks the immutable release, direct tag, and all 14 asset digests", () => {
  assert.doesNotThrow(() => validatePublishedRelease(publishedRelease()));
  assert.doesNotThrow(() =>
    validateReleaseTag({
      ref: `refs/tags/${recovery.tag}`,
      object: { type: "commit", sha: recovery.originalControllerSha },
    }),
  );
  const assets = expectedReleaseAssets.map((asset) => ({ ...asset, state: "uploaded" }));
  assert.doesNotThrow(() => validateReleaseAssets(assets));
  assert.throws(
    () => validatePublishedRelease({ ...publishedRelease(), immutable: false }),
    /not immutable/,
  );
  assets[0].digest = `sha256:${"0".repeat(64)}`;
  assert.throws(() => validateReleaseAssets(assets), /digest mismatch/);
});

test("requires an exact public Canary release marker with no extra fields", () => {
  const marker = {
    schemaVersion: 1,
    channel: "canary",
    version: recovery.version,
    sourceSha: recovery.sourceSha,
  };
  assert.doesNotThrow(() => validatePublicMarker(marker));
  assert.throws(() => validatePublicMarker({ ...marker, unexpected: true }), /fields mismatch/);
  assert.throws(
    () => validatePublicMarker({ ...marker, sourceSha: "0".repeat(40) }),
    /source SHA mismatch/,
  );
});

test("rejects malformed and oversized public marker Content-Length values", () => {
  for (const accepted of [null, "0", "4096", "0004"]) {
    assert.doesNotThrow(() => validateBoundedContentLength(accepted, 4096));
  }
  for (const rejected of ["", "-1", "+1", "1.5", "0x10", "Infinity", "4097"]) {
    assert.throws(() => validateBoundedContentLength(rejected, 4096), /Content-Length/);
  }
});

test("keeps the one-shot workflow on the minimal ordered recovery boundary", () => {
  assert.doesNotMatch(workflow, /^\s+inputs:/mu);
  assert.match(
    workflow,
    /^permissions:\n  actions: read\n  contents: read\n  id-token: none\n/mu,
  );
  assert.equal((workflow.match(/^permissions:/gmu) ?? []).length, 1);
  assert.match(
    workflow,
    /^concurrency:\n  group: release-controller-canary\n  cancel-in-progress: false\n/mu,
  );
  assert.match(workflow, /^    environment: production$/mu);

  const forbidden = [
    "SOURCE_READER",
    "RELEASE_PUBLISHER",
    "NPM_TOKEN",
    "NODE_AUTH_TOKEN",
    "id-token: write",
    "create-github-app-token",
    "npm publish",
  ];
  for (const value of forbidden) assert.equal(workflow.includes(value), false, value);

  const secrets = [...workflow.matchAll(/\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/gu)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(secrets, ["VERCEL_ORG_ID", "VERCEL_PROJECT_ID", "VERCEL_TOKEN"]);

  const uses = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gmu)].map(
    (match) => match[1],
  );
  assert.ok(uses.length > 0);
  for (const action of uses) assert.match(action, /@[0-9a-f]{40}$/u);

  const targetGuard = workflow.indexOf(
    "--deployment-url https://dascode-f8r2nvf11-vasco-teixeiras-projects.vercel.app",
  );
  const deployment = workflow.indexOf("./node_modules/.bin/vercel deploy");
  const verifierCalls = [
    ...workflow.matchAll(/node scripts\/verify-vercel-deployment\.mjs/gu),
  ];
  const anchorVerifier = workflow.indexOf("node scripts/verify-vercel-deployment.mjs");
  const protectedVerifier = workflow.lastIndexOf("node scripts/verify-vercel-deployment.mjs");
  const aliasAssignment = workflow.indexOf("node scripts/assign-vercel-alias.mjs");
  const publicMarker = workflow.indexOf("--command verify-public-marker");
  assert.equal(verifierCalls.length, 2);
  assert.ok(anchorVerifier >= 0 && anchorVerifier < targetGuard && targetGuard < deployment);
  assert.ok(deployment < protectedVerifier && protectedVerifier < aliasAssignment);
  assert.ok(aliasAssignment < publicMarker);
});
