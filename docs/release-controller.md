# Protected release controller

`B-DasApp/DasCode-Releases` is the public, protected trust anchor for Stable, Nightly, and Canary.
The private source repository builds without publication credentials. This repository verifies the
exact GitHub run and every byte before npm, GitHub Releases, or Vercel receives credentials.

The workflow is intentionally inert on this feature branch. Do not dispatch it until the repository
and environment controls below are configured.

Phase 1 is manual for all three channels. Rebinding npm's sole trusted publisher moves Stable,
Nightly, and Canary together, but this controller does not yet mirror the private Stable tag trigger
or daily Nightly schedule. Freeze those legacy publication triggers at cutover and manually dispatch
the equivalent public request. If automatic cadence is required, design a protected public poller or
bridge before cutover; do not restore a credential to unprotected private workflow YAML.

## Trust boundaries

- Workflow-execution protection limits manual dispatch to the trusted maintainer, while both
  credential-bearing environments admit only exact protected `main` in repository ID `1320700776`.
- `source-reader` is the only job that can mint the GitHub App token. It checks private repository ID
  `1178338180`, fixed workflow ID `244380781`, fixed caller path `.github/workflows/release.yml`, the
  pinned worker-control ref/SHA, local reusable implementation path/SHA, separate source ref/SHA,
  run title, first attempt, conclusion, final artifact identity, and REST artifact digest. It never
  retrieves private logs.
- `production` gates three ordered publication jobs: npm, then a public desktop release, then Vercel.
  A credential-free job turns the verified npm payload into a frozen canonical artifact and passes
  its SHA-512 separately; the OIDC job verifies that identity. GitHub and Vercel each download the
  full immutable bundle from this controller run and repeat its validation before using it.
- The controller never checks out or executes private source. It safely extracts and canonically
  repacks the validated npm payload with lifecycle scripts/config forbidden and `--ignore-scripts`.
  Vercel receives only static Build Output;
  functions, middleware, source maps, environment files, and private project metadata are rejected.

The environment deployment-branch policies are essential. A workflow file selected from an
unprotected branch can contain different YAML even when this checked-in version would reject it.
Both secret-bearing environments must independently allow **only protected `main`**.

## Required GitHub setup

Before merging this workflow to public `main`:

1. Protect `main`. Require a pull request and the `Controller validation / Validate protected
   controller` check; enforce the rule for administrators and block force pushes and deletions.
   While `@valascus` is the only write-capable actor, require zero approvals: a PR author cannot
   approve their own change, so mandatory code-owner approval would deadlock maintenance. CODEOWNERS
   still covers every file. Enable one code-owner approval after adding a second trusted writer.
   Add an active tag ruleset for all tags that restricts creation, updates, and deletions. Give only
   the release-publisher GitHub App an always-bypass. The controller atomically creates each exact
   release tag; a pre-created wrong tag fails closed.
2. Configure Actions to allow only actions pinned to full commit SHAs. Set the default workflow token
   to read-only. No job grants the built-in workflow token write access. Repository write access is
   already required to invoke `workflow_dispatch`; if the organization exposes workflow-execution
   protection, additionally restrict manual runs to the trusted maintainer/admin actor as
   defense-in-depth.
3. Enable immutable releases after confirming the existing feed is compatible. The controller also
   refuses to overwrite any published asset and verifies every REST asset digest before publishing a
   draft.
4. Create the `source-reader` environment. Restrict deployment branches to protected `main`, add a
   required reviewer, and add:
   - secret `SOURCE_READER_APP_ID`
   - secret `SOURCE_READER_PRIVATE_KEY`
5. Install that GitHub App only on private `B-DasApp/DasCode`, with **Actions: read/write** and
   **Contents: read**. It needs no administration, issues, pull requests, environments, packages, or
   release-repository access.
6. Create the `production` environment with the same exact-main restriction and a required reviewer.
   Add `VERCEL_TOKEN`, `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID`; optionally add variable
   `VERCEL_TEAM_SLUG`.
7. Create a second GitHub App installed only on public `B-DasApp/DasCode-Releases`, with
   **Contents: read/write** and no other writable repository permission. Add its
   `RELEASE_PUBLISHER_APP_ID` and `RELEASE_PUBLISHER_PRIVATE_KEY` to `production`, then select this App
   as the sole all-tags ruleset bypass actor.

The following public client-build values must be environment or repository variables available to
`source-reader`:

- `DASCODE_RELAY_URL`
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_JWT_TEMPLATE`
- `CLERK_CLI_OAUTH_CLIENT_ID`
- `T3CODE_POSTHOG_KEY`
- `T3CODE_POSTHOG_HOST`
- `T3CODE_RELAY_CLIENT_OTLP_TRACES_URL`
- `T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET`
- `T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN`

These values are embedded in downloadable clients and must not be privileged credentials. If any
value must remain secret, do not pass it as a workflow-dispatch input; redesign the client protocol.
Hosted domains are fixed to `code.bclouder.dev`, `latest.code.bclouder.dev`,
`nightly.code.bclouder.dev`, and `canary.code.bclouder.dev` to prevent a reviewed channel from being
published onto another channel's origin.

## npm trusted publisher

Configure the sole trusted publisher for `@das-org/dascode` as:

- owner: `B-DasApp`
- repository: `DasCode-Releases`
- workflow filename: `release.yml`
- environment: `production`
- allowed action: `npm publish`

The worker rewrites the packed npm metadata to repository URL
`git+https://github.com/B-DasApp/DasCode-Releases.git`, which npm requires to match this publisher.
The controller rejects `repository.directory`, `scripts`, registry-bearing `publishConfig`, and
archived `.npmrc`; the sole allowed publish setting is exact public access.
The controller uses npm `11.16.0`, bundled with pinned Node `24.18.0`, both to canonicalize and to
publish. Vercel `59.1.3` is installed from the committed integrity lockfile with lifecycle scripts
disabled, and its compatible `tar` dependency is overridden to patched `7.5.22`. Its upstream package
currently reports advisories predominantly in dormant framework/build adapters, plus advisories in
the CLI's pinned HTTP client for which Vercel exposes no compatible patched release. The controller
never runs `vercel build`, rejects functions and source configuration, gives the CLI only a
controller-validated Build Output v3 static tree, and permits its network client to address only the
fixed Vercel HTTPS service. Canonical npm
bytes cross into the production job only as a frozen artifact plus an
independently supplied SHA-512. That job verifies the digest before publishing with OIDC provenance
and no npm token. A candidate must move its channel dist-tag forward; a retry succeeds only if the
registry's SHA-512 integrity and channel dist-tag already match exactly.

## Landing and first dispatch

GitHub only accepts `workflow_dispatch` for a workflow path that exists on the repository's default
branch, while the branch selected in the UI determines the workflow SHA. Therefore:

1. Push the reviewed private worker commit and create
   `refs/heads/dascode/release-worker-controller` at that exact SHA. The public controller hardcodes
   both values and refuses a moved ref. The selected Canary/Nightly/Stable source ref is separate and
   cannot choose the executing workflow YAML.
2. Configure public branch/environment protections, then merge this controller as
   `.github/workflows/release.yml` to public `main`. A feature-branch copy is not releasable.
3. Confirm the npm trusted-publisher binding and all Vercel domains/TLS.
4. Select public `main` in **Run workflow**, choose the channel, enter the full private ref and its full
   lowercase commit SHA, review the `source-reader` deployment, then review `production` only after
   bundle verification succeeds.

Allowed sources are deliberately channel-bound:

- Stable: exact `refs/tags/vX.Y.Z`; that tag supplies the version.
- Nightly: exact `refs/heads/dascode/main`.
- Canary: an approved branch below `refs/heads/dascode/`, excluding `dascode/main`. This permits the
  integration branch before promotion while the protected public controller and environment review
  remain the release trust anchor. Its `.canary-source.json` commit must be an ancestor of the source
  SHA.

If a Stable or Nightly source contains `.canary-source.json`, the controller independently compares
that marker and rejects the request when the pinned Canary commit is an ancestor. The private worker
performs the corresponding repository-level channel audit as defense in depth.

Nightly and Canary use the next patch after the latest published Stable GitHub Release, UTC date, and
controller run number. The request ID binds the controller run/attempt, channel, and source SHA. Rerunning a
private worker attempt is rejected. For a transient publication failure, rerun only the failed jobs
in the same controller run so they reuse the verified bundle identity. The authorization job refuses
workflow run attempts after attempt 1; do not use **Re-run all jobs**.

Example after setup (do not run during installation):

```sh
gh workflow run release.yml \
  --repo B-DasApp/DasCode-Releases \
  --ref main \
  -f channel=canary \
  -f source_ref=refs/heads/dascode/add-canary-release-channel \
  -f source_sha=<full-lowercase-commit-sha>
```

The controller verifies the raw Vercel deployment's exact `__dascode/release.json` identity before
moving any alias. For Stable, it then attaches `latest.code.bclouder.dev` and the router
`code.bclouder.dev`; Nightly and Canary update only their direct origins. Every alias must serve the
same exact identity over valid HTTPS before the job succeeds.
