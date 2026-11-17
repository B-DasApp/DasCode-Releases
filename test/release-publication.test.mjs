import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderApprovalSummary, renderStageTable } from "../scripts/lib/release-summary.mjs";
import { verifyHostedMarker } from "../scripts/verify-hosted-marker.mjs";
import { verifyPublication, verifyReleaseAssets } from "../scripts/verify-publication.mjs";

const sha = "a".repeat(40);
const version = "0.0.40-nightly.20261117.7";
const noSleep = async () => {};
const digest = (text) => createHash("sha256").update(text).digest("hex");

const files = [
  { path: "desktop/DasCode-Setup.exe", role: "desktop-installer", size: 3_000_000, content: "exe" },
  { path: "desktop/DasCode-Setup.exe.blockmap", role: "desktop-blockmap", size: 2_000, content: "map" },
  { path: "desktop/nightly.yml", role: "desktop-updater-manifest", size: 500, content: "yml" },
  { path: `dascode-${version}-linux-x64.tar.gz`, role: "cli-archive", size: 9_000, content: "cli" },
  { path: "npm/dascode.tgz", role: "npm-package", size: 800, content: "npm" },
  { path: "web/vercel-prebuilt.tgz", role: "web-prebuilt", size: 700, content: "web" },
].map((file) => ({ ...file, sha256: digest(file.content), mediaType: "application/octet-stream" }));

const manifest = {
  schemaVersion: 5,
  channel: "nightly",
  source: { ref: "refs/heads/dascode/main", sha, workflow: { runId: 11 } },
  controller: { runId: 22, runAttempt: 1 },
  release: {
    version,
    tag: `v${version}`,
    npmDistTag: "nightly",
    prerelease: true,
    hostedDomain: "nightly.code.bclouder.dev",
    desktopTargets: "windows",
    runtimeTargets: ["linux-x64"],
  },
  files: files.map(({ content, ...file }) => file),
};
const manifestText = JSON.stringify(manifest);
const sumsText = `${[
  `${digest(manifestText)}  release-manifest.json`,
  ...manifest.files.map((file) => `${file.sha256}  ${file.path}`),
].join("\n")}\n`;

function publishedRelease(overrides = {}) {
  const published = manifest.files.filter((file) => file.role.startsWith("desktop-") || file.role === "cli-archive");
  return {
    tag_name: manifest.release.tag,
    draft: false,
    immutable: true,
    prerelease: true,
    assets: [
      { name: "release-manifest.json", state: "uploaded", size: manifestText.length, digest: `sha256:${digest(manifestText)}` },
      { name: "SHA256SUMS", state: "uploaded", size: sumsText.length, digest: `sha256:${digest(sumsText)}` },
      ...published.map((file) => ({
        name: file.path.split("/").at(-1),
        state: "uploaded",
        size: file.size,
        digest: `sha256:${file.sha256}`,
      })),
    ],
    ...overrides,
  };
}

test("a release that matches the verified bundle passes", () => {
  assert.equal(verifyReleaseAssets({ release: publishedRelease(), manifest, sumsText }), 6);
});

test("every published-release mismatch fails closed", () => {
  const release = publishedRelease();
  const withAsset = (index, patch) => ({
    assets: release.assets.map((asset, position) => (position === index ? { ...asset, ...patch } : asset)),
  });
  const cases = [
    ["draft", { draft: true }, /draft/],
    ["mutable", { immutable: false }, /not immutable/],
    ["wrong tag", { tag_name: "v0.0.0" }, /tag mismatch/],
    ["prerelease flag", { prerelease: false }, /prerelease flag/],
    ["missing asset", { assets: release.assets.slice(1) }, /asset list differs/],
    ["extra asset", { assets: [...release.assets, { name: "extra.bin" }] }, /asset list differs/],
    ["digest drift", withAsset(2, { digest: `sha256:${"0".repeat(64)}` }), /digest mismatch/],
    ["size drift", withAsset(2, { size: 1 }), /size mismatch/],
    ["partial upload", withAsset(2, { state: "starter" }), /not fully uploaded/],
    ["tampered SHA256SUMS", withAsset(1, { digest: `sha256:${"0".repeat(64)}` }), /SHA256SUMS does not match/],
  ];
  for (const [name, patch, error] of cases) {
    assert.throws(() => verifyReleaseAssets({ release: { ...release, ...patch }, manifest, sumsText }), error, name);
  }
});

const identity = { channel: "nightly", version, sourceSha: sha, verificationKey: "k", intervalMs: 0, sleep: noSleep };
const marker = { schemaVersion: 1, channel: "nightly", version, sourceSha: sha };

test("the hosted marker is accepted once it serves the exact identity", async () => {
  let calls = 0;
  await verifyHostedMarker({
    origin: "https://nightly.example/",
    ...identity,
    fetchImpl: async (url) => {
      calls += 1;
      assert.match(String(url), /^https:\/\/nightly\.example\/__dascode\/release\.json\?verify=k-\d+$/u);
      return calls < 3 ? Response.json({ ...marker, version: "0.0.1" }) : Response.json(marker);
    },
  });
  assert.equal(calls, 3);
});

test("the hosted marker fails closed after bounded attempts", async () => {
  let calls = 0;
  await assert.rejects(
    verifyHostedMarker({
      origin: "https://nightly.example",
      ...identity,
      attempts: 4,
      fetchImpl: async () => {
        calls += 1;
        return new Response("nope", { status: 503 });
      },
    }),
    /did not serve the exact release identity/,
  );
  assert.equal(calls, 4);
});

test("publication verification checks the release, then the hosted identity", async () => {
  const bundleDir = mkdtempSync(join(tmpdir(), "publication-"));
  writeFileSync(join(bundleDir, "release-manifest.json"), manifestText);
  writeFileSync(join(bundleDir, "SHA256SUMS"), sumsText);
  const requested = [];
  const result = await verifyPublication({
    bundleDir,
    sleep: noSleep,
    fetchImpl: async (url) => {
      requested.push(String(url));
      return String(url).includes("/releases/tags/") ? Response.json(publishedRelease()) : Response.json(marker);
    },
  });
  assert.deepEqual(result, { assets: 6, origins: ["https://nightly.code.bclouder.dev"] });
  assert.match(requested[0], /repos\/B-DasApp\/DasCode-Releases\/releases\/tags\/v0\.0\.40-nightly/u);
  assert.equal(requested.length, 2);
});

test("a missing published release fails verification", async () => {
  const bundleDir = mkdtempSync(join(tmpdir(), "publication-"));
  writeFileSync(join(bundleDir, "release-manifest.json"), manifestText);
  writeFileSync(join(bundleDir, "SHA256SUMS"), sumsText);
  await assert.rejects(
    verifyPublication({ bundleDir, sleep: noSleep, fetchImpl: async () => new Response("", { status: 404 }) }),
    /release lookup returned HTTP 404/,
  );
});

test("the approval summary shows what will be published and escapes table cells", () => {
  const text = renderApprovalSummary({ ...manifest, channel: "nightly|x" }, { testMode: "ci-evidence" });
  assert.match(text, new RegExp(`Release awaiting approval: ${version.replaceAll(".", "\\.")}`));
  assert.match(text, /nightly x/);
  assert.match(text, /ci-evidence/);
  assert.match(text, /6 verified files/);
  assert.match(text, new RegExp(`@das-org/dascode@${version.replaceAll(".", "\\.")}`));
  assert.ok(text.includes(`\`${sha}\``));
  assert.equal(renderStageTable([{ name: "acquire", result: "success" }, { name: "publish" }]).includes("not run"), true);
});
