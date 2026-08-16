import assert from "node:assert/strict";
import test from "node:test";
import {
  assignVerifiedVercelAlias,
  validateVercelReleaseInput,
  verifyProtectedVercelDeployment,
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

const marker = {
  schemaVersion: 1,
  channel: "canary",
  version: "0.0.33-canary.20260816.8",
  sourceSha: "5d237e478973383f7ef2fc64280a162c9675cb91",
};

const verificationInput = {
  ...input,
  version: marker.version,
  sourceSha: marker.sourceSha,
  verificationKey: "release-31970670335-1",
  attempts: 1,
  retryDelayMs: 0,
};

function markerResponse(body = marker, status = 200) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(text)) },
  });
}

function bypassRecord(secret) {
  return {
    [secret]: {
      createdAt: 1_723_148_800_000,
      createdBy: "release-controller",
      scope: "automation-bypass",
    },
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

test("verifies a protected deployment with an existing automation bypass", async () => {
  const bypassSecret = "A".repeat(32);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) return response(200, deployment());
    if (calls.length === 2) {
      return response(200, {
        id: input.projectId,
        accountId: input.teamId,
        protectionBypass: bypassRecord(bypassSecret),
      });
    }
    assert.equal(init.headers["x-vercel-protection-bypass"], bypassSecret);
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.redirect, "manual");
    return markerResponse();
  };

  const result = await verifyProtectedVercelDeployment({ ...verificationInput, fetchImpl });

  assert.deepEqual(result, { deploymentId: "dpl_abcdefghijklmnop" });
  assert.deepEqual(calls.map((call) => [call.init.method ?? "GET", call.url]), [
    ["GET", `https://api.vercel.com/v13/deployments/dascode-abc123.vercel.app?teamId=${input.teamId}`],
    ["GET", `https://api.vercel.com/v9/projects/${input.projectId}?teamId=${input.teamId}`],
    ["GET", `${input.deploymentUrl}/__dascode/release.json?verify=release-31970670335-1-1`],
  ]);
  assert.equal(calls.slice(0, 2).some((call) => "x-vercel-protection-bypass" in call.init.headers), false);
});

test("creates an automation bypass when the project has none", async () => {
  const bypassSecret = "B".repeat(32);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) return response(200, deployment());
    if (calls.length === 2) {
      return response(200, { id: input.projectId, accountId: input.teamId, protectionBypass: {} });
    }
    if (calls.length === 3) {
      return response(200, { protectionBypass: bypassRecord(bypassSecret) });
    }
    assert.equal(init.headers["x-vercel-protection-bypass"], bypassSecret);
    return markerResponse();
  };

  await assert.doesNotReject(verifyProtectedVercelDeployment({ ...verificationInput, fetchImpl }));
  assert.equal(calls[2].init.method, "PATCH");
  assert.equal(calls[2].init.body, "{}");
  assert.equal(
    calls[2].url,
    `https://api.vercel.com/v1/projects/${input.projectId}/protection-bypass?teamId=${input.teamId}`,
  );
});

test("creates an automation bypass when only an integration bypass exists", async () => {
  const bypassSecret = "G".repeat(32);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) return response(200, deployment());
    if (calls.length === 2) {
      return response(200, {
        id: input.projectId,
        accountId: input.teamId,
        protectionBypass: {
          integration_token: {
            createdAt: 1_723_148_800_000,
            createdBy: "integration",
            scope: "integration-automation-bypass",
            integrationId: "oac_example",
            configurationId: "icfg_example",
          },
        },
      });
    }
    if (calls.length === 3) {
      return response(200, { protectionBypass: bypassRecord(bypassSecret) });
    }
    return markerResponse();
  };

  await assert.doesNotReject(verifyProtectedVercelDeployment({ ...verificationInput, fetchImpl }));
  assert.equal(calls[2].init.method, "PATCH");
});

test("retries the protected marker without reacquiring the bypass secret", async () => {
  const bypassSecret = "C".repeat(32);
  let markerAttempts = 0;
  let sleeps = 0;
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path.startsWith("/v13/deployments/")) return response(200, deployment());
    if (path.startsWith("/v9/projects/")) {
      return response(200, {
        id: input.projectId,
        accountId: input.teamId,
        protectionBypass: bypassRecord(bypassSecret),
      });
    }
    markerAttempts += 1;
    if (markerAttempts === 1) return markerResponse("Redirecting...", 302);
    if (markerAttempts === 2) return markerResponse({ ...marker, sourceSha: "0".repeat(40) });
    return markerResponse();
  };

  await assert.doesNotReject(
    verifyProtectedVercelDeployment({
      ...verificationInput,
      attempts: 3,
      fetchImpl,
      sleepImpl: async () => {
        sleeps += 1;
      },
    }),
  );
  assert.equal(markerAttempts, 3);
  assert.equal(sleeps, 2);
});

test("rejects wrong project identity before requesting a bypass or marker", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return response(200, deployment({ projectId: "prj_someoneelse" }));
  };

  await assert.rejects(
    verifyProtectedVercelDeployment({ ...verificationInput, fetchImpl }),
    /project mismatch/,
  );
  assert.equal(calls, 1);
});

test("rejects a project from another team before requesting a bypass or marker", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return response(200, deployment());
    return response(200, {
      id: input.projectId,
      accountId: "team_someoneelse",
      protectionBypass: {},
    });
  };

  await assert.rejects(
    verifyProtectedVercelDeployment({ ...verificationInput, fetchImpl }),
    /project identity mismatch/,
  );
  assert.equal(calls, 2);
});

test("fails closed on malformed bypass metadata without mutating the project", async () => {
  for (const protectionBypass of [
    null,
    [],
    { ["D".repeat(31)]: { createdAt: 1, createdBy: "owner", scope: "automation-bypass" } },
    { ["E".repeat(32)]: { scope: "automation-bypass" } },
    { malformed: null },
  ]) {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) return response(200, deployment());
      return response(200, { id: input.projectId, accountId: input.teamId, protectionBypass });
    };

    await assert.rejects(
      verifyProtectedVercelDeployment({ ...verificationInput, fetchImpl }),
      /malformed .*bypass metadata/,
    );
    assert.equal(calls, 2);
  }
});

test("rejects a malformed bypass creation response before fetching the marker", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return response(200, deployment());
    if (calls === 2) {
      return response(200, { id: input.projectId, accountId: input.teamId, protectionBypass: {} });
    }
    return response(200, { protectionBypass: {} });
  };

  await assert.rejects(
    verifyProtectedVercelDeployment({ ...verificationInput, fetchImpl }),
    /did not provide an automation protection-bypass secret/,
  );
  assert.equal(calls, 3);
});

test("rejects an oversized protected marker without trusting content length", async () => {
  const bypassSecret = "F".repeat(32);
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    const path = new URL(url).pathname;
    if (path.startsWith("/v13/deployments/")) return response(200, deployment());
    if (path.startsWith("/v9/projects/")) {
      return response(200, {
        id: input.projectId,
        accountId: input.teamId,
        protectionBypass: bypassRecord(bypassSecret),
      });
    }
    return new Response("x".repeat(4097), { status: 200 });
  };

  await assert.rejects(
    verifyProtectedVercelDeployment({ ...verificationInput, fetchImpl }),
    /did not serve the exact release identity/,
  );
  assert.equal(calls, 3);
});

test("rejects a protected marker whose declared length exceeds the limit", async () => {
  const bypassSecret = "H".repeat(32);
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path.startsWith("/v13/deployments/")) return response(200, deployment());
    if (path.startsWith("/v9/projects/")) {
      return response(200, {
        id: input.projectId,
        accountId: input.teamId,
        protectionBypass: bypassRecord(bypassSecret),
      });
    }
    return new Response(JSON.stringify(marker), {
      status: 200,
      headers: { "Content-Length": "4097" },
    });
  };

  await assert.rejects(
    verifyProtectedVercelDeployment({ ...verificationInput, fetchImpl }),
    /did not serve the exact release identity/,
  );
});

test("does not expose Vercel secrets in protected-verification errors", async () => {
  const fetchImpl = async () => response(403, { error: { message: input.token } });
  await assert.rejects(
    verifyProtectedVercelDeployment({ ...verificationInput, fetchImpl }),
    (error) => error.message === "Vercel API returned HTTP 403; body suppressed." && !error.message.includes(input.token),
  );
});
