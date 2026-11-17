// Markdown for the run summary. The controller's logs and summaries are public, so this prints only
// versions, SHAs, public URLs and file names that the public release will expose anyway.

const cell = (value) => String(value).replace(/[|\r\n]/gu, " ");
const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/** What approving the release will publish, rendered before the human gate. */
export function renderApprovalSummary(manifest, { testMode = "full" } = {}) {
  const { release, source, controller } = manifest;
  const rows = [...manifest.files]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => `| ${cell(file.path)} | ${cell(file.role)} | ${mib(file.size)} | \`${file.sha256.slice(0, 16)}\` |`);
  return [
    `## Release awaiting approval: ${cell(release.version)}`,
    "",
    "| | |",
    "|---|---|",
    `| Channel | ${cell(manifest.channel)} |`,
    `| Tag | ${cell(release.tag)} |`,
    `| Source | ${cell(source.ref)} @ \`${source.sha}\` |`,
    `| Tests | ${cell(testMode)} |`,
    `| Desktop targets | ${cell(release.desktopTargets)} |`,
    `| Runtime targets | ${cell(release.runtimeTargets.join(", "))} |`,
    `| npm | @das-org/dascode@${cell(release.version)} (dist-tag ${cell(release.npmDistTag)}) |`,
    `| Hosted web | https://${cell(release.hostedDomain)} |`,
    `| Controller run | ${controller.runId} |`,
    `| Worker run | ${source.workflow.runId} |`,
    "",
    `### ${manifest.files.length} verified files (+ release-manifest.json and SHA256SUMS)`,
    "",
    "| File | Role | Size | SHA-256 |",
    "|---|---|---|---|",
    ...rows,
    "",
    "Approving publishes these exact bytes: the GitHub release, the npm package, then the hosted web build.",
    "",
  ].join("\n");
}

/** One row per controller stage for the final status table. */
export function renderStageTable(stages) {
  return [
    "## Release status",
    "",
    "| Stage | Result |",
    "|---|---|",
    ...stages.map(({ name, result }) => `| ${cell(name)} | ${cell(result ?? "not run")} |`),
    "",
  ].join("\n");
}
