import assert from "node:assert/strict";
import test from "node:test";
import {
  NPM_REPOSITORY_URL,
  WORKER_CONTROL_REF,
  WORKER_CONTROL_SHA,
  buildRequestId,
  parseSha256Sums,
  parseUpdaterYaml,
  releaseAssetNames,
  releaseAssetPaths,
  resolveReleaseVersion,
  validateMacUpdaterMetadata,
  validateManifest,
  validateNpmMetadata,
  validateWebConfig,
} from "../scripts/lib/release-contract.mjs";

const sourceSha = "a".repeat(40);
const markerSha = "b".repeat(40);
const version = "0.0.33-canary.20260816.90";
const installerSha512 = `${"A".repeat(86)}==`;
const macSha512 = {
  arm64Dmg: `${"B".repeat(86)}==`,
  arm64Zip: `${"C".repeat(86)}==`,
  x64Dmg: `${"D".repeat(86)}==`,
  x64Zip: `${"E".repeat(86)}==`,
};

function manifest() {
  return {
    schemaVersion: 2,
    requestId: "dcr-123-1-canary-aaaaaaaaaaaa",
    channel: "canary",
    source: {
      repository: "B-DasApp/DasCode",
      repositoryId: "1178338180",
      ref: "refs/heads/dascode/add-canary-release-channel",
      sha: sourceSha,
      markerSha,
      workflow: {
        id: "244380781",
        path: ".github/workflows/release.yml",
        ref: WORKER_CONTROL_REF,
        sha: WORKER_CONTROL_SHA,
        implementationPath: ".github/workflows/release-worker.yml",
        implementationSha: WORKER_CONTROL_SHA,
        runId: "456",
        runAttempt: 1,
        headSha: WORKER_CONTROL_SHA,
      },
    },
    controller: {
      repository: "B-DasApp/DasCode-Releases",
      repositoryId: "1320700776",
      workflowSha: "c".repeat(40),
      runId: "123",
      runAttempt: 1,
    },
    release: {
      version,
      tag: `v${version}`,
      npmDistTag: "canary",
      prerelease: true,
      makeLatest: false,
      hostedDomain: "canary.code.bclouder.dev",
    },
    createdAt: "2026-08-16T12:00:00Z",
    files: [
      { path: "desktop/DasCode.exe", sha256: "1".repeat(64), sha512: installerSha512, size: 10, mediaType: "application/octet-stream", role: "desktop-installer" },
      { path: "desktop/canary.yml", sha256: "2".repeat(64), size: 11, mediaType: "text/yaml", role: "desktop-updater-manifest" },
      { path: "desktop/DasCode.exe.blockmap", sha256: "3".repeat(64), size: 12, mediaType: "application/octet-stream", role: "desktop-blockmap" },
      { path: "npm/dascode.tgz", sha256: "4".repeat(64), size: 13, mediaType: "application/gzip", role: "npm-package" },
      { path: "web/vercel-prebuilt.tgz", sha256: "5".repeat(64), size: 14, mediaType: "application/gzip", role: "web-prebuilt" },
      { path: `desktop/DasCode-Canary-${version}-arm64.dmg`, sha256: "6".repeat(64), sha512: macSha512.arm64Dmg, size: 16, mediaType: "application/x-apple-diskimage", role: "desktop-macos-dmg" },
      { path: `desktop/DasCode-Canary-${version}-arm64.zip`, sha256: "7".repeat(64), sha512: macSha512.arm64Zip, size: 17, mediaType: "application/zip", role: "desktop-macos-zip" },
      { path: `desktop/DasCode-Canary-${version}-x64.dmg`, sha256: "8".repeat(64), sha512: macSha512.x64Dmg, size: 18, mediaType: "application/x-apple-diskimage", role: "desktop-macos-dmg" },
      { path: `desktop/DasCode-Canary-${version}-x64.zip`, sha256: "9".repeat(64), sha512: macSha512.x64Zip, size: 19, mediaType: "application/zip", role: "desktop-macos-zip" },
      { path: `desktop/DasCode-Canary-${version}-arm64.dmg.blockmap`, sha256: "a".repeat(64), size: 20, mediaType: "application/octet-stream", role: "desktop-macos-blockmap" },
      { path: `desktop/DasCode-Canary-${version}-arm64.zip.blockmap`, sha256: "b".repeat(64), size: 21, mediaType: "application/octet-stream", role: "desktop-macos-blockmap" },
      { path: `desktop/DasCode-Canary-${version}-x64.dmg.blockmap`, sha256: "c".repeat(64), size: 22, mediaType: "application/octet-stream", role: "desktop-macos-blockmap" },
      { path: `desktop/DasCode-Canary-${version}-x64.zip.blockmap`, sha256: "d".repeat(64), size: 23, mediaType: "application/octet-stream", role: "desktop-macos-blockmap" },
      { path: "desktop/canary-mac.yml", sha256: "e".repeat(64), size: 24, mediaType: "application/yaml", role: "desktop-macos-updater-manifest" },
    ],
  };
}

function macUpdaterYaml() {
  return `version: ${version}
files:
  - url: DasCode-Canary-${version}-arm64.zip
    sha512: ${macSha512.arm64Zip}
    size: 17
  - url: DasCode-Canary-${version}-arm64.dmg
    sha512: ${macSha512.arm64Dmg}
    size: 16
  - url: DasCode-Canary-${version}-x64.zip
    sha512: ${macSha512.x64Zip}
    size: 19
  - url: DasCode-Canary-${version}-x64.dmg
    sha512: ${macSha512.x64Dmg}
    size: 18
releaseDate: '2026-08-16T12:00:00Z'
`;
}

const expected = {
  requestId: "dcr-123-1-canary-aaaaaaaaaaaa",
  channel: "canary",
  sourceRef: "refs/heads/dascode/add-canary-release-channel",
  sourceSha,
  canaryMarkerSha: markerSha,
  version,
  workerRunId: "456",
  workerRunAttempt: 1,
  controllerRunId: "123",
  controllerRunAttempt: 1,
  controllerWorkflowSha: "c".repeat(40),
};

test("resolves channel-bound versions from public stable tags", () => {
  assert.equal(resolveReleaseVersion({ channel: "stable", sourceRef: "refs/tags/v1.2.3", runNumber: "9", now: "2026-08-16T00:00:00Z" }), "1.2.3");
  assert.equal(resolveReleaseVersion({ channel: "nightly", sourceRef: "refs/heads/dascode/main", runNumber: "9", now: "2026-08-16T00:00:00Z", latestStableTag: "v1.10.2" }), "1.10.3-nightly.20260816.9");
  assert.equal(resolveReleaseVersion({ channel: "canary", sourceRef: "refs/heads/dascode/add-canary-release-channel", runNumber: "9", now: "2026-08-16T00:00:00Z", latestStableTag: "v1.2.3" }), "1.2.4-canary.20260816.9");
  assert.throws(() => resolveReleaseVersion({ channel: "canary", sourceRef: "refs/heads/dascode/main", runNumber: "9", now: "2026-08-16T00:00:00Z", latestStableTag: "v1.2.3" }), /Nightly source branch/);
  assert.throws(() => resolveReleaseVersion({ channel: "canary", sourceRef: "refs/heads/dascode/feature", runNumber: "9", now: "2026-08-16T00:00:00Z", latestStableTag: "v1.2.3-nightly.1" }), /latest published Stable/);
});

test("validates the exact cross-repository manifest identity", () => {
  assert.equal(validateManifest(manifest(), expected).release.npmDistTag, "canary");
  const wrong = manifest();
  wrong.release.npmDistTag = "latest";
  assert.throws(() => validateManifest(wrong, expected), /crosses release channels/);
  const wrongBlockmap = manifest();
  wrongBlockmap.files.find((file) => file.role === "desktop-blockmap").path =
    "desktop/unrelated.exe.blockmap";
  assert.throws(() => validateManifest(wrongBlockmap, expected), /blockmap does not belong/);

  const missingMacPayload = manifest();
  missingMacPayload.files = missingMacPayload.files.filter(
    (file) => file.path !== `desktop/DasCode-Canary-${version}-x64.zip`,
  );
  assert.throws(() => validateManifest(missingMacPayload, expected), /files count is invalid/);

  const wrongMacMediaType = manifest();
  wrongMacMediaType.files.find((file) => file.role === "desktop-macos-dmg").mediaType =
    "application/octet-stream";
  assert.throws(() => validateManifest(wrongMacMediaType, expected), /macOS DMG media type/);
});

test("keeps Stable and Nightly on the Windows-only desktop contract", () => {
  for (const channel of ["stable", "nightly"]) {
    const value = manifest();
    value.channel = channel;
    value.requestId = `dcr-123-1-${channel}-aaaaaaaaaaaa`;
    value.source.markerSha = null;
    value.files = value.files.filter((file) => !file.role.startsWith("desktop-macos-"));
    const channelExpected = {
      ...expected,
      requestId: value.requestId,
      channel,
      canaryMarkerSha: null,
    };
    if (channel === "stable") {
      value.source.ref = "refs/tags/v0.0.33";
      value.release = {
        version: "0.0.33",
        tag: "v0.0.33",
        npmDistTag: "latest",
        prerelease: false,
        makeLatest: true,
        hostedDomain: "latest.code.bclouder.dev",
      };
      value.files.find((file) => file.role === "desktop-updater-manifest").path =
        "desktop/latest.yml";
    } else {
      value.source.ref = "refs/heads/dascode/main";
      value.release = {
        version: "0.0.33-nightly.20260816.90",
        tag: "v0.0.33-nightly.20260816.90",
        npmDistTag: "nightly",
        prerelease: true,
        makeLatest: false,
        hostedDomain: "nightly.code.bclouder.dev",
      };
      value.files.find((file) => file.role === "desktop-updater-manifest").path =
        "desktop/nightly.yml";
    }
    channelExpected.sourceRef = value.source.ref;
    channelExpected.version = value.release.version;
    assert.equal(validateManifest(value, channelExpected).files.length, 5);
  }
});

test("requires npm trusted-publisher metadata and no lifecycle scripts", () => {
  validateNpmMetadata({ name: "@das-org/dascode", version: expected.version, repository: { type: "git", url: NPM_REPOSITORY_URL } }, expected.version);
  assert.throws(() => validateNpmMetadata({ name: "@das-org/dascode", version: expected.version, repository: { type: "git", url: NPM_REPOSITORY_URL }, scripts: {} }, expected.version), /lifecycle/);
  validateNpmMetadata({ name: "@das-org/dascode", version: expected.version, repository: { type: "git", url: NPM_REPOSITORY_URL }, publishConfig: { access: "public" } }, expected.version);
  assert.throws(() => validateNpmMetadata({ name: "@das-org/dascode", version: expected.version, repository: { type: "git", url: NPM_REPOSITORY_URL }, publishConfig: { access: "public", registry: "https://example.invalid" } }, expected.version), /Unexpected field/);
});

test("parses the updater subset used for independent linkage", () => {
  const parsed = parseUpdaterYaml(`version: ${expected.version}\nfiles:\n  - url: DasCode.exe\n    sha512: ${installerSha512}\n    size: 10\npath: DasCode.exe\nsha512: ${installerSha512}\nreleaseDate: '2026-08-16T12:00:00Z'\n`);
  assert.equal(parsed.files[0].size, 10);
  assert.equal(parsed.path, "DasCode.exe");
});

test("links every merged macOS updater entry to the exact Canary payload", () => {
  const linked = validateMacUpdaterMetadata(macUpdaterYaml(), manifest(), "/release");
  assert.equal(linked.length, 4);
  assert.equal(
    linked.find(({ payload }) => payload.path.endsWith("arm64.zip")).absolutePayload,
    `/release/desktop/DasCode-Canary-${version}-arm64.zip`,
  );

  const wrongSize = macUpdaterYaml().replace("    size: 17\n", "    size: 170\n");
  assert.throws(
    () => validateMacUpdaterMetadata(wrongSize, manifest(), "/release"),
    /macOS updater size mismatch/,
  );

  const wrongOrder = macUpdaterYaml()
    .replace(`DasCode-Canary-${version}-arm64.zip`, "SWAP")
    .replace(`DasCode-Canary-${version}-arm64.dmg`, `DasCode-Canary-${version}-arm64.zip`)
    .replace("SWAP", `DasCode-Canary-${version}-arm64.dmg`);
  assert.throws(
    () => validateMacUpdaterMetadata(wrongOrder, manifest(), "/release"),
    /payload order or identity/,
  );

  const missingReleaseDate = macUpdaterYaml().replace(
    "releaseDate: '2026-08-16T12:00:00Z'\n",
    "",
  );
  assert.throws(
    () => validateMacUpdaterMetadata(missingReleaseDate, manifest(), "/release"),
    /requires releaseDate/,
  );
});

test("SHA256SUMS includes the manifest and rejects duplicates", () => {
  const sums = parseSha256Sums(`${"a".repeat(64)}  release-manifest.json\n${"b".repeat(64)}  npm/dascode.tgz\n`);
  assert.equal(sums.size, 2);
  assert.throws(() => parseSha256Sums(`${"a".repeat(64)}  release-manifest.json\n${"b".repeat(64)}  release-manifest.json\n`), /Duplicate/);
});

test("request IDs bind run attempt, channel and source", () => {
  assert.equal(buildRequestId({ runId: "123", runAttempt: "2", channel: "canary", sourceSha }), "dcr-123-2-canary-aaaaaaaaaaaa");
});

test("maps release asset paths without forwarding array indexes as basename suffixes", () => {
  assert.deepEqual(
    releaseAssetNames([
      "/release/DasCode.exe",
      "/release/DasCode.exe.blockmap",
      "/release/canary.yml",
    ]),
    ["DasCode.exe", "DasCode.exe.blockmap", "canary.yml"],
  );
});

test("publishes the complete Canary desktop set in updater-safe deterministic order", () => {
  const names = releaseAssetNames(releaseAssetPaths("/release", manifest()));
  assert.equal(names.length, 14);
  assert.equal(new Set(names.map((name) => name.toLowerCase())).size, names.length);

  const payloadIndexes = names
    .map((name, index) => (/\.(?:exe|dmg|zip)$/u.test(name) ? index : -1))
    .filter((index) => index >= 0);
  const blockmapIndexes = names
    .map((name, index) => (name.endsWith(".blockmap") ? index : -1))
    .filter((index) => index >= 0);
  const metadataIndexes = [names.indexOf("SHA256SUMS"), names.indexOf("release-manifest.json")];
  const updaterIndexes = [names.indexOf("canary-mac.yml"), names.indexOf("canary.yml")];
  assert.ok(Math.max(...payloadIndexes) < Math.min(...blockmapIndexes));
  assert.ok(Math.max(...blockmapIndexes) < Math.min(...metadataIndexes));
  assert.ok(Math.max(...metadataIndexes) < Math.min(...updaterIndexes));
  assert.deepEqual(names.slice(-2), ["canary-mac.yml", "canary.yml"]);

  const unknownRole = manifest();
  unknownRole.files.find((file) => file.role === "desktop-installer").role =
    "desktop-unknown";
  assert.throws(
    () => releaseAssetPaths("/release", unknownRole),
    /Unsupported public release asset role/,
  );
});

test("requires the exact reviewed Vercel channel router", () => {
  const cookie = (channel) =>
    `dascode_web_channel=${channel}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`;
  const config = {
    version: 3,
    routes: [
      { src: "/__dascode/channel", has: [{ type: "query", key: "channel", value: "canary" }], headers: { Location: "https://canary.code.bclouder.dev" }, status: 302 },
      { src: "/__dascode/channel", has: [{ type: "query", key: "channel", value: "nightly" }], headers: { Location: "/", "Set-Cookie": cookie("nightly") }, status: 302 },
      { src: "/__dascode/channel", headers: { Location: "/", "Set-Cookie": cookie("latest") }, status: 302 },
      { src: "/(.*)", has: [{ type: "host", value: "code.bclouder.dev" }, { type: "cookie", key: "dascode_web_channel", value: "nightly" }], dest: "https://nightly.code.bclouder.dev/$1" },
      { src: "/(.*)", has: [{ type: "host", value: "code.bclouder.dev" }], dest: "https://latest.code.bclouder.dev/$1" },
      { handle: "filesystem" },
      { src: "/(.*)", dest: "/index.html" },
    ],
  };
  assert.doesNotThrow(() => validateWebConfig(config));
  const malicious = structuredClone(config);
  malicious.routes[4].dest = "https://canary.code.bclouder.dev/$1";
  assert.throws(() => validateWebConfig(malicious), /channel-isolated routes/);
});
