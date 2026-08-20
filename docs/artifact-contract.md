# Private worker artifact contract

The fixed private caller `.github/workflows/release.yml` is dispatched with
`operation=build-bundle`. Its run name is exactly
`release-worker / <channel> / <request_id>`. The run must be attempt 1 at the separately pinned
`refs/heads/dascode/release-worker-controller` SHA, and the run API must identify
`.github/workflows/release-worker.yml` as the sole referenced reusable workflow at that same
worker-control ref/SHA. Every build checkout independently uses the requested source SHA.

The final Actions artifact is named `release-bundle-<request_id>`. Intermediate private build
artifacts may coexist; the controller selects only one exact, case-sensitive final name, verifies its
non-expired artifact ID and `sha256:` REST digest, and downloads it with a freshly minted App token.

The ZIP has this top-level structure and no unlisted files or links. Every channel, including
Canary, contains exactly five payloads. macOS payloads are currently disabled:

```text
release-manifest.json
SHA256SUMS
desktop/<Windows x64 installer>.exe
desktop/<Windows x64 installer>.exe.blockmap
desktop/latest.yml | nightly.yml | canary.yml
npm/<package>.tgz
web/vercel-prebuilt.tgz
```

`SHA256SUMS` contains lowercase SHA-256 entries for `release-manifest.json` and every payload (but not
for itself), using two spaces before the relative path. The JSON manifest uses schema version 2:

```json
{
  "schemaVersion": 2,
  "requestId": "dcr-<controller-run>-<attempt>-<channel>-<short-sha>",
  "channel": "canary",
  "source": {
    "repository": "B-DasApp/DasCode",
    "repositoryId": "1178338180",
    "ref": "refs/heads/dascode/add-canary-release-channel",
    "sha": "<40 hex>",
    "markerSha": "<40 hex or null>",
    "workflow": {
      "id": "244380781",
      "path": ".github/workflows/release.yml",
      "ref": "refs/heads/dascode/release-worker-controller",
      "sha": "<pinned worker-control sha>",
      "implementationPath": ".github/workflows/release-worker.yml",
      "implementationSha": "<pinned worker-control sha>",
      "runId": "<worker run id>",
      "runAttempt": 1,
      "headSha": "<pinned worker-control sha>"
    }
  },
  "controller": {
    "repository": "B-DasApp/DasCode-Releases",
    "repositoryId": "1320700776",
    "workflowSha": "<public protected main sha>",
    "runId": "<controller run id>",
    "runAttempt": 1
  },
  "release": {
    "version": "0.0.33-canary.20260816.90",
    "tag": "v0.0.33-canary.20260816.90",
    "npmDistTag": "canary",
    "prerelease": true,
    "makeLatest": false,
    "hostedDomain": "canary.code.bclouder.dev"
  },
  "createdAt": "2026-08-16T12:00:00Z",
  "files": [
    {
      "path": "desktop/DasCode.exe",
      "sha256": "<lowercase hex>",
      "sha512": "<base64 SHA-512>",
      "size": 123,
      "mediaType": "application/octet-stream",
      "role": "desktop-installer"
    }
  ]
}
```

Every payload has `path`, `sha256`, positive byte `size`, `mediaType`, and exactly one recognized
role. The roles are `desktop-installer`, `desktop-updater-manifest`, `desktop-blockmap`,
`npm-package`, and `web-prebuilt`. Every channel must have zero `desktop-macos-dmg` entries. The
Windows installer has base64 `sha512`.

The controller independently parses the Windows channel updater YAML and requires its version,
filename/URL, size, and both SHA-512 fields to match the single installer and its actual bytes.
There is no macOS updater manifest, ZIP, blockmap, or DMG. Case-colliding or additional files are
rejected.

The GitHub publisher uploads installers first, then the Windows blockmap, then `SHA256SUMS` and the
JSON manifest, and the Windows updater YAML last. This prevents that updater manifest from becoming
visible before its payload. Apple signing, macOS builds, and macOS auto-update are separate future
release-policy changes, not implicit properties of this contract.

The npm archive must contain a regular `package/package.json` for `@das-org/dascode`, the exact
release version, no `scripts`, no registry override, and this exact repository metadata. The only
allowed `publishConfig` is exactly `{ "access": "public" }`:

```json
{
  "repository": {
    "type": "git",
    "url": "git+https://github.com/B-DasApp/DasCode-Releases.git"
  }
}
```

Every npm archive must contain the non-empty Windows x64 resource monitor with no extra monitor
paths. The controller verifies this inventory before and after canonical npm repacking.

In a separate job with OIDC explicitly disabled, the controller safely extracts this archive without
links, special files, traversal, or `.npmrc`, repacks it with the integrity-locked npm CLI, and
revalidates the deterministic canonical tarball. It freezes those bytes as a dedicated artifact and
passes their SHA-512 through the job boundary. The production job verifies that digest before the
pinned Node distribution's bundled npm receives OIDC authority. Only those frozen npm-owned bytes are
published and later compared to the registry's SHA-512 integrity.

The prebuilt web tarball is rooted at `.vercel/output`, has Build Output API `config.json` version 3,
and may contain only `static/**`. It cannot contain functions, middleware, source maps, environment
files, links, devices, `.vercel/project.json`, or another root. The worker adds
`.vercel/output/static/__dascode/release.json` with exact schema/channel/version/source SHA. The
controller requires `config.json` to equal the reviewed five channel/router routes followed by the
filesystem handler and SPA fallback, with no extra headers, rewrites, or keys. It creates
`.vercel/project.json` locally from the protected production environment and never runs
`vercel build` or source configuration code.
