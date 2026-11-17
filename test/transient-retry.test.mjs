import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { downloadArtifact } from "../scripts/worker-client.mjs";
import { fetchRead, readUntil } from "../scripts/lib/transient-retry.mjs";

const noSleep = async () => {};
const respond = (status, body = "") => new Response(body, { status });

function sequence(...steps) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step instanceof Error) throw step;
    return step();
  };
  return { fetchImpl, calls };
}

test("reads retry transient statuses and then return the good response", async () => {
  const { fetchImpl, calls } = sequence(() => respond(503), () => respond(502), () => respond(200, "ok"));
  const response = await fetchRead("https://x/y", {}, { fetchImpl, sleep: noSleep });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 3);
});

test("reads never retry a definite answer", async () => {
  for (const status of [200, 201, 400, 401, 403, 404, 409, 422]) {
    const { fetchImpl, calls } = sequence(() => respond(status));
    const response = await fetchRead("https://x/y", {}, { fetchImpl, sleep: noSleep });
    assert.equal(response.status, status);
    assert.equal(calls.length, 1, `HTTP ${status}`);
  }
});

test("reads retry network errors and give up after the bounded delays", async () => {
  const failure = new TypeError("fetch failed");
  const { fetchImpl, calls } = sequence(failure);
  await assert.rejects(fetchRead("https://x/y", {}, { fetchImpl, sleep: noSleep }), /fetch failed/);
  assert.equal(calls.length, 4);
});

test("a persistently transient status is returned to the caller's strict check", async () => {
  const { fetchImpl, calls } = sequence(() => respond(503));
  const response = await fetchRead("https://x/y", {}, { fetchImpl, sleep: noSleep });
  assert.equal(response.status, 503);
  assert.equal(calls.length, 4);
});

test("writes are sent exactly once, even when the response is transient", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const { fetchImpl, calls } = sequence(() => respond(503));
    const response = await fetchRead("https://x/y", { method }, { fetchImpl, sleep: noSleep });
    assert.equal(response.status, 503);
    assert.equal(calls.length, 1, method);
  }
});

test("each attempt gets a fresh timeout signal", async () => {
  const { fetchImpl, calls } = sequence(() => respond(503), () => respond(200));
  await fetchRead("https://x/y", {}, { fetchImpl, sleep: noSleep, timeoutMs: 1_000 });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.notEqual(calls[0].init.signal, calls[1].init.signal);
});

test("read-after-write polling stops at the first accepted value", async () => {
  let reads = 0;
  const value = await readUntil(async () => ++reads, (candidate) => candidate === 3, { sleep: noSleep });
  assert.equal(value, 3);
  assert.equal(reads, 3);
});

test("read-after-write polling returns the last value when the budget is spent", async () => {
  let reads = 0;
  const value = await readUntil(async () => ++reads, () => false, { attempts: 4, sleep: noSleep });
  assert.equal(value, 4);
});

const artifact = "artifact bytes";
const digest = `sha256:${createHash("sha256").update(artifact).digest("hex")}`;
const artifactUrl = "https://api.github.com/repos/B-DasApp/DasCode/actions/artifacts/7/zip";

async function withArtifactFetch(storage, body) {
  const original = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    if (String(url).startsWith("https://api.github.com/")) {
      return new Response(null, { status: 302, headers: { location: `https://storage.example/signed-${requested.length}` } });
    }
    return storage(requested.length);
  };
  try {
    return await body(requested);
  } finally {
    globalThis.fetch = original;
  }
}

test("artifact download requests a fresh signed URL after a failed transfer", async () => {
  const destination = join(mkdtempSync(join(tmpdir(), "artifact-")), "bundle.zip");
  await withArtifactFetch(
    (count) => (count < 4 ? respond(500) : respond(200, artifact)),
    async (requested) => {
      await downloadArtifact("token", artifactUrl, destination, digest, { sleep: noSleep });
      assert.equal(readFileSync(destination, "utf8"), artifact);
      assert.equal(requested.filter((url) => url.startsWith("https://api.github.com/")).length, 2);
      assert.equal(new Set(requested.filter((url) => url.startsWith("https://storage.example/"))).size, 2);
    },
  );
});

test("artifact download gives up after bounded attempts", async () => {
  const destination = join(mkdtempSync(join(tmpdir(), "artifact-")), "bundle.zip");
  await withArtifactFetch(
    () => respond(500),
    async () => {
      await assert.rejects(downloadArtifact("token", artifactUrl, destination, digest, { sleep: noSleep }), /Artifact storage returned HTTP 500/);
    },
  );
});

test("a digest mismatch is final and is never retried", async () => {
  const destination = join(mkdtempSync(join(tmpdir(), "artifact-")), "bundle.zip");
  await withArtifactFetch(
    () => respond(200, "tampered"),
    async (requested) => {
      await assert.rejects(downloadArtifact("token", artifactUrl, destination, digest, { sleep: noSleep }), /digest mismatch/);
      assert.equal(requested.filter((url) => url.startsWith("https://storage.example/")).length, 1);
    },
  );
});
