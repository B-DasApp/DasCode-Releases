import assert from "node:assert/strict";
import test from "node:test";
import {
  assignVerifiedVercelAlias,
  validateVercelReleaseInput,
} from "../scripts/lib/vercel-release.mjs";

const input = {
  deploymentUrl: "https://dascode-abc123.vercel.app",
  domain: "canary.code.bclouder.dev",
  channel: "canary",
  token: "secret-token",
  teamId: "team_abcdefghijklmnop",
  projectId: "prj_abcdefghijklmnop",
};

function response(status, body) {
  return { status, json: async () => body };
}

function deployment(overrides = {}) {
  return {
    id: "dpl_abcdefghijklmnop",
    url: "dascode-abc123.vercel.app",
    readyState: "READY",
    status: "READY",
    target: "production",
    ownerId: input.teamId,
    projectId: input.projectId,
    project: { id: input.projectId, name: "dascode" },
    ...overrides,
  };
}

test("assigns and verifies an exact team-scoped Canary alias", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) return response(200, deployment());
    if (calls.length === 2) return response(200, { uid: "alias_1", alias: input.domain, created: new Date().toISOString() });
    return response(200, { aliases: [{ uid: "alias_1", alias: input.domain, created: new Date().toISOString(), redirect: null }] });
  };

  const result = await assignVerifiedVercelAlias({ ...input, fetchImpl });

  assert.deepEqual(result, { deploymentId: "dpl_abcdefghijklmnop", domain: input.domain });
  assert.deepEqual(calls.map((call) => [call.init.method, call.url]), [
    ["GET", `https://api.vercel.com/v13/deployments/dascode-abc123.vercel.app?teamId=${input.teamId}`],
    ["POST", `https://api.vercel.com/v2/deployments/dpl_abcdefghijklmnop/aliases?teamId=${input.teamId}`],
    ["GET", `https://api.vercel.com/v2/deployments/dpl_abcdefghijklmnop/aliases?teamId=${input.teamId}`],
  ]);
  assert.equal(calls[1].init.body, JSON.stringify({ alias: input.domain }));
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${input.token}`);
});

test("accepts an idempotent conflict only when the alias listing proves ownership", async () => {
  const fetchImpl = async (_url, init) => {
    if (init.method === "GET" && _url.pathname.startsWith("/v13/")) return response(200, deployment());
    if (init.method === "POST") return response(409, { error: { message: "suppressed" } });
    return response(200, { aliases: [{ uid: "alias_1", alias: input.domain, created: new Date().toISOString() }] });
  };
  await assert.doesNotReject(assignVerifiedVercelAlias({ ...input, fetchImpl }));
});

test("rejects cross-channel domains and malformed deployment URLs before network access", () => {
  assert.throws(
    () => validateVercelReleaseInput({ ...input, channel: "nightly" }),
    /does not belong/,
  );
  assert.throws(
    () => validateVercelReleaseInput({ ...input, deploymentUrl: "https://example.com" }),
    /vercel\.app/,
  );
  assert.throws(
    () => validateVercelReleaseInput({ ...input, deploymentUrl: `${input.deploymentUrl}/unexpected` }),
    /bare HTTPS/,
  );
});

test("does not mutate aliases when deployment ownership or state is wrong", async () => {
  for (const badDeployment of [
    deployment({ ownerId: "team_someoneelse" }),
    deployment({ projectId: "prj_someoneelse" }),
    deployment({ readyState: "ERROR", status: "ERROR" }),
    deployment({ target: null }),
  ]) {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return response(200, badDeployment);
    };
    await assert.rejects(assignVerifiedVercelAlias({ ...input, fetchImpl }));
    assert.equal(calls, 1);
  }
});

test("requires the exact non-redirect alias after assignment", async () => {
  for (const aliases of [
    [],
    [{ uid: "alias_1", alias: "nightly.code.bclouder.dev", created: new Date().toISOString() }],
    [{ uid: "alias_1", alias: input.domain, created: new Date().toISOString(), redirect: "elsewhere.example" }],
  ]) {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) return response(200, deployment());
      if (calls === 2) return response(409, {});
      return response(200, { aliases });
    };
    await assert.rejects(assignVerifiedVercelAlias({ ...input, fetchImpl }));
    assert.equal(calls, 3);
  }
});

test("suppresses Vercel API error bodies", async () => {
  const fetchImpl = async () => response(403, { error: { message: input.token } });
  await assert.rejects(
    assignVerifiedVercelAlias({ ...input, fetchImpl }),
    (error) => error.message === "Vercel API returned HTTP 403; body suppressed." && !error.message.includes(input.token),
  );
});
