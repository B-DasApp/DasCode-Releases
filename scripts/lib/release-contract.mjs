import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const CONTROLLER_REPOSITORY = "B-DasApp/DasCode-Releases";
export const CONTROLLER_REPOSITORY_ID = "1320700776";
export const SOURCE_REPOSITORY = "B-DasApp/DasCode";
export const SOURCE_REPOSITORY_ID = "1178338180";
export const WORKER_WORKFLOW_PATH = ".github/workflows/release.yml";
export const WORKER_IMPLEMENTATION_PATH = ".github/workflows/release-worker.yml";
export const WORKER_WORKFLOW_ID = "244380781";
export const WORKER_CONTROL_REF = "refs/heads/dascode/release-worker-controller";
export const WORKER_CONTROL_SHA = "5d237e478973383f7ef2fc64280a162c9675cb91";
export const NPM_PACKAGE_NAME = "@das-org/dascode";
export const NPM_REPOSITORY_URL =
  "git+https://github.com/B-DasApp/DasCode-Releases.git";

const shaPattern = /^[0-9a-f]{40}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const sha512Pattern = /^[A-Za-z0-9+/]{86}==$/u;
const stableVersionPattern = /^\d+\.\d+\.\d+$/u;
const requestIdPattern = /^[A-Za-z0-9._-]{1,128}$/u;
const safeBundlePathPattern = /^(desktop|npm|web)\/[A-Za-z0-9][A-Za-z0-9._+@/-]*$/u;
const roles = new Set([
  "desktop-installer",
  "desktop-updater-manifest",
  "desktop-blockmap",
  "desktop-macos-dmg",
  "desktop-macos-zip",
  "desktop-macos-blockmap",
  "desktop-macos-updater-manifest",
  "npm-package",
  "web-prebuilt",
]);

const releaseAssetRoleOrder = new Map([
  ["desktop-installer", 0],
  ["desktop-macos-dmg", 0],
  ["desktop-macos-zip", 0],
  ["desktop-blockmap", 1],
  ["desktop-macos-blockmap", 1],
  ["release-metadata", 2],
  ["desktop-updater-manifest", 3],
  ["desktop-macos-updater-manifest", 3],
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(record, required, optional = []) {
  invariant(isRecord(record), "Expected an object.");
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    invariant(Object.hasOwn(record, key), `Missing required field: ${key}.`);
  }
  for (const key of Object.keys(record)) {
    invariant(allowed.has(key), `Unexpected field: ${key}.`);
  }
}

function normalizedPositiveInteger(value, name) {
  const text = String(value);
  invariant(/^[1-9]\d*$/u.test(text), `${name} must be a positive integer.`);
  return text;
}

function validateFullGitRef(ref) {
  invariant(ref.startsWith("refs/"), "source_ref must be a full refs/... Git ref.");
  invariant(ref.length <= 240, "source_ref is too long.");
  invariant(!/[\x00-\x20\x7f~^:?*[\\]/u.test(ref), "source_ref contains an unsafe character.");
  invariant(!ref.includes("..") && !ref.includes("@{") && !ref.includes("//"), "source_ref is malformed.");
  invariant(!ref.endsWith("/") && !ref.endsWith("."), "source_ref has an invalid ending.");
  for (const part of ref.split("/")) {
    invariant(part !== "" && part !== "." && part !== "..", "source_ref has an invalid path segment.");
    invariant(!part.endsWith(".lock"), "source_ref may not contain a .lock segment.");
  }
}

function parseStableVersionTag(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/u.exec(tag);
  return match ? match.slice(1).map(Number) : undefined;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function resolveReleaseVersion({ channel, sourceRef, runNumber, now, latestStableTag }) {
  invariant(["stable", "nightly", "canary"].includes(channel), `Unsupported channel: ${channel}.`);
  validateFullGitRef(sourceRef);

  if (channel === "stable") {
    const match = /^refs\/tags\/v(\d+\.\d+\.\d+)$/u.exec(sourceRef);
    invariant(match, "Stable releases require source_ref refs/tags/vX.Y.Z.");
    return match[1];
  }

  if (channel === "nightly") {
    invariant(sourceRef === "refs/heads/dascode/main", "Nightly releases require refs/heads/dascode/main.");
  } else {
    invariant(
      /^refs\/heads\/dascode\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(sourceRef),
      "Canary releases require a branch below refs/heads/dascode/.",
    );
    invariant(sourceRef !== "refs/heads/dascode/main", "Canary releases cannot use the Nightly source branch.");
  }

  const stableVersion = parseStableVersionTag(latestStableTag);
  invariant(stableVersion, "The latest published Stable release must use a vX.Y.Z tag.");
  const [major, minor, patch] = stableVersion;
  const date = new Date(now);
  invariant(!Number.isNaN(date.valueOf()), "Invalid release timestamp.");
  const datePart = date.toISOString().slice(0, 10).replaceAll("-", "");
  const build = normalizedPositiveInteger(runNumber, "run number");
  return `${major}.${minor}.${patch + 1}-${channel}.${datePart}.${build}`;
}

export function validateReleaseRequest({
  channel,
  sourceRef,
  sourceSha,
  runNumber,
  now,
  latestStableTag,
}) {
  invariant(shaPattern.test(sourceSha), "source_sha must be a full lowercase 40-character commit SHA.");
  const version = resolveReleaseVersion({
    channel,
    sourceRef,
    runNumber,
    now,
    latestStableTag,
  });
  return {
    channel,
    sourceRef,
    sourceSha,
    version,
    tag: `v${version}`,
    npmDistTag: channel === "stable" ? "latest" : channel,
    prerelease: channel !== "stable",
    makeLatest: channel === "stable",
  };
}

export function buildRequestId({ runId, runAttempt, channel, sourceSha }) {
  const id = `dcr-${normalizedPositiveInteger(runId, "controller run ID")}-${normalizedPositiveInteger(runAttempt, "controller run attempt")}-${channel}-${sourceSha.slice(0, 12)}`;
  invariant(requestIdPattern.test(id), "Generated request ID is invalid.");
  return id;
}

export function releaseAssetNames(paths) {
  return paths.map((path) => basename(path));
}

export function releaseAssetPaths(root, manifest) {
  const entries = [
    { path: join(root, "release-manifest.json"), role: "release-metadata" },
    { path: join(root, "SHA256SUMS"), role: "release-metadata" },
    ...manifest.files
      .filter((file) => file.role.startsWith("desktop-"))
      .map((file) => ({ path: join(root, file.path), role: file.role })),
  ];
  for (const entry of entries) {
    invariant(releaseAssetRoleOrder.has(entry.role), `Unsupported public release asset role: ${entry.role}.`);
  }
  return entries
    .sort((left, right) => {
      const priority = releaseAssetRoleOrder.get(left.role) - releaseAssetRoleOrder.get(right.role);
      if (priority !== 0) return priority;
      return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
    })
    .map((entry) => entry.path);
}

function validatePath(path) {
  invariant(safeBundlePathPattern.test(path), `Unsafe or unsupported bundle path: ${path}.`);
  invariant(!path.includes("//") && !path.includes(".."), `Unsafe bundle path: ${path}.`);
  invariant(path.split("/").every((part) => part !== "" && part !== "." && part !== ".."), `Unsafe bundle path: ${path}.`);
}

function validateVersionForChannel(channel, version) {
  const pattern =
    channel === "stable"
      ? stableVersionPattern
      : new RegExp(`^\\d+\\.\\d+\\.\\d+-${channel}\\.\\d{8}\\.\\d+$`, "u");
  invariant(pattern.test(version), `Release version ${version} does not belong to ${channel}.`);
}

export function validateManifest(manifest, expected) {
  exactKeys(manifest, ["schemaVersion", "requestId", "channel", "source", "controller", "release", "createdAt", "files"]);
  invariant(manifest.schemaVersion === 2, "Unsupported release manifest schemaVersion.");
  invariant(manifest.requestId === expected.requestId && requestIdPattern.test(manifest.requestId), "Manifest requestId mismatch.");
  invariant(manifest.channel === expected.channel, "Manifest channel mismatch.");
  invariant(!Number.isNaN(Date.parse(manifest.createdAt)), "Manifest createdAt is invalid.");

  exactKeys(manifest.source, ["repository", "repositoryId", "ref", "sha", "markerSha", "workflow"]);
  invariant(manifest.source.repository === SOURCE_REPOSITORY, "Manifest source repository mismatch.");
  invariant(String(manifest.source.repositoryId) === SOURCE_REPOSITORY_ID, "Manifest source repository ID mismatch.");
  invariant(manifest.source.ref === expected.sourceRef, "Manifest source ref mismatch.");
  invariant(manifest.source.sha === expected.sourceSha && shaPattern.test(manifest.source.sha), "Manifest source SHA mismatch.");
  invariant(manifest.source.markerSha === expected.canaryMarkerSha, "Manifest Canary marker SHA mismatch.");
  exactKeys(
    manifest.source.workflow,
    ["id", "path", "ref", "sha", "implementationPath", "implementationSha", "runId", "runAttempt", "headSha"],
  );
  invariant(String(manifest.source.workflow.id) === WORKER_WORKFLOW_ID, "Manifest worker workflow ID mismatch.");
  invariant(manifest.source.workflow.path === WORKER_WORKFLOW_PATH, "Manifest worker workflow path mismatch.");
  invariant(manifest.source.workflow.ref === WORKER_CONTROL_REF, "Manifest worker-control ref mismatch.");
  invariant(
    manifest.source.workflow.implementationPath === WORKER_IMPLEMENTATION_PATH,
    "Manifest worker implementation path mismatch.",
  );
  invariant(manifest.source.workflow.implementationSha === WORKER_CONTROL_SHA, "Manifest worker implementation SHA mismatch.");
  invariant(String(manifest.source.workflow.runId) === String(expected.workerRunId), "Manifest worker run ID mismatch.");
  invariant(Number(manifest.source.workflow.runAttempt) === 1 && Number(expected.workerRunAttempt) === 1, "Manifest worker run attempt must be one.");
  invariant(manifest.source.workflow.headSha === WORKER_CONTROL_SHA, "Manifest worker head SHA mismatch.");
  invariant(manifest.source.workflow.sha === WORKER_CONTROL_SHA, "Manifest worker workflow SHA mismatch.");

  exactKeys(manifest.controller, ["repository", "repositoryId", "workflowSha", "runId", "runAttempt"]);
  invariant(manifest.controller.repository === CONTROLLER_REPOSITORY, "Manifest controller repository mismatch.");
  invariant(String(manifest.controller.repositoryId) === CONTROLLER_REPOSITORY_ID, "Manifest controller repository ID mismatch.");
  invariant(manifest.controller.workflowSha === expected.controllerWorkflowSha, "Manifest controller workflow SHA mismatch.");
  invariant(String(manifest.controller.runId) === String(expected.controllerRunId), "Manifest controller run ID mismatch.");
  invariant(Number(manifest.controller.runAttempt) === Number(expected.controllerRunAttempt), "Manifest controller run attempt mismatch.");

  exactKeys(manifest.release, ["version", "tag", "npmDistTag", "prerelease", "makeLatest", "hostedDomain"]);
  validateVersionForChannel(manifest.channel, manifest.release.version);
  invariant(manifest.release.version === expected.version, "Manifest release version mismatch.");
  invariant(manifest.release.tag === `v${expected.version}`, "Manifest release tag mismatch.");
  const expectedDistTag = manifest.channel === "stable" ? "latest" : manifest.channel;
  invariant(manifest.release.npmDistTag === expectedDistTag, "Manifest npm dist-tag crosses release channels.");
  invariant(manifest.release.prerelease === (manifest.channel !== "stable"), "Manifest prerelease flag mismatch.");
  invariant(manifest.release.makeLatest === (manifest.channel === "stable"), "Manifest latest-release flag mismatch.");
  const expectedDomain = `${manifest.channel === "stable" ? "latest" : manifest.channel}.code.bclouder.dev`;
  invariant(manifest.release.hostedDomain === expectedDomain, "Manifest hosted domain crosses release channels.");

  const expectedFileCount = manifest.channel === "canary" ? 14 : 5;
  invariant(Array.isArray(manifest.files) && manifest.files.length === expectedFileCount, "Manifest files count is invalid.");
  const seenPaths = new Set();
  const seenCaseInsensitivePaths = new Set();
  const roleCounts = new Map();
  let totalSize = 0;
  for (const file of manifest.files) {
    exactKeys(file, ["path", "sha256", "size", "mediaType", "role"], ["sha512"]);
    validatePath(file.path);
    invariant(!seenPaths.has(file.path), `Duplicate manifest path: ${file.path}.`);
    const folded = file.path.toLowerCase();
    invariant(!seenCaseInsensitivePaths.has(folded), `Case-colliding manifest path: ${file.path}.`);
    seenPaths.add(file.path);
    seenCaseInsensitivePaths.add(folded);
    invariant(sha256Pattern.test(file.sha256), `Invalid SHA-256 for ${file.path}.`);
    invariant(Number.isSafeInteger(file.size) && file.size > 0 && file.size <= 3 * 1024 ** 3, `Invalid size for ${file.path}.`);
    totalSize += file.size;
    invariant(totalSize <= 8 * 1024 ** 3, "Bundle is too large.");
    invariant(typeof file.mediaType === "string" && /^[\x21-\x7e]{1,128}$/u.test(file.mediaType), `Invalid media type for ${file.path}.`);
    invariant(roles.has(file.role), `Unsupported release role: ${file.role}.`);
    roleCounts.set(file.role, (roleCounts.get(file.role) ?? 0) + 1);
    if (file.role === "desktop-installer") {
      invariant(file.path.startsWith("desktop/") && file.path.endsWith(".exe"), "Desktop installer must be a desktop/*.exe file.");
      invariant(sha512Pattern.test(file.sha512 ?? ""), "Desktop installer requires a base64 SHA-512.");
    }
    if (file.role === "desktop-blockmap") invariant(file.path.startsWith("desktop/") && file.path.endsWith(".blockmap"), "Desktop blockmap path is invalid.");
    if (file.role === "desktop-updater-manifest") invariant(file.path === `desktop/${expectedDistTag}.yml`, "Updater manifest does not match the release channel.");
    const macArtifactPrefix = `desktop/DasCode-Canary-${manifest.release.version}-`;
    if (file.role === "desktop-macos-dmg") {
      invariant(
        [`${macArtifactPrefix}arm64.dmg`, `${macArtifactPrefix}x64.dmg`].includes(file.path),
        "macOS DMG path does not match the exact Canary version and architecture.",
      );
      invariant(file.mediaType === "application/x-apple-diskimage", "macOS DMG media type is invalid.");
      invariant(sha512Pattern.test(file.sha512 ?? ""), "macOS DMG requires a base64 SHA-512.");
    }
    if (file.role === "desktop-macos-zip") {
      invariant(
        [`${macArtifactPrefix}arm64.zip`, `${macArtifactPrefix}x64.zip`].includes(file.path),
        "macOS ZIP path does not match the exact Canary version and architecture.",
      );
      invariant(file.mediaType === "application/zip", "macOS ZIP media type is invalid.");
      invariant(sha512Pattern.test(file.sha512 ?? ""), "macOS ZIP requires a base64 SHA-512.");
    }
    if (file.role === "desktop-macos-blockmap") {
      invariant(
        [
          `${macArtifactPrefix}arm64.dmg.blockmap`,
          `${macArtifactPrefix}arm64.zip.blockmap`,
          `${macArtifactPrefix}x64.dmg.blockmap`,
          `${macArtifactPrefix}x64.zip.blockmap`,
        ].includes(file.path),
        "macOS blockmap path does not match an exact Canary payload.",
      );
      invariant(file.mediaType === "application/octet-stream", "macOS blockmap media type is invalid.");
    }
    if (file.role === "desktop-macos-updater-manifest") {
      invariant(file.path === "desktop/canary-mac.yml", "macOS updater manifest must be desktop/canary-mac.yml.");
      invariant(file.mediaType === "application/yaml", "macOS updater manifest media type is invalid.");
    }
    if (file.role === "npm-package") invariant(/^npm\/[A-Za-z0-9@._+-]+\.tgz$/u.test(file.path), "npm package path is invalid.");
    if (file.role === "web-prebuilt") invariant(file.path === "web/vercel-prebuilt.tgz", "Web prebuilt path is invalid.");
  }
  invariant((roleCounts.get("desktop-installer") ?? 0) === 1, "Bundle must have exactly one desktop installer.");
  invariant((roleCounts.get("desktop-updater-manifest") ?? 0) === 1, "Bundle must have one channel updater manifest.");
  invariant((roleCounts.get("desktop-blockmap") ?? 0) === 1, "Bundle must have exactly one desktop blockmap.");
  invariant((roleCounts.get("npm-package") ?? 0) === 1, "Bundle must have exactly one npm package.");
  invariant((roleCounts.get("web-prebuilt") ?? 0) === 1, "Bundle must have exactly one web prebuilt archive.");
  const expectedMacRoleCounts = manifest.channel === "canary"
    ? new Map([
        ["desktop-macos-dmg", 2],
        ["desktop-macos-zip", 2],
        ["desktop-macos-blockmap", 4],
        ["desktop-macos-updater-manifest", 1],
      ])
    : new Map([
        ["desktop-macos-dmg", 0],
        ["desktop-macos-zip", 0],
        ["desktop-macos-blockmap", 0],
        ["desktop-macos-updater-manifest", 0],
      ]);
  for (const [role, count] of expectedMacRoleCounts) {
    invariant((roleCounts.get(role) ?? 0) === count, `${manifest.channel} bundle has an invalid ${role} count.`);
  }
  const installer = manifest.files.find((file) => file.role === "desktop-installer");
  const blockmap = manifest.files.find((file) => file.role === "desktop-blockmap");
  invariant(blockmap.path === `${installer.path}.blockmap`, "Desktop blockmap does not belong to the sole installer.");
  const macPayloadPaths = new Set(
    manifest.files
      .filter((file) => file.role === "desktop-macos-dmg" || file.role === "desktop-macos-zip")
      .map((file) => `${file.path}.blockmap`),
  );
  const macBlockmapPaths = new Set(
    manifest.files
      .filter((file) => file.role === "desktop-macos-blockmap")
      .map((file) => file.path),
  );
  invariant(
    JSON.stringify([...macBlockmapPaths].sort()) === JSON.stringify([...macPayloadPaths].sort()),
    "macOS blockmaps do not belong to the exact DMG and ZIP payloads.",
  );
  return manifest;
}

export function parseSha256Sums(text) {
  const result = new Map();
  invariant(text.endsWith("\n"), "SHA256SUMS must end with a newline.");
  for (const line of text.split("\n").slice(0, -1)) {
    const match = /^([0-9a-f]{64})  (release-manifest\.json|(?:desktop|npm|web)\/[A-Za-z0-9][A-Za-z0-9._+@/-]*)$/u.exec(line);
    invariant(match, "Malformed SHA256SUMS line.");
    if (match[2] !== "release-manifest.json") validatePath(match[2]);
    invariant(!result.has(match[2]), `Duplicate SHA256SUMS path: ${match[2]}.`);
    result.set(match[2], match[1]);
  }
  return result;
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function sha512File(path) {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("base64");
}

function yamlScalar(value) {
  const trimmed = value.trim();
  invariant(trimmed !== "" && !/[\x00-\x1f]/u.test(trimmed), "Updater YAML contains an invalid scalar.");
  if (trimmed.startsWith('"')) return JSON.parse(trimmed);
  if (trimmed.startsWith("'")) {
    invariant(trimmed.endsWith("'"), "Updater YAML has an unterminated scalar.");
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  invariant(!/[#[\]{}&,*!|>@`]/u.test(trimmed), "Updater YAML uses unsupported syntax.");
  return trimmed;
}

export function parseUpdaterYaml(text) {
  invariant(!text.includes("\r") && !text.includes("\t"), "Updater YAML must use LF and spaces.");
  const result = { files: [] };
  let currentFile;
  for (const rawLine of text.split("\n")) {
    if (rawLine === "" || /^#/.test(rawLine)) continue;
    let match = /^(version|path|sha512|releaseDate):\s*(.+)$/u.exec(rawLine);
    if (match) {
      invariant(!Object.hasOwn(result, match[1]), `Duplicate updater field: ${match[1]}.`);
      result[match[1]] = yamlScalar(match[2]);
      currentFile = undefined;
      continue;
    }
    if (rawLine === "files:") {
      invariant(!result.sawFiles, "Duplicate updater files field.");
      result.sawFiles = true;
      currentFile = undefined;
      continue;
    }
    match = /^  - url:\s*(.+)$/u.exec(rawLine);
    if (match && result.sawFiles) {
      currentFile = { url: yamlScalar(match[1]) };
      result.files.push(currentFile);
      continue;
    }
    match = /^    (sha512|size):\s*(.+)$/u.exec(rawLine);
    if (match && currentFile) {
      invariant(!Object.hasOwn(currentFile, match[1]), `Duplicate updater file field: ${match[1]}.`);
      currentFile[match[1]] = yamlScalar(match[2]);
      continue;
    }
    throw new Error("Updater YAML contains an unexpected line.");
  }
  invariant(
    typeof result.version === "string" && result.sawFiles === true && result.files.length >= 1 && result.files.length <= 20,
    "Updater YAML shape is invalid.",
  );
  const files = result.files.map((file) => {
    invariant(typeof file.url === "string" && file.url !== "", "Updater YAML file URL is invalid.");
    invariant(sha512Pattern.test(file.sha512 ?? ""), "Updater YAML file SHA-512 is invalid.");
    invariant(/^[1-9]\d*$/u.test(file.size ?? ""), "Updater YAML file size is invalid.");
    const size = Number(file.size);
    invariant(Number.isSafeInteger(size), "Updater YAML file size is invalid.");
    return { ...file, size };
  });
  invariant(new Set(files.map((file) => file.url.toLowerCase())).size === files.length, "Updater YAML has duplicate or case-colliding file URLs.");
  if (Object.hasOwn(result, "releaseDate")) {
    invariant(!Number.isNaN(Date.parse(result.releaseDate)), "Updater YAML releaseDate is invalid.");
  }
  return { ...result, files };
}

export function validateWindowsUpdaterMetadata(text, manifest, root) {
  const updater = parseUpdaterYaml(text);
  const installers = manifest.files.filter((file) => file.role === "desktop-installer");
  invariant(installers.length === 1, "Updater linkage currently requires exactly one installer.");
  const installer = installers[0];
  const installerName = basename(installer.path);
  invariant(updater.files.length === 1, "Windows updater manifest must contain exactly one installer.");
  const updaterFile = updater.files[0];
  invariant(updater.version === manifest.release.version, "Updater version mismatch.");
  invariant(updater.path === installerName && updaterFile.url === installerName, "Updater installer filename mismatch.");
  invariant(updater.sha512 === installer.sha512 && updaterFile.sha512 === installer.sha512, "Updater SHA-512 mismatch.");
  invariant(updaterFile.size === installer.size, "Updater installer size mismatch.");
  return { installer, absoluteInstaller: join(root, installer.path) };
}

export function validateMacUpdaterMetadata(text, manifest, root) {
  const updater = parseUpdaterYaml(text);
  const payloads = manifest.files.filter(
    (file) => file.role === "desktop-macos-dmg" || file.role === "desktop-macos-zip",
  );
  invariant(manifest.channel === "canary" && payloads.length === 4, "macOS updater linkage requires the exact Canary payload set.");
  invariant(updater.version === manifest.release.version, "macOS updater version mismatch.");
  invariant(!Object.hasOwn(updater, "path") && !Object.hasOwn(updater, "sha512"), "Merged macOS updater manifest must not select one architecture at top level.");
  invariant(Object.hasOwn(updater, "releaseDate"), "Merged macOS updater manifest requires releaseDate.");
  invariant(updater.files.length === payloads.length, "macOS updater manifest file count mismatch.");

  const expectedNames = [
    `DasCode-Canary-${manifest.release.version}-arm64.zip`,
    `DasCode-Canary-${manifest.release.version}-arm64.dmg`,
    `DasCode-Canary-${manifest.release.version}-x64.zip`,
    `DasCode-Canary-${manifest.release.version}-x64.dmg`,
  ];
  invariant(
    JSON.stringify(updater.files.map((file) => file.url)) === JSON.stringify(expectedNames),
    "macOS updater manifest payload order or identity is invalid.",
  );
  const payloadByName = new Map(payloads.map((file) => [basename(file.path), file]));
  for (const updaterFile of updater.files) {
    const payload = payloadByName.get(updaterFile.url);
    invariant(payload, `macOS updater payload is not in the release manifest: ${updaterFile.url}.`);
    invariant(updaterFile.sha512 === payload.sha512, `macOS updater SHA-512 mismatch: ${updaterFile.url}.`);
    invariant(updaterFile.size === payload.size, `macOS updater size mismatch: ${updaterFile.url}.`);
  }
  return payloads.map((payload) => ({ payload, absolutePayload: join(root, payload.path) }));
}

export const validateUpdaterMetadata = validateWindowsUpdaterMetadata;

function listFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory)) {
      const absolute = join(directory, name);
      const stat = lstatSync(absolute);
      invariant(!stat.isSymbolicLink(), `Bundle may not contain symlinks: ${name}.`);
      if (stat.isDirectory()) visit(absolute);
      else {
        invariant(stat.isFile(), `Bundle contains a non-file entry: ${name}.`);
        files.push(relative(root, absolute).split(sep).join("/"));
      }
    }
  };
  visit(root);
  return files.sort();
}

function inspectTar(mode, path) {
  const inspector = resolve(fileURLToPath(new URL("../inspect-tar.py", import.meta.url)));
  return JSON.parse(execFileSync("python3", [inspector, mode, path], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    timeout: 120_000,
  }));
}

export function validateNpmMetadata(packageJson, expectedVersion) {
  invariant(isRecord(packageJson), "npm package.json must be an object.");
  invariant(packageJson.name === NPM_PACKAGE_NAME, `npm package name must be ${NPM_PACKAGE_NAME}.`);
  invariant(packageJson.version === expectedVersion, "npm package version mismatch.");
  invariant(isRecord(packageJson.repository), "npm repository metadata must use an object.");
  invariant(packageJson.repository.type === "git", "npm repository.type must be git.");
  invariant(packageJson.repository.url === NPM_REPOSITORY_URL, `npm repository.url must be ${NPM_REPOSITORY_URL}.`);
  invariant(!Object.hasOwn(packageJson.repository, "directory"), "npm repository.directory is forbidden.");
  invariant(!Object.hasOwn(packageJson, "scripts"), "npm package lifecycle scripts are forbidden.");
  if (Object.hasOwn(packageJson, "publishConfig")) {
    invariant(isRecord(packageJson.publishConfig), "npm package publishConfig must be an object.");
    exactKeys(packageJson.publishConfig, ["access"]);
    invariant(packageJson.publishConfig.access === "public", "npm package publishConfig may only set public access.");
  }
}

export function validateNpmArchive(path, expectedVersion) {
  const inspected = inspectTar("npm", path);
  invariant(isRecord(inspected), "npm archive inspection is invalid.");
  exactKeys(inspected, ["packageJson", "resourceMonitors"]);
  validateNpmMetadata(inspected.packageJson, expectedVersion);
  invariant(isRecord(inspected.resourceMonitors), "npm resource-monitor inventory is invalid.");
  const expectedResourceMonitors = [
    "package/dist/resource-monitor/win32-x64/dascode-resource-monitor.exe",
    ...(/-canary\.\d{8}\.\d+$/u.test(expectedVersion)
      ? [
          "package/dist/resource-monitor/darwin-arm64/dascode-resource-monitor",
          "package/dist/resource-monitor/darwin-x64/dascode-resource-monitor",
        ]
      : []),
  ].sort();
  invariant(
    JSON.stringify(Object.keys(inspected.resourceMonitors).sort()) ===
      JSON.stringify(expectedResourceMonitors),
    "npm package does not contain the exact release resource-monitor set.",
  );
  for (const [path, entry] of Object.entries(inspected.resourceMonitors)) {
    invariant(isRecord(entry), `npm resource-monitor record is invalid: ${path}.`);
    exactKeys(entry, ["mode", "size"]);
    invariant(Number.isSafeInteger(entry.size) && entry.size > 0, "npm package contains an empty resource monitor.");
    invariant(Number.isSafeInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o7777, "npm package contains an invalid resource-monitor mode.");
    if (path.includes("/darwin-")) {
      invariant((entry.mode & 0o100) !== 0, `npm package Darwin resource monitor is not owner-executable: ${path}.`);
    }
  }
}

const channelCookie = (channel) =>
  `dascode_web_channel=${channel}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`;

const expectedWebConfig = {
  version: 3,
  routes: [
    {
      src: "/__dascode/channel",
      has: [{ type: "query", key: "channel", value: "canary" }],
      headers: { Location: "https://canary.code.bclouder.dev" },
      status: 302,
    },
    {
      src: "/__dascode/channel",
      has: [{ type: "query", key: "channel", value: "nightly" }],
      headers: { Location: "/", "Set-Cookie": channelCookie("nightly") },
      status: 302,
    },
    {
      src: "/__dascode/channel",
      headers: { Location: "/", "Set-Cookie": channelCookie("latest") },
      status: 302,
    },
    {
      src: "/(.*)",
      has: [
        { type: "host", value: "code.bclouder.dev" },
        { type: "cookie", key: "dascode_web_channel", value: "nightly" },
      ],
      dest: "https://nightly.code.bclouder.dev/$1",
    },
    {
      src: "/(.*)",
      has: [{ type: "host", value: "code.bclouder.dev" }],
      dest: "https://latest.code.bclouder.dev/$1",
    },
    { handle: "filesystem" },
    { src: "/(.*)", dest: "/index.html" },
  ],
};

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJson(value[key])]),
  );
}

export function validateWebConfig(config) {
  invariant(
    JSON.stringify(canonicalJson(config)) === JSON.stringify(canonicalJson(expectedWebConfig)),
    "Vercel Build Output config must exactly match the reviewed channel-isolated routes.",
  );
}

export function validateWebArchive(path, expected) {
  const inspected = inspectTar("web", path);
  validateWebConfig(inspected.config);
  exactKeys(inspected.release, ["schemaVersion", "channel", "version", "sourceSha"]);
  invariant(inspected.release.schemaVersion === 1, "Web release marker schema mismatch.");
  invariant(inspected.release.channel === expected.channel, "Web release marker channel mismatch.");
  invariant(inspected.release.version === expected.version, "Web release marker version mismatch.");
  invariant(inspected.release.sourceSha === expected.sourceSha, "Web release marker source SHA mismatch.");
}

export async function validateBundleDirectory(root, expected) {
  const absoluteRoot = resolve(root);
  const actualFiles = listFiles(absoluteRoot);
  invariant(actualFiles.includes("release-manifest.json"), "Bundle has no release-manifest.json.");
  invariant(actualFiles.includes("SHA256SUMS"), "Bundle has no SHA256SUMS.");
  const manifest = validateManifest(
    JSON.parse(readFileSync(join(absoluteRoot, "release-manifest.json"), "utf8")),
    expected,
  );
  const sums = parseSha256Sums(readFileSync(join(absoluteRoot, "SHA256SUMS"), "utf8"));
  const expectedFiles = ["SHA256SUMS", "release-manifest.json", ...manifest.files.map((file) => file.path)].sort();
  invariant(JSON.stringify(actualFiles) === JSON.stringify(expectedFiles), "Bundle contains missing or unlisted files.");
  invariant(sums.size === manifest.files.length + 1, "SHA256SUMS file count mismatch.");
  invariant(sums.get("release-manifest.json") === await sha256File(join(absoluteRoot, "release-manifest.json")), "Manifest checksum mismatch.");
  for (const file of manifest.files) {
    invariant(sums.get(file.path) === file.sha256, `SHA256SUMS disagrees for ${file.path}.`);
    const absolute = resolve(absoluteRoot, file.path);
    invariant(absolute.startsWith(`${absoluteRoot}${sep}`), `Bundle path escapes root: ${file.path}.`);
    const stat = lstatSync(absolute);
    invariant(stat.size === file.size, `File size mismatch for ${file.path}.`);
    invariant((await sha256File(absolute)) === file.sha256, `File hash mismatch for ${file.path}.`);
    if (file.sha512 !== undefined) invariant((await sha512File(absolute)) === file.sha512, `File SHA-512 mismatch for ${file.path}.`);
  }
  const updaterFile = manifest.files.find((file) => file.role === "desktop-updater-manifest");
  validateWindowsUpdaterMetadata(readFileSync(join(absoluteRoot, updaterFile.path), "utf8"), manifest, absoluteRoot);
  if (manifest.channel === "canary") {
    const macUpdaterFile = manifest.files.find((file) => file.role === "desktop-macos-updater-manifest");
    validateMacUpdaterMetadata(
      readFileSync(join(absoluteRoot, macUpdaterFile.path), "utf8"),
      manifest,
      absoluteRoot,
    );
  }
  const npmFile = manifest.files.find((file) => file.role === "npm-package");
  const webFile = manifest.files.find((file) => file.role === "web-prebuilt");
  validateNpmArchive(join(absoluteRoot, npmFile.path), expected.version);
  validateWebArchive(join(absoluteRoot, webFile.path), expected);
  return manifest;
}

export function filesForRoles(manifest, selectedRoles) {
  const selected = new Set(selectedRoles);
  return manifest.files.filter((file) => selected.has(file.role)).map((file) => file.path);
}
