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
  cancelRun,
  findFatalJob,
  sanitizeLabel,
  validatePolledRun,
  validateRun,
  waitForRun,
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

test("an empty reusable-workflow list settles only before execution and inside the window", () => {
  const settling = { now: 0, titleSettlementDeadline: WORKER_RUN_TITLE_SETTLEMENT_MS };
  for (const status of ["queued", "pending", "requested", "waiting"]) {
    assert.equal(validatePolledRun(workerRun({ status, referenced_workflows: [] }), expected, settling), false, status);
  }
  const missing = /exactly one reusable implementation workflow\./;
  assert.throws(
    () => validatePolledRun(workerRun({ status: "in_progress", referenced_workflows: [] }), expected, settling),
    missing,
  );
  assert.throws(
    () => validatePolledRun(
      workerRun({ status: "queued", referenced_workflows: [] }),
      expected,
      { now: WORKER_RUN_TITLE_SETTLEMENT_MS, titleSettlementDeadline: WORKER_RUN_TITLE_SETTLEMENT_MS },
    ),
    missing,
  );
  assert.throws(() => validateRun(workerRun({ referenced_workflows: [] }), expected), missing);
});

const job = (name, status, conclusion, extra = {}) => ({ name, status, conclusion, steps: [], ...extra });

test("early failure ignores running, successful, skipped and neutral jobs", () => {
  assert.equal(
    findFatalJob([
      job("a", "in_progress", null),
      job("b", "queued", null),
      job("c", "completed", "success"),
      job("d", "completed", "skipped"),
      job("e", "completed", "neutral"),
    ]),
    null,
  );
});

test("early failure names the failed job and step for every fatal conclusion", () => {
  for (const conclusion of ["failure", "timed_out", "cancelled", "action_required"]) {
    assert.deepEqual(
      findFatalJob([
        job("ok", "completed", "success"),
        job("Test web 1", "completed", conclusion, {
          steps: [
            { name: "Set up job", status: "completed", conclusion: "success" },
            { name: "Test web unit and browser", status: "completed", conclusion },
          ],
        }),
      ]),
      { job: "Test web 1", step: "Test web unit and browser", conclusion },
    );
  }
});

test("early failure prefers the earliest real failure over cancelled siblings", () => {
  const result = findFatalJob([
    job("cancelled first", "completed", "cancelled", { completed_at: "2026-11-17T09:00:00Z" }),
    job("late failure", "completed", "failure", { completed_at: "2026-11-17T09:05:00Z" }),
    job("early failure", "completed", "failure", { completed_at: "2026-11-17T09:01:00Z" }),
  ]);
  assert.equal(result?.job, "early failure");
});

test("early failure reports an unknown step when no step failed", () => {
  assert.equal(findFatalJob([job("Setup", "completed", "failure")])?.step, "unknown");
});

test("public log labels keep only a conservative alphabet and length", () => {
  assert.equal(sanitizeLabel("Test web 1 (ubuntu)/x.y_z,w-1"), "Test web 1 (ubuntu)/x.y_z,w-1");
  assert.equal(sanitizeLabel("a\nb::set-output ${{secrets.X}}"), "a?b??set-output ???secrets.X??");
  assert.equal(sanitizeLabel("x".repeat(500)).length, 120);
  assert.equal(sanitizeLabel(undefined), "");
});

const waitArgs = (overrides = {}) =>
  new Map(
    Object.entries({
      "worker-run-id": expected.runId,
      channel: "nightly",
      "desktop-targets": "windows-macos",
      "runtime-targets": "linux-x64",
      "request-id": "request-id",
      "source-ref": "refs/heads/dascode/main",
      "source-sha": "a".repeat(40),
      "timeout-seconds": "60",
      "github-output": "/dev/null",
      ...overrides,
    }),
  );

const waitTitle = "release-worker / nightly / windows-macos / linux-x64 / request-id";

async function withFetch(handler, body) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname + new URL(url).search;
    calls.push({ path, method: init.method ?? "GET" });
    const { status = 200, json = {} } = handler(path, init.method ?? "GET");
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  };
  try {
    return await body(calls);
  } finally {
    globalThis.fetch = original;
  }
}

test("waiting fails on the first failed worker job without waiting for the run", async () => {
  await withFetch(
    (path) => {
      if (path.includes("/jobs")) {
        return {
          json: {
            total_count: 2,
            jobs: [
              job("Test server 1", "in_progress", null),
              job("Test web 1", "completed", "failure", {
                steps: [{ name: "Test web unit and browser", status: "completed", conclusion: "failure" }],
              }),
            ],
          },
        };
      }
      return { json: workerRun({ status: "in_progress", display_title: waitTitle }) };
    },
    async () => {
      await assert.rejects(
        waitForRun("token", waitArgs()),
        /Private worker job "Test web 1" ended with failure at step "Test web unit and browser"; logs were not retrieved\./,
      );
    },
  );
});

test("waiting keeps polling the run when the jobs listing is unavailable or needs pagination", async () => {
  for (const jobsResponse of [{ status: 500 }, { json: { total_count: 101, jobs: [job("x", "completed", "failure")] } }]) {
    await withFetch(
      (path) => (path.includes("/jobs") ? jobsResponse : { json: workerRun({ status: "completed", conclusion: "success", display_title: waitTitle }) }),
      async () => {
        await waitForRun("token", waitArgs());
      },
    );
  }
});

test("cancelling checks the exact worker identity before posting", async () => {
  await withFetch(
    (path, method) => (method === "POST" ? { status: 202 } : { json: workerRun({ status: "in_progress" }) }),
    async (calls) => {
      await cancelRun("token", waitArgs());
      assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
        `GET /repos/${SOURCE_REPOSITORY}/actions/runs/${expected.runId}`,
        `POST /repos/${SOURCE_REPOSITORY}/actions/runs/${expected.runId}/cancel`,
      ]);
    },
  );
  await withFetch(
    () => ({ json: workerRun({ head_sha: "0".repeat(40) }) }),
    async (calls) => {
      await assert.rejects(cancelRun("token", waitArgs()), /Worker run head SHA mismatch\./);
      assert.equal(calls.some((call) => call.method === "POST"), false);
    },
  );
});

test("cancelling an already finished worker is a no-op", async () => {
  await withFetch(
    (path, method) => (method === "POST" ? { status: 409 } : { json: workerRun({ status: "completed" }) }),
    async () => {
      await cancelRun("token", waitArgs());
    },
  );
});

test("waiting and cancelling tolerate a worker run that is not visible yet", async () => {
  let reads = 0;
  const lagging = (path, method) => {
    if (method === "POST") return { status: 202 };
    if (path.includes("/jobs")) return { json: { total_count: 0, jobs: [] } };
    reads += 1;
    return reads <= 2
      ? { status: 404 }
      : { json: workerRun({ status: "completed", conclusion: "success", display_title: waitTitle }) };
  };
  await withFetch(lagging, async () => {
    await waitForRun("token", waitArgs(), { sleep: async () => {} });
  });
  assert.equal(reads, 3);
  reads = 0;
  await withFetch(lagging, async (calls) => {
    await cancelRun("token", waitArgs(), { sleep: async () => {} });
    assert.equal(calls.at(-1).method, "POST");
  });
  assert.equal(reads, 3);
});

test("cancelling fails when the worker run never becomes visible", async () => {
  await withFetch(
    () => ({ status: 404 }),
    async (calls) => {
      await assert.rejects(
        cancelRun("token", waitArgs(), { sleep: async () => {} }),
        /HTTP 404/,
      );
      assert.equal(calls.some((call) => call.method === "POST"), false);
    },
  );
});
