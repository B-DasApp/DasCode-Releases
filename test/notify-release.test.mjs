import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { alertMessage, notify, summarizeStages } from "../scripts/notify-release.mjs";

const ok = (result = "success") => ({ result });
const allSuccess = {
  authorize: ok(), acquire: ok(), "prepare-npm": ok(), approve: ok(),
  "publish-github": ok(), "publish-npm": ok(), "publish-web": ok(), "verify-publication": ok(),
};
const runUrl = "https://github.com/B-DasApp/DasCode-Releases/actions/runs/1";

test("the first failed or cancelled stage in pipeline order is reported", () => {
  assert.equal(summarizeStages(allSuccess).failed, undefined);
  const failed = summarizeStages({ ...allSuccess, "publish-npm": ok("failure"), "publish-web": ok("skipped") }).failed;
  assert.equal(failed.name, "Publish npm package");
  assert.equal(summarizeStages({ ...allSuccess, acquire: ok("cancelled") }).failed.result, "cancelled");
});

test("skipped and missing stages are not failures", () => {
  assert.equal(summarizeStages({ authorize: ok(), acquire: ok("skipped") }).failed, undefined);
});

test("alert text names the stage and run only", () => {
  const message = alertMessage({ failed: { name: "Acquire verified private build", result: "failure" }, channel: "nightly", version: "0.0.1-nightly.1.1", runUrl });
  assert.equal(message, `DasCode nightly release 0.0.1-nightly.1.1 failed at "Acquire verified private build". ${runUrl}`);
});

test("a failure posts once to the webhook and always writes the summary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "notify-"));
  const summaryFile = join(dir, "summary.md");
  writeFileSync(summaryFile, "");
  const posts = [];
  const result = await notify({
    needs: { ...allSuccess, acquire: ok("failure") },
    channel: "nightly", version: "v", runUrl, webhook: "https://hooks.example/x", summaryFile,
    fetchImpl: async (url, init) => { posts.push({ url, body: JSON.parse(init.body) }); return new Response(null, { status: 204 }); },
  });
  assert.equal(result.posted, true);
  assert.equal(posts.length, 1);
  assert.match(posts[0].body.content, /failed at "Acquire verified private build"/);
  assert.match(readFileSync(summaryFile, "utf8"), /\| Acquire verified private build \| failure \|/);
});

test("success, or no webhook, posts nothing", async () => {
  const fetchImpl = async () => assert.fail("must not post");
  assert.equal((await notify({ needs: allSuccess, channel: "nightly", runUrl, webhook: "https://h", fetchImpl })).posted, false);
  assert.equal((await notify({ needs: { ...allSuccess, acquire: ok("failure") }, channel: "nightly", runUrl, fetchImpl })).posted, false);
});

test("an undeliverable alert surfaces as an error to the caller", async () => {
  await assert.rejects(
    notify({ needs: { ...allSuccess, acquire: ok("failure") }, channel: "n", runUrl, webhook: "https://h", fetchImpl: async () => new Response("", { status: 500 }) }),
    /HTTP 500/,
  );
});
