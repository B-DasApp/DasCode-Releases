#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderApprovalSummary } from "./lib/release-summary.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (!value || value.startsWith("--")) throw new Error(`Missing --${name}.`);
  return value;
}

const manifest = JSON.parse(readFileSync(join(option("bundle-dir"), "release-manifest.json"), "utf8"));
const markdown = renderApprovalSummary(manifest, { testMode: option("test-mode", "full") });
const target = process.env.GITHUB_STEP_SUMMARY;
if (target) appendFileSync(target, markdown, "utf8");
else process.stdout.write(markdown);
