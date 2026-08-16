#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  lstatSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import {
  releaseAssetPaths,
  sha256File,
} from "./lib/release-contract.mjs";

const apiRoot = "https://api.github.com";
const workflowPath = ".github/workflows/recover-canary-web-20260816-8.yml";
const workflowName = "Recover Canary web 0.0.33-canary.20260816.8";
const workflowRunName = "recover-canary-web / v0.0.33-canary.20260816.8";
const expectedWorkflowRef =
  `B-DasApp/DasCode-Releases/${workflowPath}@refs/heads/main`;

export const recovery = Object.freeze({
  repository: "B-DasApp/DasCode-Releases",
  repositoryId: 1320700776,
  ownerId: 307542373,
  originalWorkflowId: 335601095,
  originalRunId: 31970670335,
  originalRunNumber: 8,
  originalRunAttempt: 1,
  originalControllerSha: "c6de3de4a3e52ac961c38d7ae84054c3099621ec",
  requestId: "dcr-31970670335-1-canary-5d237e478973",
  sourceRef: "refs/heads/dascode/add-canary-release-channel",
  sourceSha: "5d237e478973383f7ef2fc64280a162c9675cb91",
  canaryMarkerSha: "993407dd9e57f1edf2f5681d70140bfefeca93cc",
  workerRunId: 31970700629,
  workerRunAttempt: 1,
  version: "0.0.33-canary.20260816.8",
  tag: "v0.0.33-canary.20260816.8",
  domain: "canary.code.bclouder.dev",
  npmPackage: "@das-org/dascode",
  npmDistTag: "canary",
  npmIntegrity:
    "sha512-dkQ+rwcWmMHA8XWzhTSpHE/KmpQ//KGoNluC3CTMn7xTZk2Zp1Nkm80TXtfxhyjYRRQsSSOph+Bi+ffeEzTIpA==",
  npmShasum: "4a6bba5d88c9b3910b55f4cd5bbfeeeaedeaaefa",
  webPath: "web/vercel-prebuilt.tgz",
  webSize: 6360687,
  webSha256: "7266a1129076d87ca4b0ef4c14a1d0639673a1d703da9d602e0edbb180b5d2e5",
  npmPath: "npm/das-org-dascode-0.0.33-canary.20260816.8.tgz",
  npmSize: 10284635,
  npmSha256: "6d2375d37ce88943be99ebe8a29d4e5a31441705be4b26d404a9e45ce948add5",
  releaseId: 371430448,
});

const expectedJobs = Object.freeze([
  { id: 95222547714, name: "Authorize immutable request", conclusion: "success" },
  { id: 95222565779, name: "Acquire verified private build", conclusion: "success" },
  {
    id: 95224045140,
    name: "Canonicalize npm package without credentials",
    conclusion: "success",
  },
  { id: 95224119076, name: "Publish frozen npm package", conclusion: "success" },
  { id: 95224257604, name: "Publish public desktop release", conclusion: "success" },
  { id: 95224507681, name: "Deploy prebuilt static web release", conclusion: "failure" },
]);

const expectedArtifacts = Object.freeze([
  {
    id: 9269859366,
    name: "canonical-npm-dcr-31970670335-1-canary-5d237e478973",
    size: 10284768,
    digest: "sha256:89b075c545760f1e5ccced05c139e72003e47b56fb3b9597dcf09bb45880ce20",
    expiresAt: "2026-09-15T20:42:15Z",
  },
  {
    id: 9269851447,
    name: "verified-release-bundle-dcr-31970670335-1-canary-5d237e478973",
    size: 811118148,
    digest: "sha256:1d4c564d7d898bb66323760bba2c85713908a1fd5ebb6cac0570673549ee1336",
    expiresAt: "2026-09-15T20:41:29Z",
  },
]);

const bundleArtifact = expectedArtifacts[1];

export const expectedReleaseAssets = Object.freeze([
  { name: "canary-mac.yml", size: 799, digest: "sha256:430be6806b33a1e9576c61dd757dc8ca77c29babddb6970d5a6ae738a93de3e6" },
  { name: "canary.yml", size: 410, digest: "sha256:848f214d9fba0bced4469ac34e6995cdc65b73c9ab7f055b05dc2ceb6c942693" },
  { name: "DasCode-Canary-0.0.33-canary.20260816.8-arm64.dmg", size: 161220842, digest: "sha256:7562f9eaf3e015c4b92bf648a74f91c17bc9e78fb445474e18f0824083aad557" },
  { name: "DasCode-Canary-0.0.33-canary.20260816.8-arm64.dmg.blockmap", size: 169859, digest: "sha256:1b8625302c987ae7328641b7f034f2d00fbda3c0a2709405eaa0904b2784852c" },
  { name: "DasCode-Canary-0.0.33-canary.20260816.8-arm64.zip", size: 155648358, digest: "sha256:cdb54f7ca51ea65131af4507a470983e39f13b36903e6cda39b39e302c055dee" },
  { name: "DasCode-Canary-0.0.33-canary.20260816.8-arm64.zip.blockmap", size: 163457, digest: "sha256:0d78b5ffdd439bbc98aa8d47f48b352ce49d6f78b6eeb9278ec804d6947c2b3d" },
  { name: "DasCode-Canary-0.0.33-canary.20260816.8-x64.dmg", size: 167241925, digest: "sha256:23530d7266efca2fe6fb0358cf3a9d046e41b1098f5b301374ffdedce9eb4ec8" },
  { name: "DasCode-Canary-0.0.33-canary.20260816.8-x64.dmg.blockmap", size: 176037, digest: "sha256:f10980075bb49dd91248e82ed36e5b0a0820bd3fa5f3690176f177e11f38d41f" },
  { name: "DasCode-Canary-0.0.33-canary.20260816.8-x64.exe", size: 147928930, digest: "sha256:97f157cdd4b6a13719fd00a9fa8428c27acce1bded4c6da0aa606033b0e9e33d" },
  { name: "DasCode-Canary-0.0.33-canary.20260816.8-x64.exe.blockmap", size: 156048, digest: "sha256:d7fffb8d6869a9a5abb2b688cc2736c4aae79fd2d4684925ad624b6e1dacbaf4" },
  { name: "DasCode-Canary-0.0.33-canary.20260816.8-x64.zip", size: 161586874, digest: "sha256:0be501fd4e67ffd176598ba5c85d7a59035436744f242123723d1b46748c3985" },
  { name: "DasCode-Canary-0.0.33-canary.20260816.8-x64.zip.blockmap", size: 168901, digest: "sha256:6a8afd06eb26600b07abbb8ca9760f2fc7b7a6832a8a56eaacd93e420b029edf" },
  { name: "release-manifest.json", size: 5662, digest: "sha256:149475ab61cea79bc6aa629980bb5bdb458b756295df00ce3b5281d7f098eab7" },
  { name: "SHA256SUMS", size: 1740, digest: "sha256:0dc45b68aac917fa6f0686119191845a7e8e01fc63505621276c00a079e8314a" },
]);

const expectedReleaseBody =
  "Verified canary release built from source commit 5d237e478973383f7ef2fc64280a162c9675cb91.\n\n" +
  "Desktop signing: the Windows artifact is unsigned. macOS artifacts are unsigned manual-install previews; reliable automatic updates and native passkeys require a future signed and notarized build.\n\n" +
  "Controller contract: {\"channel\":\"canary\",\"sourceSha\":\"5d237e478973383f7ef2fc64280a162c9675cb91\",\"makeLatest\":false}";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  invariant(isRecord(value), `${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  invariant(JSON.stringify(actual) === JSON.stringify(expected), `${label} fields mismatch.`);
}

function sameRepository(record) {
  return String(record?.id) === String(recovery.repositoryId) && record?.full_name === recovery.repository;
}

function artifactUrl(id) {
  return `${apiRoot}/repos/${recovery.repository}/actions/artifacts/${id}/zip`;
}

export function validateRecoveryInvocation(input) {
  invariant(input.repository === recovery.repository, "Recovery repository identity mismatch.");
  invariant(String(input.repositoryId) === String(recovery.repositoryId), "Recovery repository ID mismatch.");
  invariant(input.event === "workflow_dispatch", "Recovery only accepts workflow_dispatch.");
  invariant(input.defaultBranch === "main", "Recovery default branch must be main.");
  invariant(input.ref === "refs/heads/main" && input.refProtected === "true", "Recovery must run from protected main.");
  invariant(/^[0-9a-f]{40}$/u.test(input.sha), "Recovery controller SHA is invalid.");
  invariant(input.workflowSha === input.sha, "Recovery workflow SHA must equal the protected controller SHA.");
  invariant(input.workflowRef === expectedWorkflowRef, "Recovery workflow ref mismatch.");
  invariant(/^[1-9]\d*$/u.test(input.runId), "Recovery run ID is invalid.");
  invariant(input.runAttempt === "1", "Recovery reruns are forbidden; dispatch a fresh run instead.");
}

export function validateRepository(repository) {
  invariant(sameRepository(repository), "Public release repository identity mismatch.");
  invariant(
    repository.private === false && repository.visibility === "public",
    "Public release repository is no longer public.",
  );
  invariant(repository.default_branch === "main", "Public release default branch mismatch.");
  invariant(repository.archived === false && repository.disabled === false, "Public release repository is unavailable.");
  invariant(
    String(repository.owner?.id) === String(recovery.ownerId) &&
      repository.owner?.login === "B-DasApp" &&
      repository.owner?.type === "Organization",
    "Public release owner identity mismatch.",
  );
}

export function validateCurrentRecoveryRun(run, input, workflowId) {
  invariant(String(run.id) === input.runId, "Current recovery run ID mismatch.");
  invariant(Number(run.run_attempt) === 1, "Current recovery run attempt mismatch.");
  invariant(run.event === "workflow_dispatch", "Current recovery event mismatch.");
  invariant(run.status === "in_progress" && run.conclusion === null, "Current recovery run is not active.");
  invariant(run.head_branch === "main" && run.head_sha === input.sha, "Current recovery head identity mismatch.");
  invariant(run.path === workflowPath && run.name === workflowRunName, "Current recovery run-name mismatch.");
  invariant(run.display_title === workflowRunName, "Current recovery display title mismatch.");
  invariant(String(run.workflow_id) === String(workflowId), "Current recovery workflow ID mismatch.");
  invariant(sameRepository(run.repository) && sameRepository(run.head_repository), "Current recovery repository identity mismatch.");
}

export function validateOriginalRun(run) {
  invariant(String(run.id) === String(recovery.originalRunId), "Original run ID mismatch.");
  invariant(Number(run.run_number) === recovery.originalRunNumber, "Original run number mismatch.");
  invariant(Number(run.run_attempt) === recovery.originalRunAttempt, "Original run attempt mismatch.");
  invariant(String(run.workflow_id) === String(recovery.originalWorkflowId), "Original workflow ID mismatch.");
  invariant(
    run.name === `release-controller / canary / ${recovery.sourceSha}` &&
      run.path === ".github/workflows/release.yml",
    "Original workflow run-name mismatch.",
  );
  invariant(run.event === "workflow_dispatch", "Original run event mismatch.");
  invariant(run.status === "completed" && run.conclusion === "failure", "Original run outcome mismatch.");
  invariant(run.head_branch === "main" && run.head_sha === recovery.originalControllerSha, "Original controller identity mismatch.");
  invariant(
    run.display_title === `release-controller / canary / ${recovery.sourceSha}`,
    "Original run title mismatch.",
  );
  invariant(sameRepository(run.repository) && sameRepository(run.head_repository), "Original run repository identity mismatch.");
}

export function validateOriginalJobs(document) {
  invariant(isRecord(document) && Number(document.total_count) === expectedJobs.length, "Original job count mismatch.");
  invariant(Array.isArray(document.jobs) && document.jobs.length === expectedJobs.length, "Original job listing mismatch.");
  const byName = new Map(document.jobs.map((job) => [job?.name, job]));
  invariant(byName.size === expectedJobs.length, "Original job names are missing or duplicated.");
  for (const expected of expectedJobs) {
    const job = byName.get(expected.name);
    invariant(job !== undefined && String(job.id) === String(expected.id), `Original job identity mismatch: ${expected.name}.`);
    invariant(job.status === "completed" && job.conclusion === expected.conclusion, `Original job outcome mismatch: ${expected.name}.`);
    invariant(String(job.run_id) === String(recovery.originalRunId) && Number(job.run_attempt) === 1, `Original job run mismatch: ${expected.name}.`);
    invariant(job.head_sha === recovery.originalControllerSha, `Original job controller SHA mismatch: ${expected.name}.`);
    invariant(job.workflow_name === `release-controller / canary / ${recovery.sourceSha}`, `Original job workflow title mismatch: ${expected.name}.`);
  }
}

export function validateOriginalArtifacts(document, now = Date.now()) {
  invariant(isRecord(document) && Number(document.total_count) === expectedArtifacts.length, "Original artifact count mismatch.");
  invariant(Array.isArray(document.artifacts) && document.artifacts.length === expectedArtifacts.length, "Original artifact listing mismatch.");
  const byName = new Map(document.artifacts.map((artifact) => [artifact?.name, artifact]));
  invariant(byName.size === expectedArtifacts.length, "Original artifact names are missing or duplicated.");
  for (const expected of expectedArtifacts) {
    const artifact = byName.get(expected.name);
    invariant(artifact !== undefined && String(artifact.id) === String(expected.id), `Original artifact identity mismatch: ${expected.name}.`);
    invariant(Number(artifact.size_in_bytes) === expected.size, `Original artifact size mismatch: ${expected.name}.`);
    invariant(artifact.digest === expected.digest, `Original artifact digest mismatch: ${expected.name}.`);
    invariant(artifact.expired === false && artifact.expires_at === expected.expiresAt, `Original artifact expiry mismatch: ${expected.name}.`);
    invariant(Date.parse(artifact.expires_at) > now, `Original artifact has expired: ${expected.name}.`);
    invariant(artifact.archive_download_url === artifactUrl(expected.id), `Original artifact URL mismatch: ${expected.name}.`);
    invariant(
      String(artifact.workflow_run?.id) === String(recovery.originalRunId) &&
        artifact.workflow_run?.head_branch === "main" &&
        artifact.workflow_run?.head_sha === recovery.originalControllerSha &&
        String(artifact.workflow_run?.repository_id) === String(recovery.repositoryId) &&
        String(artifact.workflow_run?.head_repository_id) === String(recovery.repositoryId),
      `Original artifact provenance mismatch: ${expected.name}.`,
    );
  }
  return byName.get(bundleArtifact.name);
}

export function validateNpmDocument(document) {
  invariant(isRecord(document) && document.name === recovery.npmPackage, "npm package identity mismatch.");
  invariant(document["dist-tags"]?.[recovery.npmDistTag] === recovery.version, "npm Canary dist-tag mismatch.");
  const published = document.versions?.[recovery.version];
  invariant(isRecord(published), "npm Canary version is missing.");
  invariant(published.name === recovery.npmPackage && published.version === recovery.version, "npm version identity mismatch.");
  invariant(published.dist?.integrity === recovery.npmIntegrity, "npm registry integrity mismatch.");
  invariant(published.dist?.shasum === recovery.npmShasum, "npm registry shasum mismatch.");
  invariant(
    published.dist?.tarball ===
      "https://registry.npmjs.org/@das-org/dascode/-/dascode-0.0.33-canary.20260816.8.tgz",
    "npm registry tarball identity mismatch.",
  );
}

export function validatePublishedRelease(release) {
  invariant(String(release.id) === String(recovery.releaseId), "Published release ID mismatch.");
  invariant(release.tag_name === recovery.tag, "Published release tag mismatch.");
  invariant(release.name === `DasCode ${recovery.tag}`, "Published release name mismatch.");
  invariant(release.body === expectedReleaseBody, "Published release body mismatch.");
  invariant(release.target_commitish === "main", "Published release target branch mismatch.");
  invariant(release.draft === false && release.prerelease === true, "Published release channel state mismatch.");
  invariant(release.immutable === true, "Published release is not immutable.");
}

export function validateReleaseTag(ref) {
  invariant(ref?.ref === `refs/tags/${recovery.tag}`, "Published release Git ref mismatch.");
  invariant(ref.object?.type === "commit" && ref.object.sha === recovery.originalControllerSha, "Published release tag target mismatch.");
}

export function validateReleaseAssets(assets, expected = expectedReleaseAssets) {
  invariant(Array.isArray(assets) && assets.length === expected.length, "Published release asset count mismatch.");
  const byName = new Map(assets.map((asset) => [asset?.name, asset]));
  invariant(byName.size === expected.length, "Published release asset names are missing or duplicated.");
  invariant(
    new Set(assets.map((asset) => String(asset?.name).toLowerCase())).size === expected.length,
    "Published release assets collide by case.",
  );
  for (const wanted of expected) {
    const asset = byName.get(wanted.name);
    invariant(asset?.state === "uploaded", `Published release asset is incomplete: ${wanted.name}.`);
    invariant(Number(asset.size) === wanted.size, `Published release asset size mismatch: ${wanted.name}.`);
    invariant(asset.digest === wanted.digest, `Published release asset digest mismatch: ${wanted.name}.`);
  }
}

export function validatePublicMarker(marker) {
  exactKeys(marker, ["schemaVersion", "channel", "version", "sourceSha"], "Public release marker");
  invariant(marker.schemaVersion === 1, "Public release marker schema mismatch.");
  invariant(marker.channel === "canary", "Public release marker channel mismatch.");
  invariant(marker.version === recovery.version, "Public release marker version mismatch.");
  invariant(marker.sourceSha === recovery.sourceSha, "Public release marker source SHA mismatch.");
}

function parseOptions(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    invariant(name?.startsWith("--") && value !== undefined && !value.startsWith("--"), `Invalid option near ${name ?? "<end>"}.`);
    invariant(!options.has(name.slice(2)), `Duplicate option: ${name}.`);
    options.set(name.slice(2), value);
  }
  return options;
}

function required(options, name) {
  const value = options.get(name);
  invariant(value, `Missing --${name}.`);
  return value;
}

function exactOptions(options, names) {
  const expected = new Set(names);
  for (const name of options.keys()) invariant(expected.has(name), `Unexpected --${name}.`);
  for (const name of names) required(options, name);
}

async function githubJson(token, path, fetchImpl = fetch) {
  invariant(typeof token === "string" && token.length > 0, "Missing workflow GitHub token.");
  invariant(path.startsWith("/"), "GitHub API path must be absolute.");
  const response = await fetchImpl(`${apiRoot}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "dascode-canary-web-recovery",
    },
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  invariant(response.status === 200, `GitHub recovery API returned HTTP ${response.status}; body suppressed.`);
  try {
    return await response.json();
  } catch {
    throw new Error("GitHub recovery API returned invalid JSON.");
  }
}

function validateWorkflow(workflow, { id, name, path }) {
  invariant(String(workflow?.id) === String(id), "GitHub workflow ID mismatch.");
  invariant(workflow?.name === name && workflow?.path === path, "GitHub workflow path or name mismatch.");
  invariant(workflow?.state === "active", "GitHub workflow is not active.");
}

function validateBranch(branch) {
  invariant(branch?.name === "main" && branch?.protected === true, "Public release main branch is not protected.");
}

function allowedArtifactHost(hostname) {
  return (
    hostname === "api.github.com" ||
    hostname.endsWith(".blob.core.windows.net") ||
    hostname === "results-receiver.actions.githubusercontent.com" ||
    hostname.endsWith(".actions.githubusercontent.com")
  );
}

async function artifactResponse(token, fetchImpl = fetch) {
  let url = new URL(artifactUrl(bundleArtifact.id));
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    invariant(url.protocol === "https:" && allowedArtifactHost(url.hostname), "Artifact download redirected to an untrusted host.");
    const response = await fetchImpl(url, {
      headers:
        url.hostname === "api.github.com"
          ? {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${token}`,
              "X-GitHub-Api-Version": "2026-03-10",
              "User-Agent": "dascode-canary-web-recovery",
            }
          : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      invariant(location, "Artifact download redirect omitted its destination.");
      url = new URL(location, url);
      continue;
    }
    invariant(response.status === 200 && response.body, `Artifact download returned HTTP ${response.status}; body suppressed.`);
    return response;
  }
  throw new Error("Artifact download exceeded the redirect limit.");
}

async function downloadBundle(token, output, fetchImpl = fetch) {
  const target = resolve(output);
  try {
    lstatSync(target);
    throw new Error("Bundle download target already exists.");
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
  }
  const response = await artifactResponse(token, fetchImpl);
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    invariant(Number(contentLength) === bundleArtifact.size, "Downloaded bundle Content-Length mismatch.");
  }
  const hash = createHash("sha256");
  let size = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > bundleArtifact.size) {
        callback(new Error("Downloaded bundle exceeds its locked size."));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      meter,
      createWriteStream(target, { flags: "wx", mode: 0o600 }),
    );
    invariant(size === bundleArtifact.size, "Downloaded bundle size mismatch.");
    invariant(`sha256:${hash.digest("hex")}` === bundleArtifact.digest, "Downloaded bundle digest mismatch.");
  } catch (error) {
    try {
      unlinkSync(target);
    } catch (cleanupError) {
      if (!(cleanupError && typeof cleanupError === "object" && cleanupError.code === "ENOENT")) throw cleanupError;
    }
    throw error;
  }
}

async function hashFile(path, algorithm, encoding) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest(encoding);
}

async function expectedAssetsFromBundle(bundleDir) {
  const root = resolve(bundleDir);
  const manifest = JSON.parse(readFileSync(join(root, "release-manifest.json"), "utf8"));
  invariant(manifest.requestId === recovery.requestId && manifest.channel === "canary", "Recovery bundle identity mismatch.");
  invariant(manifest.source?.ref === recovery.sourceRef && manifest.source?.sha === recovery.sourceSha, "Recovery bundle source mismatch.");
  invariant(manifest.source?.markerSha === recovery.canaryMarkerSha, "Recovery bundle marker SHA mismatch.");
  invariant(
    String(manifest.source?.workflow?.runId) === String(recovery.workerRunId) &&
      Number(manifest.source?.workflow?.runAttempt) === recovery.workerRunAttempt,
    "Recovery bundle worker identity mismatch.",
  );
  invariant(
    String(manifest.controller?.runId) === String(recovery.originalRunId) &&
      Number(manifest.controller?.runAttempt) === recovery.originalRunAttempt &&
      manifest.controller?.workflowSha === recovery.originalControllerSha,
    "Recovery bundle controller identity mismatch.",
  );
  invariant(
    manifest.release?.version === recovery.version &&
      manifest.release?.tag === recovery.tag &&
      manifest.release?.npmDistTag === recovery.npmDistTag &&
      manifest.release?.hostedDomain === recovery.domain,
    "Recovery bundle release identity mismatch.",
  );
  const web = manifest.files?.find((file) => file.role === "web-prebuilt");
  invariant(
    web?.path === recovery.webPath && web?.size === recovery.webSize && web?.sha256 === recovery.webSha256,
    "Recovery web artifact identity mismatch.",
  );
  const npm = manifest.files?.find((file) => file.role === "npm-package");
  invariant(
    npm?.path === recovery.npmPath && npm?.size === recovery.npmSize && npm?.sha256 === recovery.npmSha256,
    "Recovery npm artifact identity mismatch.",
  );
  const actual = [];
  for (const path of releaseAssetPaths(root, manifest)) {
    actual.push({
      name: basename(path),
      size: statSync(path).size,
      state: "uploaded",
      digest: `sha256:${await sha256File(path)}`,
    });
  }
  validateReleaseAssets(actual);
  return actual;
}

async function verifyCanonicalNpm(path) {
  const absolute = resolve(path);
  const integrity = `sha512-${await hashFile(absolute, "sha512", "base64")}`;
  invariant(integrity === recovery.npmIntegrity, "Canonical npm tarball integrity mismatch.");
  invariant((await hashFile(absolute, "sha1", "hex")) === recovery.npmShasum, "Canonical npm tarball shasum mismatch.");
}

async function acquire(options) {
  exactOptions(options, [
    "command",
    "output",
    "controller-repository",
    "controller-repository-id",
    "controller-ref",
    "controller-ref-protected",
    "controller-sha",
    "controller-workflow-sha",
    "controller-workflow-ref",
    "controller-run-id",
    "controller-run-attempt",
    "event",
    "default-branch",
  ]);
  const input = {
    repository: required(options, "controller-repository"),
    repositoryId: required(options, "controller-repository-id"),
    ref: required(options, "controller-ref"),
    refProtected: required(options, "controller-ref-protected"),
    sha: required(options, "controller-sha"),
    workflowSha: required(options, "controller-workflow-sha"),
    workflowRef: required(options, "controller-workflow-ref"),
    runId: required(options, "controller-run-id"),
    runAttempt: required(options, "controller-run-attempt"),
    event: required(options, "event"),
    defaultBranch: required(options, "default-branch"),
  };
  validateRecoveryInvocation(input);
  const token = process.env.GITHUB_TOKEN;
  const [repository, branch, currentWorkflow, currentRun, originalWorkflow, originalRun, jobs, artifacts] =
    await Promise.all([
      githubJson(token, `/repos/${recovery.repository}`),
      githubJson(token, `/repos/${recovery.repository}/branches/main`),
      githubJson(token, `/repos/${recovery.repository}/actions/workflows/${encodeURIComponent(basename(workflowPath))}`),
      githubJson(token, `/repos/${recovery.repository}/actions/runs/${input.runId}`),
      githubJson(token, `/repos/${recovery.repository}/actions/workflows/${recovery.originalWorkflowId}`),
      githubJson(token, `/repos/${recovery.repository}/actions/runs/${recovery.originalRunId}`),
      githubJson(token, `/repos/${recovery.repository}/actions/runs/${recovery.originalRunId}/jobs?per_page=100`),
      githubJson(token, `/repos/${recovery.repository}/actions/runs/${recovery.originalRunId}/artifacts?per_page=100`),
    ]);
  validateRepository(repository);
  validateBranch(branch);
  validateWorkflow(currentWorkflow, { id: currentRun.workflow_id, name: workflowName, path: workflowPath });
  validateCurrentRecoveryRun(currentRun, input, currentWorkflow.id);
  validateWorkflow(originalWorkflow, {
    id: recovery.originalWorkflowId,
    name: "Release controller",
    path: ".github/workflows/release.yml",
  });
  validateOriginalRun(originalRun);
  validateOriginalJobs(jobs);
  validateOriginalArtifacts(artifacts);
  await downloadBundle(token, required(options, "output"));
  process.stdout.write("Downloaded the exact verified .8 release bundle after validating its original run.\n");
}

async function verifyPublicState(options) {
  exactOptions(options, ["command", "bundle-dir", "npm-tarball"]);
  const token = process.env.GITHUB_TOKEN;
  await expectedAssetsFromBundle(required(options, "bundle-dir"));
  await verifyCanonicalNpm(required(options, "npm-tarball"));
  const registryUrl = `https://registry.npmjs.org/@das-org%2Fdascode?cache=${Date.now()}`;
  const [npmResponse, release, ref] = await Promise.all([
    fetch(registryUrl, {
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    }),
    githubJson(token, `/repos/${recovery.repository}/releases/tags/${encodeURIComponent(recovery.tag)}`),
    githubJson(token, `/repos/${recovery.repository}/git/ref/tags/${encodeURIComponent(recovery.tag)}`),
  ]);
  invariant(npmResponse.status === 200, `npm registry returned HTTP ${npmResponse.status}; body suppressed.`);
  let npmDocument;
  try {
    npmDocument = await npmResponse.json();
  } catch {
    throw new Error("npm registry returned invalid JSON.");
  }
  validateNpmDocument(npmDocument);
  validatePublishedRelease(release);
  validateReleaseTag(ref);
  const assets = await githubJson(
    token,
    `/repos/${recovery.repository}/releases/${recovery.releaseId}/assets?per_page=100`,
  );
  validateReleaseAssets(assets);
  process.stdout.write("Verified the exact live npm publication and immutable 14-asset GitHub release.\n");
}

export function validateBoundedContentLength(declared, limit) {
  if (declared === null) return;
  const size = Number(declared);
  invariant(
    /^\d+$/u.test(declared) && Number.isSafeInteger(size) && size <= limit,
    "Public marker Content-Length is invalid or exceeds its size limit.",
  );
}

async function boundedText(response, limit) {
  validateBoundedContentLength(response.headers.get("content-length"), limit);
  invariant(response.body, "Public marker response has no body.");
  const chunks = [];
  let size = 0;
  for await (const chunk of Readable.fromWeb(response.body)) {
    size += chunk.length;
    invariant(size <= limit, "Public marker exceeds its size limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function verifyPublicMarkerCommand(options) {
  exactOptions(options, ["command"]);
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      const url = new URL(`https://${recovery.domain}/__dascode/release.json`);
      url.searchParams.set("verify", `${recovery.sourceSha}-${process.env.GITHUB_RUN_ID}-${attempt}`);
      const response = await fetch(url, {
        headers: { Accept: "application/json", "Cache-Control": "no-cache" },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      invariant(response.status === 200, `Public Canary marker returned HTTP ${response.status}.`);
      invariant(response.headers.get("content-type")?.toLowerCase().includes("application/json"), "Public Canary marker content type mismatch.");
      validatePublicMarker(JSON.parse(await boundedText(response, 4096)));
      process.stdout.write(`Verified https://${recovery.domain} serves the exact .8 release marker.\n`);
      return;
    } catch (error) {
      if (attempt === 20) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
    }
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const command = required(options, "command");
  if (command === "acquire") return acquire(options);
  if (command === "verify-public-state") return verifyPublicState(options);
  if (command === "verify-public-marker") return verifyPublicMarkerCommand(options);
  throw new Error(`Unsupported recovery command: ${command}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
