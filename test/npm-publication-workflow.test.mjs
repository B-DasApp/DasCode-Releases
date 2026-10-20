import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
// Execute the workflow's actual single-line commands, including their CLI flags.
const commands = [...workflow.matchAll(/^\s*run: (.*verify-npm-publication\.mjs.*)$/gmu)]
  .map((match) => match[1]);
const version = "0.0.37-nightly.20261020.91";
const priorVersion = "0.0.37-nightly.20261020.90";
const bytes = Buffer.from("canonical npm publication bytes");
const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

test("workflow npm verification callers honor the CLI output and integrity contract", async (t) => {
  assert.equal(commands.length, 4, "exercise every current publication verification caller");
  for (const [index, command] of commands.entries()) {
    const before = command.includes("--phase before");
    for (const state of before ? ["unpublished", "published", "mismatch"] : ["published", "mismatch"]) {
      await t.test(`caller ${index + 1}, ${before ? "before" : "after"}, ${state}`, (t) => {
        const root = mkdtempSync(join(tmpdir(), "dascode-npm-workflow-"));
        t.after(() => rmSync(root, { recursive: true, force: true }));
        const tarball = join(root, "canonical-npm", "dascode.tgz");
        mkdirSync(join(root, "canonical-npm"));
        writeFileSync(tarball, bytes);
        const output = join(root, "github-output");
        writeFileSync(output, "");

        const responses = {
          [`https://registry.npmjs.org/@das-org%2Fdascode/${version}?write=true`]:
            state === "unpublished" ? null : {
              name: "@das-org/dascode",
              version,
              dist: { integrity: state === "mismatch" ? "sha512-other" : integrity },
            },
          "https://registry.npmjs.org/-/package/@das-org%2Fdascode/dist-tags?write=true": {
            nightly: state === "unpublished" ? priorVersion : version,
          },
        };
        const preload = join(root, "registry.mjs");
        writeFileSync(preload, `
          import assert from "node:assert/strict";
          const responses = ${JSON.stringify(responses)};
          globalThis.fetch = async (url) => {
            assert.ok(Object.hasOwn(responses, String(url)), "unexpected registry URL");
            const value = responses[String(url)];
            return value === null ? new Response(null, { status: 404 }) : Response.json(value);
          };
        `);
        const values = {
          "steps.npm-package.outputs.path": tarball,
          "steps.bundle.outputs.version": version,
          "steps.bundle.outputs.npm_dist_tag": "nightly",
          "needs.authorize.outputs.version": version,
          "needs.authorize.outputs.npm_dist_tag": "nightly",
        };
        const rendered = command.replace(/\$\{\{\s*([^}]+?)\s*\}\}/gu, (_, expression) => {
          assert.ok(Object.hasOwn(values, expression), `unknown workflow expression: ${expression}`);
          return values[expression];
        });
        const result = spawnSync("bash", ["-e", "-c", rendered], {
          cwd: repository,
          env: {
            ...process.env,
            GITHUB_WORKSPACE: repository,
            RUNNER_TEMP: root,
            GITHUB_OUTPUT: output,
            NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
          },
          encoding: "utf8",
          timeout: 5_000,
        });
        assert.ifError(result.error);
        assert.equal(result.status, state === "mismatch" ? 1 : 0, result.stderr);
        assert.equal(
          readFileSync(output, "utf8"),
          before && state !== "mismatch" ? `should_publish=${state === "unpublished"}\n` : "",
        );
        if (state === "mismatch") assert.match(result.stderr, /integrity does not match/);
        else assert.match(result.stdout, /verification attempt 1 succeeded/);
      });
    }
  }
});
