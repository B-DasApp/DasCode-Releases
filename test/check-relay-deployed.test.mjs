import assert from "node:assert/strict";
import test from "node:test";
import { findRelayDeployment } from "../scripts/check-relay-deployed.mjs";

const sha = (letter) => letter.repeat(40);
const S = sha("a");
const R = sha("b");

function github({ changes, runs = [], ancestors = new Set() }) {
  const calls = [];
  return {
    calls,
    async get(path) {
      calls.push(path);
      if (path.includes("/commits?")) return changes;
      if (path.includes("/actions/workflows/")) return { workflow_runs: runs };
      const [, relay, head] = /compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})/u.exec(path);
      return { status: ancestors.has(`${relay}...${head}`) ? "ahead" : "diverged" };
    },
  };
}
const run = (id, head, status, conclusion) => ({ id, head_sha: head, status, conclusion });

test("a source commit with no relay change needs no relay deploy", async () => {
  const client = github({ changes: [] });
  assert.deepEqual(await findRelayDeployment(client, S), { relayCommit: null, deployRunId: null });
  assert.equal(client.calls.length, 1);
});

test("a successful deploy of the relay change itself passes", async () => {
  const client = github({ changes: [{ sha: R }], runs: [run(7, R, "completed", "success")] });
  assert.deepEqual(await findRelayDeployment(client, S), { relayCommit: R, deployRunId: 7 });
});

test("a successful deploy of a later commit that contains the relay change passes", async () => {
  const later = sha("c");
  const client = github({
    changes: [{ sha: R }],
    runs: [run(9, later, "completed", "success")],
    ancestors: new Set([`${R}...${later}`]),
  });
  assert.equal((await findRelayDeployment(client, S)).deployRunId, 9);
});

test("a deploy of an unrelated earlier commit does not count", async () => {
  const earlier = sha("d");
  const client = github({ changes: [{ sha: R }], runs: [run(3, earlier, "completed", "success")] });
  await assert.rejects(findRelayDeployment(client, S), /No successful relay deploy contains relay change/);
});

test("a failed or rolled-back deploy blocks the web release", async () => {
  const client = github({ changes: [{ sha: R }], runs: [run(5, R, "completed", "failure")] });
  await assert.rejects(findRelayDeployment(client, S), /deploy the relay first/);
});

test("a deploy still running asks for a rerun", async () => {
  const client = github({ changes: [{ sha: R }], runs: [run(6, R, "in_progress", null)] });
  await assert.rejects(findRelayDeployment(client, S), /run 6 .* still running/);
});

test("a newer success after an older failure passes", async () => {
  const client = github({
    changes: [{ sha: R }],
    runs: [run(12, R, "completed", "success"), run(11, R, "completed", "failure")],
  });
  assert.equal((await findRelayDeployment(client, S)).deployRunId, 12);
});

test("malformed API answers fail closed", async () => {
  await assert.rejects(findRelayDeployment(github({ changes: { nope: true } }), S), /unexpected shape/);
  await assert.rejects(findRelayDeployment(github({ changes: [{ sha: "zz" }] }), S), /invalid commit/);
  await assert.rejects(findRelayDeployment({ get: async (p) => (p.includes("/commits?") ? [{ sha: R }] : {}) }, S), /unexpected shape/);
});
