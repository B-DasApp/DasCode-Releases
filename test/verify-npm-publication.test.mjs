import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCandidateAdvances,
  comparePublicationVersions,
  createRegistryReader,
  TransientRegistryError,
  verifyNpmPublication,
} from "../scripts/verify-npm-publication.mjs";

const version = "0.0.37-nightly.20260928.80";
const priorVersion = "0.0.37-nightly.20260925.79";
const newerVersion = "0.0.37-nightly.20260929.81";
const distTag = "nightly";
const integrity = "sha512-frozen";

function metadata(overrides = {}) {
  return {
    name: "@das-org/dascode",
    version,
    dist: { integrity },
    ...overrides,
  };
}

function deterministicClock() {
  let time = 0;
  const sleeps = [];
  return {
    now: () => time,
    sleep: async (durationMs) => {
      sleeps.push(durationMs);
      time += durationMs;
    },
    sleeps,
  };
}

function sequenceReader(sequence) {
  let index = 0;
  return async () => {
    const value = sequence[Math.min(index, sequence.length - 1)];
    index += 1;
    if (value instanceof Error) throw value;
    return value;
  };
}

function verificationOptions(overrides = {}) {
  const clock = deterministicClock();
  return {
    phase: "after",
    version,
    distTag,
    integrity,
    now: clock.now,
    sleep: clock.sleep,
    log: () => {},
    timeoutMs: 30_000,
    intervalMs: 5_000,
    clock,
    ...overrides,
  };
}

test("compares Stable versions without lexical ordering mistakes", () => {
  assert.ok(comparePublicationVersions("1.10.0", "1.9.99", "latest") > 0);
  assert.equal(comparePublicationVersions("2.0.0", "2.0.0", "latest"), 0);
  assert.throws(
    () => assertCandidateAdvances("1.2.3", "1.2.4", "latest"),
    /backward/,
  );
});

test("orders prereleases by base version, UTC date, and controller run", () => {
  assert.ok(
    comparePublicationVersions(
      "1.2.4-nightly.20260817.1",
      "1.2.4-nightly.20260816.99",
      "nightly",
    ) > 0,
  );
  assert.ok(
    comparePublicationVersions(
      "1.2.4-nightly.20260816.100",
      "1.2.4-nightly.20260816.99",
      "nightly",
    ) > 0,
  );
});

test("rejects versions from another channel or unsupported version syntax", () => {
  assert.throws(
    () => comparePublicationVersions("1.2.4-nightly.20260816.1", "1.2.3", "latest"),
    /does not belong/,
  );
  assert.throws(
    () =>
      comparePublicationVersions(
        "1.2.4-nightly.20260816.2",
        "1.2.4-canary.20260816.1",
        "nightly",
      ),
    /does not belong/,
  );
});

test("waits when the tag is visible before version metadata", async () => {
  const options = verificationOptions({
    readRegistry: sequenceReader([
      { metadata: undefined, distTags: { nightly: version } },
      { metadata: metadata(), distTags: { nightly: version } },
    ]),
  });
  const result = await verifyNpmPublication(options);
  assert.deepEqual(result, { shouldPublish: false, attempts: 2, elapsedMs: 5_000 });
  assert.deepEqual(options.clock.sleeps, [5_000]);
});

test("waits when version metadata is visible before the channel tag", async () => {
  const logs = [];
  const options = verificationOptions({
    readRegistry: sequenceReader([
      { metadata: metadata(), distTags: { nightly: priorVersion } },
      { metadata: metadata(), distTags: { nightly: version } },
    ]),
    log: (message) => logs.push(message),
  });
  const result = await verifyNpmPublication(options);
  assert.equal(result.attempts, 2);
  assert.match(logs[0], /attempt 1 after 0\.0s is pending/);
  assert.match(logs[0], /still points to/);
  assert.match(logs[1], /attempt 2 succeeded after 5\.0s/);
});

test("retries transient registry failures", async () => {
  const options = verificationOptions({
    readRegistry: sequenceReader([
      new TransientRegistryError("npm version metadata request returned HTTP 503."),
      { metadata: metadata(), distTags: { nightly: version } },
    ]),
  });
  const result = await verifyNpmPublication(options);
  assert.equal(result.attempts, 2);
  assert.deepEqual(options.clock.sleeps, [5_000]);
});

test("classifies HTTP 429 as retryable without exposing request details", async () => {
  const fetchImpl = async () =>
    new Response("busy", {
      status: 429,
      headers: { "retry-after": "7" },
    });
  const readRegistry = createRegistryReader({ fetchImpl });
  await assert.rejects(
    readRegistry(version),
    (error) =>
      error instanceof TransientRegistryError &&
      error.retryAfterMs === 7_000 &&
      error.message === "npm version metadata request returned HTTP 429.",
  );
});

test("classifies a fetch timeout as retryable", async () => {
  const readRegistry = createRegistryReader({
    fetchImpl: async () => {
      throw new DOMException("timed out", "TimeoutError");
    },
  });
  await assert.rejects(
    readRegistry(version),
    (error) =>
      error instanceof TransientRegistryError &&
      error.message === "npm version metadata request timed out or failed.",
  );
});

test("fails immediately when published integrity differs", async () => {
  const options = verificationOptions({
    readRegistry: sequenceReader([
      {
        metadata: metadata({ dist: { integrity: "sha512-other" } }),
        distTags: { nightly: version },
      },
    ]),
  });
  await assert.rejects(verifyNpmPublication(options), /integrity does not match/);
  assert.deepEqual(options.clock.sleeps, []);
});

test("fails when the channel already points to a newer publication", async () => {
  const options = verificationOptions({
    readRegistry: sequenceReader([
      { metadata: undefined, distTags: { nightly: newerVersion } },
    ]),
  });
  await assert.rejects(verifyNpmPublication(options), /backward/);
  assert.deepEqual(options.clock.sleeps, []);
});

test("bounds retries at the deadline without real sleeps", async () => {
  const options = verificationOptions({
    readRegistry: async () => {
      throw new TransientRegistryError("npm dist-tags request timed out or failed.");
    },
    timeoutMs: 12_000,
  });
  await assert.rejects(
    verifyNpmPublication(options),
    /after 12\.0s and 3 attempts; last pending reason: npm dist-tags request timed out or failed/,
  );
  assert.deepEqual(options.clock.sleeps, [5_000, 5_000, 2_000]);
});

test("prepublication check distinguishes unpublished and idempotent states", async () => {
  const unpublished = verificationOptions({
    phase: "before",
    readRegistry: async () => ({
      metadata: undefined,
      distTags: { nightly: priorVersion },
    }),
  });
  assert.equal((await verifyNpmPublication(unpublished)).shouldPublish, true);

  const existing = verificationOptions({
    phase: "before",
    readRegistry: async () => ({
      metadata: metadata(),
      distTags: { nightly: version },
    }),
  });
  assert.equal((await verifyNpmPublication(existing)).shouldPublish, false);
});

test("prepublication check refuses a tag/version split", async () => {
  const options = verificationOptions({
    phase: "before",
    readRegistry: async () => ({
      metadata: undefined,
      distTags: { nightly: version },
    }),
  });
  await assert.rejects(verifyNpmPublication(options), /metadata is unavailable/);
});
