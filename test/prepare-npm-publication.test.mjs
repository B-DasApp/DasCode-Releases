import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareNpmPublication } from "../scripts/prepare-npm-publication.mjs";

function digest(path) {
  return createHash("sha512").update(readFileSync(path)).digest("hex");
}

test("safely repacks a worker archive into deterministic npm-owned bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "dascode-canonical-npm-"));
  const packageDir = join(root, "source", "package");
  mkdirSync(join(packageDir, "dist"), { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({
      name: "@das-org/dascode",
      version: "1.2.4-canary.20260816.9",
      repository: {
        type: "git",
        url: "git+https://github.com/B-DasApp/DasCode-Releases.git",
      },
    }),
  );
  writeFileSync(join(packageDir, "dist", "cli.js"), "console.log('ok');\n");
  const archive = join(root, "worker.tgz");
  execFileSync("tar", ["-czf", archive, "-C", join(root, "source"), "package"]);

  const first = prepareNpmPublication({
    archivePath: archive,
    version: "1.2.4-canary.20260816.9",
    outputDir: join(root, "first"),
  });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_100);
  const second = prepareNpmPublication({
    archivePath: archive,
    version: "1.2.4-canary.20260816.9",
    outputDir: join(root, "second"),
  });
  assert.equal(digest(first), digest(second));
});
