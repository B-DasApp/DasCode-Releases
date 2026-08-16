import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCandidateAdvances,
  comparePublicationVersions,
} from "../scripts/verify-npm-publication.mjs";

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
      "1.2.4-canary.20260817.1",
      "1.2.4-canary.20260816.99",
      "canary",
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
