import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
  for (const [platform, binary] of [
    ["win32-x64", "dascode-resource-monitor.exe"],
    ["darwin-arm64", "dascode-resource-monitor"],
    ["darwin-x64", "dascode-resource-monitor"],
  ]) {
    const monitorDir = join(packageDir, "dist", "resource-monitor", platform);
    mkdirSync(monitorDir, { recursive: true });
    const monitorPath = join(monitorDir, binary);
    writeFileSync(monitorPath, `${platform}-monitor`);
    if (platform.startsWith("darwin-")) chmodSync(monitorPath, 0o755);
  }
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

test("rejects a Canary package missing a Darwin resource monitor", () => {
  const root = mkdtempSync(join(tmpdir(), "dascode-canonical-npm-monitor-"));
  const packageDir = join(root, "source", "package");
  mkdirSync(join(packageDir, "dist", "resource-monitor", "win32-x64"), { recursive: true });
  mkdirSync(join(packageDir, "dist", "resource-monitor", "darwin-arm64"), { recursive: true });
  mkdirSync(join(packageDir, "dist", "resource-monitor", "darwin-x64"), { recursive: true });
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
  writeFileSync(
    join(packageDir, "dist", "resource-monitor", "win32-x64", "dascode-resource-monitor.exe"),
    "windows-monitor",
  );
  writeFileSync(
    join(packageDir, "dist", "resource-monitor", "darwin-arm64", "dascode-resource-monitor"),
    "arm64-monitor",
  );
  const missingPath = join(
    packageDir,
    "dist",
    "resource-monitor",
    "darwin-x64",
    "dascode-resource-monitor",
  );
  writeFileSync(missingPath, "x64-monitor");
  unlinkSync(missingPath);
  const archive = join(root, "worker.tgz");
  execFileSync("tar", ["-czf", archive, "-C", join(root, "source"), "package"]);

  assert.throws(
    () =>
      prepareNpmPublication({
        archivePath: archive,
        version: "1.2.4-canary.20260816.9",
        outputDir: join(root, "output"),
      }),
    /exact release resource-monitor set/,
  );
});

test("rejects a non-executable Darwin resource monitor", () => {
  const root = mkdtempSync(join(tmpdir(), "dascode-canonical-npm-monitor-mode-"));
  const packageDir = join(root, "source", "package");
  mkdirSync(packageDir, { recursive: true });
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
  for (const [platform, binary, mode] of [
    ["win32-x64", "dascode-resource-monitor.exe", 0o644],
    ["darwin-arm64", "dascode-resource-monitor", 0o755],
    ["darwin-x64", "dascode-resource-monitor", 0o644],
  ]) {
    const monitorDir = join(packageDir, "dist", "resource-monitor", platform);
    mkdirSync(monitorDir, { recursive: true });
    const monitorPath = join(monitorDir, binary);
    writeFileSync(monitorPath, `${platform}-monitor`);
    chmodSync(monitorPath, mode);
  }
  const archive = join(root, "worker.tgz");
  execFileSync("tar", ["-czf", archive, "-C", join(root, "source"), "package"]);

  assert.throws(
    () =>
      prepareNpmPublication({
        archivePath: archive,
        version: "1.2.4-canary.20260816.9",
        outputDir: join(root, "output"),
      }),
    /Darwin resource monitor is not owner-executable/,
  );
});
