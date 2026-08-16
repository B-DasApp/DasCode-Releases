#!/usr/bin/env python3
"""Small dependency-light policy check for the release controller workflow."""

from __future__ import annotations

import json
import re
from pathlib import Path

WORKFLOW = Path(".github/workflows/release.yml")
SHA_PIN = re.compile(r"^\s*uses:\s*[^\s]+@[0-9a-f]{40}(?:\s*#.*)?$")


def main() -> None:
    text = WORKFLOW.read_text(encoding="utf-8")
    worker_text = Path("scripts/worker-client.mjs").read_text(encoding="utf-8")
    request_text = Path("scripts/validate-request.mjs").read_text(encoding="utf-8")
    publisher_text = Path("scripts/publish-github-release.mjs").read_text(encoding="utf-8")
    contract_text = Path("scripts/lib/release-contract.mjs").read_text(encoding="utf-8")
    if "\t" in text or not text.startswith("name:"):
        raise SystemExit("workflow must use a conventional dependency-free YAML form")
    uses_lines = [line for line in text.splitlines() if re.match(r"^\s*uses:", line)]
    if not uses_lines or any(not SHA_PIN.match(line) for line in uses_lines):
        raise SystemExit("every action must be pinned to a full immutable SHA")
    required = (
        "environment: source-reader",
        "environment: production",
        "retention-days: 30",
        '--controller-workflow-ref "$GITHUB_WORKFLOW_REF"',
        "npm ci --ignore-scripts --no-audit",
        'mkdir -p "$deploy_root/apps/web"',
        "node scripts/assign-vercel-alias.mjs",
        'vercel --cwd "$deploy_root" --token "$VERCEL_TOKEN"',
        'curl "$marker_path" --deployment "$origin" --yes',
        'verify_release_marker "$deployment_url" "Raw Vercel deployment" protected',
        'verify_release_marker "https://$domain" "Aliased deployment" public',
    )
    for marker in required:
        if marker not in text:
            raise SystemExit(f"workflow is missing policy marker: {marker}")
    for marker in ('operation: "build-bundle"', "return_run_details: true"):
        if marker not in worker_text:
            raise SystemExit(f"worker client is missing policy marker: {marker}")
    for marker in (
        'ref !== "refs/heads/main"',
        'refProtected !== "true"',
        "expectedWorkflowRef",
    ):
        if marker not in request_text:
            raise SystemExit(f"request validator is missing policy marker: {marker}")

    prepare_npm = text.split("  prepare-npm:\n", 1)[1].split("  publish-npm:\n", 1)[0]
    publish_npm = text.split("  publish-npm:\n", 1)[1].split("  publish-github:\n", 1)[0]
    publish_github = text.split("  publish-github:\n", 1)[1].split("  publish-web:\n", 1)[0]
    publish_web = text.split("  publish-web:\n", 1)[1]
    if "id-token: none" not in prepare_npm or "environment: production" in prepare_npm:
        raise SystemExit("npm canonicalization must remain outside the production/OIDC boundary")
    if "id-token: write" not in publish_npm or "environment: production" not in publish_npm:
        raise SystemExit("only the frozen npm publication job may receive npm OIDC authority")
    for forbidden in ("validate-bundle.mjs", "prepare-npm-publication.mjs", "npm ci"):
        if forbidden in publish_npm:
            raise SystemExit(f"OIDC publication job contains forbidden preparation step: {forbidden}")
    for forbidden in ("VERCEL_TEAM_SLUG", "--scope", "vercel alias"):
        if forbidden in publish_web:
            raise SystemExit(f"Vercel publication must use the exact linked org/project without {forbidden}")
    raw_verification = publish_web.split(
        'verify_release_marker "$deployment_url" "Raw Vercel deployment" protected', 1
    )[0]
    if '${origin%/}${marker_path}' not in publish_web or "[[ \"$access\" == protected ]]" not in publish_web:
        raise SystemExit("Vercel verification must distinguish protected raw and public alias access")
    if 'curl --fail' not in publish_web or "vercel --cwd" not in raw_verification:
        raise SystemExit("Vercel verification must retain both authenticated raw and public HTTPS checks")
    if "timeout-minutes: 45" not in publish_github:
        raise SystemExit("GitHub desktop publication must allow enough time for the full macOS asset set")
    if "target_commitish" in publisher_text:
        raise SystemExit("GitHub release metadata must not replace exact Git ref verification")
    for marker in (
        "desktop-macos-dmg",
        "desktop-macos-zip",
        "desktop-macos-blockmap",
        "desktop-macos-updater-manifest",
        "validateMacUpdaterMetadata",
    ):
        if marker not in contract_text:
            raise SystemExit(f"release contract is missing Canary macOS policy marker: {marker}")
    for marker in ("releaseAssetPaths", "const assetPaths = releaseAssetPaths(root, manifest)"):
        if marker not in publisher_text:
            raise SystemExit(f"GitHub publisher is missing deterministic asset-order policy: {marker}")
    control_sha = re.search(r'WORKER_CONTROL_SHA = "([0-9a-f]{40})"', contract_text)
    if control_sha is None or len(set(control_sha.group(1))) == 1:
        raise SystemExit("private worker-control SHA must be an exact non-placeholder commit")

    codeowners = Path(".github/CODEOWNERS").read_text(encoding="utf-8").splitlines()
    if not codeowners or codeowners[0] != "* @valascus":
        raise SystemExit("all release-controller files must have an explicit code owner")

    package = json.loads(Path("package.json").read_text(encoding="utf-8"))
    if package.get("overrides", {}).get("tar") != "7.5.22":
        raise SystemExit("the Vercel archive dependency must remain on patched tar 7.5.22")

    lockfile = Path("package-lock.json")
    if not lockfile.is_file() or '"lockfileVersion": 3' not in lockfile.read_text(encoding="utf-8"):
        raise SystemExit("release tools must use the committed npm lockfile v3")


if __name__ == "__main__":
    main()
