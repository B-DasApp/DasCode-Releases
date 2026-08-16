#!/usr/bin/env node

import { createReadStream, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { releaseAssetNames, sha256File } from "./lib/release-contract.mjs";

const repository = "B-DasApp/DasCode-Releases";
const apiRoot = "https://api.github.com";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`Missing --${name}.`);
  return value;
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function api(token, url, init = {}, statuses = [200]) {
  const response = await fetch(url.startsWith("https:") ? url : `${apiRoot}${url}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "dascode-public-release-controller",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(10 * 60_000),
    ...(init.body instanceof ReadableStream ? { duplex: "half" } : {}),
  });
  if (!statuses.includes(response.status)) throw new Error(`GitHub release API returned HTTP ${response.status}; body suppressed.`);
  return response;
}

async function listReleases(token) {
  const releases = [];
  for (let page = 1; page <= 100; page += 1) {
    const response = await api(
      token,
      `/repos/${repository}/releases?per_page=100&page=${page}`,
    );
    const batch = await response.json();
    invariant(Array.isArray(batch), "GitHub returned an invalid release listing.");
    releases.push(...batch);
    if (batch.length < 100) return releases;
  }
  throw new Error("Release listing exceeded the controller's bounded pagination limit.");
}

async function requireImmutableRelease(token, releaseId, tag) {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const response = await api(token, `/repos/${repository}/releases/${releaseId}`);
    const release = await response.json();
    invariant(
      release.tag_name === tag && release.draft === false,
      "Published release identity changed while verifying immutability.",
    );
    if (release.immutable === true) return;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(
    "Published release did not become immutable; verify the repository immutable-releases setting.",
  );
}

async function requireReleaseTag(token, tag, target, createIfMissing) {
  let response = await api(
    token,
    `/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`,
    {},
    [200, 404],
  );
  if (response.status === 404 && createIfMissing) {
    await api(
      token,
      `/repos/${repository}/git/refs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref: `refs/tags/${tag}`, sha: target }),
      },
      [201],
    );
    response = await api(
      token,
      `/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`,
    );
  }
  invariant(response.status === 200, "Release tag is missing after exact creation.");
  const ref = await response.json();
  invariant(
    ref.ref === `refs/tags/${tag}` && ref.object?.type === "commit" && ref.object.sha === target,
    "Release tag does not resolve directly to the protected controller commit.",
  );
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  invariant(token, "Missing workflow GitHub token.");
  const root = option("bundle-dir");
  const manifest = JSON.parse(readFileSync(join(root, "release-manifest.json"), "utf8"));
  const tag = option("tag");
  const target = option("target");
  const title = `DasCode ${tag}`;
  const prerelease = option("prerelease") === "true";
  const makeLatest = option("make-latest") === "true";
  const body = `Verified ${manifest.channel} release built from source commit ${manifest.source.sha}.\n\nController contract: ${JSON.stringify({ channel: manifest.channel, sourceSha: manifest.source.sha, makeLatest })}`;
  const repoResponse = await api(token, `/repos/${repository}`);
  const repo = await repoResponse.json();
  invariant(String(repo.id) === "1320700776" && repo.full_name === repository, "Public release repository identity mismatch.");
  await requireReleaseTag(token, tag, target, true);
  const unorderedAssetPaths = [
    join(root, "release-manifest.json"),
    join(root, "SHA256SUMS"),
    ...manifest.files.filter((file) => file.role.startsWith("desktop-")).map((file) => join(root, file.path)),
  ];
  const roleOrder = new Map([["desktop-installer", 0], ["desktop-blockmap", 1], ["release-metadata", 2], ["desktop-updater-manifest", 3]]);
  const roleForPath = (path) => {
    const relative = path.slice(root.length + 1).replaceAll("\\", "/");
    if (relative === "release-manifest.json" || relative === "SHA256SUMS") return "release-metadata";
    return manifest.files.find((file) => file.path === relative)?.role;
  };
  const assetPaths = unorderedAssetPaths.sort((left, right) => roleOrder.get(roleForPath(left)) - roleOrder.get(roleForPath(right)));
  const names = releaseAssetNames(assetPaths);
  invariant(new Set(names.map((name) => name.toLowerCase())).size === names.length, "Release asset names collide.");
  const expected = new Map();
  for (const path of assetPaths) expected.set(basename(path), { digest: `sha256:${await sha256File(path)}`, size: statSync(path).size });
  const releases = await listReleases(token);
  const matching = releases.filter((release) => release.tag_name === tag);
  invariant(matching.length <= 1, "Multiple releases unexpectedly share the requested tag.");
  let release = matching[0];
  if (!release) {
    const create = await api(token, `/repos/${repository}/releases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag_name: tag, name: title, body, draft: true, prerelease, make_latest: makeLatest ? "true" : "false" }),
    }, [201]);
    release = await create.json();
  }
  invariant(release.tag_name === tag && release.name === title && release.body === body, "Existing release identity does not match this request.");
  invariant(release.prerelease === prerelease, "Existing release channel mismatch.");
  const uploadRoot = release.upload_url?.replace("{?name,label}", "");
  invariant(uploadRoot === `https://uploads.github.com/repos/${repository}/releases/${release.id}/assets`, "Release upload URL mismatch.");
  const existingAssetsResponse = await api(token, `/repos/${repository}/releases/${release.id}/assets?per_page=100`);
  const existingAssets = await existingAssetsResponse.json();
  for (const asset of existingAssets) {
    const wanted = expected.get(asset.name);
    invariant(wanted && asset.state === "uploaded", "Existing release has an unexpected or incomplete asset.");
    invariant(asset.size === wanted.size && asset.digest === wanted.digest, `Existing asset cannot be overwritten: ${asset.name}.`);
  }
  if (!release.draft) {
    invariant(existingAssets.length === expected.size, "Published release is missing verified assets and cannot be changed.");
    await requireImmutableRelease(token, release.id, tag);
    await requireReleaseTag(token, tag, target, false);
    process.stdout.write(`Existing published release ${tag} exactly matches the verified contract.\n`);
    return;
  }
  for (const path of assetPaths) {
    if (existingAssets.some((asset) => asset.name === basename(path))) continue;
    const stream = createReadStream(path);
    await api(token, `${uploadRoot}?name=${encodeURIComponent(basename(path))}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "Content-Length": String(statSync(path).size) },
      body: stream,
      duplex: "half",
    }, [201]);
  }
  const assetsResponse = await api(token, `/repos/${repository}/releases/${release.id}/assets?per_page=100`);
  const assets = await assetsResponse.json();
  invariant(assets.length === expected.size, "Draft release asset count mismatch.");
  for (const asset of assets) {
    const wanted = expected.get(asset.name);
    invariant(wanted && asset.state === "uploaded", "Draft release has an unexpected asset.");
    invariant(asset.size === wanted.size && asset.digest === wanted.digest, `Uploaded asset digest mismatch: ${asset.name}.`);
  }
  const publish = await api(token, `/repos/${repository}/releases/${release.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ draft: false }),
  });
  const published = await publish.json();
  invariant(published.draft === false && published.tag_name === tag, "Release did not publish from the verified draft.");
  await requireImmutableRelease(token, published.id, tag);
  await requireReleaseTag(token, tag, target, false);
  process.stdout.write(`Published immutable GitHub release ${tag}.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
