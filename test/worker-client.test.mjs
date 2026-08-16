import assert from "node:assert/strict";
import test from "node:test";
import {
  SOURCE_REPOSITORY,
  SOURCE_REPOSITORY_ID,
  WORKER_CONTROL_REF,
  WORKER_CONTROL_SHA,
  WORKER_WORKFLOW_ID,
  WORKER_WORKFLOW_PATH,
} from "../scripts/lib/release-contract.mjs";
import {
  WORKER_RUN_TITLE_SETTLEMENT_MS,
  validatePolledRun,
  validateRun,
} from "../scripts/worker-client.mjs";

const expected = {
  runId: "31957509159",
  title: "release-worker / canary / request-id",
};

function workerRun(overrides = {}) {
  return {
    id: Number(expected.runId),
    workflow_id: Number(WORKER_WORKFLOW_ID),
    event: "workflow_dispatch",
    path: WORKER_WORKFLOW_PATH,
    head_sha: WORKER_CONTROL_SHA,
    head_branch: WORKER_CONTROL_REF.slice("refs/heads/".length),
    head_repository: {
      id: Number(SOURCE_REPOSITORY_ID),
      full_name: SOURCE_REPOSITORY,
    },
    repository: {
      id: Number(SOURCE_REPOSITORY_ID),
      full_name: SOURCE_REPOSITORY,
    },
    display_title: expected.title,
    run_attempt: 1,
    referenced_workflows: [
      {
        path: `${SOURCE_REPOSITORY}/.github/workflows/release-worker.yml@${WORKER_CONTROL_SHA}`,
        sha: WORKER_CONTROL_SHA,
        ref: WORKER_CONTROL_REF,
      },
    ],
    status: "queued",
    conclusion: null,
    ...overrides,
  };
}

test("accepts an exact title regardless of settlement deadline", () => {
  for (const status of ["queued", "in_progress", "completed"]) {
    assert.equal(
      validatePolledRun(workerRun({ status }), expected, {
        now: WORKER_RUN_TITLE_SETTLEMENT_MS,
        titleSettlementDeadline: WORKER_RUN_TITLE_SETTLEMENT_MS,
      }),
      true,
    );
  }
});

test("retries only a pre-active unequal title before the dedicated deadline", () => {
  for (const status of ["queued", "pending", "requested", "waiting"]) {
    assert.equal(
      validatePolledRun(workerRun({ display_title: `${expected.title}-unsettled`, status }), expected, {
        now: WORKER_RUN_TITLE_SETTLEMENT_MS - 1,
        titleSettlementDeadline: WORKER_RUN_TITLE_SETTLEMENT_MS,
      }),
      false,
    );
  }
});

test("rejects an unequal title at the settlement deadline", () => {
  assert.throws(
    () => validatePolledRun(
      workerRun({ display_title: `${expected.title}-unsettled` }),
      expected,
      {
        now: WORKER_RUN_TITLE_SETTLEMENT_MS,
        titleSettlementDeadline: WORKER_RUN_TITLE_SETTLEMENT_MS,
      },
    ),
    /Worker run request identity mismatch\./,
  );
});

test("rejects an unequal title as soon as a run becomes active or completes", () => {
  for (const status of ["in_progress", "completed"]) {
    assert.throws(
      () => validatePolledRun(
        workerRun({ display_title: `${expected.title}-unsettled`, status }),
        expected,
        { now: 0, titleSettlementDeadline: WORKER_RUN_TITLE_SETTLEMENT_MS },
      ),
      /Worker run request identity mismatch\./,
    );
  }
});

test("strict validation never permits an unequal title", () => {
  assert.throws(
    () => validateRun(workerRun({ display_title: `${expected.title}-unsettled` }), expected),
    /Worker run request identity mismatch\./,
  );
});

test("static and reusable-workflow identity mismatches fail before title settlement", () => {
  const unsettledTitle = `${expected.title}-unsettled`;
  const cases = [
    ["run ID", { id: 1 }, /Worker run ID mismatch\./],
    ["workflow ID", { workflow_id: 1 }, /Worker workflow ID mismatch\./],
    ["event", { event: "push" }, /Worker run event mismatch\./],
    ["workflow path", { path: ".github/workflows/other.yml" }, /Worker run workflow path mismatch\./],
    ["head SHA", { head_sha: "0".repeat(40) }, /Worker run head SHA mismatch\./],
    ["control ref", { head_branch: "dascode/other" }, /Worker run control ref mismatch\./],
    ["attempt", { run_attempt: 2 }, /first attempt, never a rerun\./],
    ["missing reusable workflow", { referenced_workflows: [] }, /exactly one reusable implementation workflow\./],
    [
      "reusable workflow SHA",
      {
        referenced_workflows: [{
          ...workerRun().referenced_workflows[0],
          sha: "0".repeat(40),
        }],
      },
      /Worker reusable implementation SHA mismatch\./,
    ],
  ];

  for (const [name, overrides, error] of cases) {
    assert.throws(
      () => validatePolledRun(
        workerRun({ display_title: unsettledTitle, ...overrides }),
        expected,
        { now: 0, titleSettlementDeadline: WORKER_RUN_TITLE_SETTLEMENT_MS },
      ),
      error,
      name,
    );
  }
});
