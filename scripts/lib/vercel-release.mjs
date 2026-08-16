import { validateWebReleaseMarker } from "./release-contract.mjs";

const apiRoot = "https://api.vercel.com";
const idPattern = /^[A-Za-z0-9_]{4,128}$/u;
const deploymentIdPattern = /^dpl_[A-Za-z0-9]{8,128}$/u;
const deploymentHostPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app$/u;
const shaPattern = /^[0-9a-f]{40}$/u;
const verificationKeyPattern = /^[A-Za-z0-9._-]{1,240}$/u;
const bypassSecretPattern = /^[A-Za-z0-9]{32}$/u;

const domainsByChannel = new Map([
  ["stable", new Set(["latest.code.bclouder.dev", "code.bclouder.dev"])],
  ["nightly", new Set(["nightly.code.bclouder.dev"])],
  ["canary", new Set(["canary.code.bclouder.dev"])],
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateVercelReleaseInput({ deploymentUrl, domain, channel, teamId, projectId }) {
  const allowedDomains = domainsByChannel.get(channel);
  invariant(allowedDomains?.has(domain), "Vercel alias does not belong to the requested release channel.");
  return { ...validateVercelDeploymentInput({ deploymentUrl, teamId, projectId }), domain, channel };
}

function validateVercelDeploymentInput({ deploymentUrl, teamId, projectId }) {
  invariant(idPattern.test(teamId) && teamId.startsWith("team_"), "VERCEL_ORG_ID must be an exact Vercel team ID.");
  invariant(idPattern.test(projectId) && projectId.startsWith("prj_"), "VERCEL_PROJECT_ID must be an exact Vercel project ID.");

  let parsed;
  try {
    parsed = new URL(deploymentUrl);
  } catch {
    throw new Error("Vercel deployment URL is invalid.");
  }
  invariant(
    parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.port === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      deploymentHostPattern.test(parsed.hostname),
    "Vercel deployment URL must be a bare HTTPS vercel.app origin.",
  );
  return { deploymentHost: parsed.hostname, teamId, projectId };
}

export function validateVercelDeployment(deployment, expected) {
  invariant(isRecord(deployment), "Vercel returned an invalid deployment record.");
  invariant(deploymentIdPattern.test(deployment.id), "Vercel deployment ID is invalid.");
  invariant(deployment.url === expected.deploymentHost, "Vercel deployment hostname mismatch.");
  invariant(deployment.readyState === "READY" && deployment.status === "READY", "Vercel deployment is not ready.");
  invariant(deployment.target === "production", "Vercel deployment is not a production deployment.");
  invariant(deployment.ownerId === expected.teamId, "Vercel deployment owner mismatch.");
  invariant(deployment.projectId === expected.projectId, "Vercel deployment project mismatch.");
  if (deployment.project !== undefined) {
    invariant(isRecord(deployment.project) && deployment.project.id === expected.projectId, "Vercel deployment project identity mismatch.");
  }
  return deployment.id;
}

function validateAliasListing(listing, domain) {
  invariant(isRecord(listing) && Array.isArray(listing.aliases), "Vercel returned an invalid alias listing.");
  const matches = listing.aliases.filter((entry) => isRecord(entry) && entry.alias === domain);
  invariant(matches.length === 1, "Vercel did not bind the exact alias to the verified deployment.");
  invariant(matches[0].redirect === undefined || matches[0].redirect === null, "Vercel alias unexpectedly redirects elsewhere.");
}

async function api({ fetchImpl, token, teamId, path, method = "GET", body, statuses }) {
  const url = new URL(path, apiRoot);
  url.searchParams.set("teamId", teamId);
  const response = await fetchImpl(url, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!statuses.includes(response.status)) {
    throw new Error(`Vercel API returned HTTP ${response.status}; body suppressed.`);
  }
  return response;
}

async function responseJson(response, message) {
  try {
    return await response.json();
  } catch {
    throw new Error(message);
  }
}

function automationBypassSecret(protectionBypass) {
  if (protectionBypass === undefined) return undefined;
  invariant(isRecord(protectionBypass), "Vercel returned malformed protection-bypass metadata.");
  let automationSecret;
  for (const [secret, configuration] of Object.entries(protectionBypass)) {
    invariant(
      isRecord(configuration) &&
        Number.isSafeInteger(configuration.createdAt) &&
        configuration.createdAt >= 0 &&
        typeof configuration.createdBy === "string" &&
        configuration.createdBy.length > 0 &&
        typeof configuration.scope === "string",
      "Vercel returned malformed protection-bypass metadata.",
    );
    if (configuration.scope === "automation-bypass") {
      invariant(bypassSecretPattern.test(secret), "Vercel returned malformed automation-bypass metadata.");
      invariant(
        (configuration.isEnvVar === undefined || typeof configuration.isEnvVar === "boolean") &&
          (configuration.note === undefined || typeof configuration.note === "string"),
        "Vercel returned malformed automation-bypass metadata.",
      );
      automationSecret ??= secret;
      continue;
    }
    invariant(
      configuration.scope === "integration-automation-bypass" &&
        typeof configuration.integrationId === "string" &&
        configuration.integrationId.length > 0 &&
        typeof configuration.configurationId === "string" &&
        configuration.configurationId.length > 0,
      "Vercel returned malformed protection-bypass metadata.",
    );
  }
  return automationSecret;
}

async function resolveAutomationBypass({ fetchImpl, token, teamId, projectId }) {
  const projectResponse = await api({
    fetchImpl,
    token,
    teamId,
    path: `/v9/projects/${encodeURIComponent(projectId)}`,
    statuses: [200],
  });
  const project = await responseJson(projectResponse, "Vercel returned invalid project metadata.");
  invariant(
    isRecord(project) && project.id === projectId && project.accountId === teamId,
    "Vercel project identity mismatch.",
  );
  const existing = automationBypassSecret(project.protectionBypass);
  if (existing) return existing;

  const creationResponse = await api({
    fetchImpl,
    token,
    teamId,
    path: `/v1/projects/${encodeURIComponent(projectId)}/protection-bypass`,
    method: "PATCH",
    body: {},
    statuses: [200],
  });
  const created = await responseJson(creationResponse, "Vercel returned an invalid protection-bypass record.");
  const secret = isRecord(created) ? automationBypassSecret(created.protectionBypass) : undefined;
  invariant(secret !== undefined, "Vercel did not provide an automation protection-bypass secret.");
  return secret;
}

async function readBoundedText(response, maximumBytes) {
  invariant(response.body !== null, "Vercel release marker body is missing.");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new Error("Vercel release marker is too large.");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

async function fetchReleaseMarker({ fetchImpl, deploymentUrl, bypassSecret, verificationKey }) {
  const markerUrl = new URL("/__dascode/release.json", deploymentUrl);
  markerUrl.searchParams.set("verify", verificationKey);
  const response = await fetchImpl(markerUrl, {
    headers: {
      Accept: "application/json",
      "Cache-Control": "no-cache",
      "x-vercel-protection-bypass": bypassSecret,
    },
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  invariant(response.status === 200, "Protected Vercel deployment returned an unexpected status.");
  const contentLength = response.headers.get("content-length");
  invariant(
    contentLength === null || (/^(?:0|[1-9]\d{0,3})$/u.test(contentLength) && Number(contentLength) <= 4096),
    "Vercel release marker is too large.",
  );
  const text = await readBoundedText(response, 4096);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Vercel returned an invalid release marker.");
  }
}

export async function verifyProtectedVercelDeployment({
  deploymentUrl,
  channel,
  version,
  sourceSha,
  verificationKey,
  token,
  teamId,
  projectId,
  attempts = 20,
  retryDelayMs = 5_000,
  fetchImpl = fetch,
  sleepImpl = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
}) {
  invariant(typeof token === "string" && token.length > 0, "Missing VERCEL_TOKEN.");
  invariant(domainsByChannel.has(channel), "Unsupported Vercel release channel.");
  invariant(typeof version === "string" && version.length > 0 && version.length <= 128, "Invalid release version.");
  invariant(shaPattern.test(sourceSha), "Invalid release source SHA.");
  invariant(verificationKeyPattern.test(verificationKey), "Invalid Vercel verification key.");
  invariant(Number.isSafeInteger(attempts) && attempts >= 1 && attempts <= 20, "Invalid Vercel verification attempt count.");
  invariant(Number.isSafeInteger(retryDelayMs) && retryDelayMs >= 0 && retryDelayMs <= 10_000, "Invalid Vercel retry delay.");

  const expected = validateVercelDeploymentInput({ deploymentUrl, teamId, projectId });
  const deploymentResponse = await api({
    fetchImpl,
    token,
    teamId,
    path: `/v13/deployments/${encodeURIComponent(expected.deploymentHost)}`,
    statuses: [200],
  });
  const deployment = await responseJson(deploymentResponse, "Vercel returned invalid deployment metadata.");
  const deploymentId = validateVercelDeployment(deployment, expected);
  const bypassSecret = await resolveAutomationBypass({ fetchImpl, token, teamId, projectId });

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const marker = await fetchReleaseMarker({
        fetchImpl,
        deploymentUrl,
        bypassSecret,
        verificationKey: `${verificationKey}-${attempt}`,
      });
      validateWebReleaseMarker(marker, { channel, version, sourceSha });
      return { deploymentId };
    } catch {
      if (attempt < attempts) await sleepImpl(retryDelayMs);
    }
  }
  throw new Error("Protected Vercel deployment did not serve the exact release identity over HTTPS.");
}

export async function assignVerifiedVercelAlias({
  deploymentUrl,
  domain,
  channel,
  token,
  teamId,
  projectId,
  fetchImpl = fetch,
}) {
  invariant(typeof token === "string" && token.length > 0, "Missing VERCEL_TOKEN.");
  const expected = validateVercelReleaseInput({ deploymentUrl, domain, channel, teamId, projectId });
  const deploymentResponse = await api({
    fetchImpl,
    token,
    teamId,
    path: `/v13/deployments/${encodeURIComponent(expected.deploymentHost)}`,
    statuses: [200],
  });
  const deploymentId = validateVercelDeployment(await deploymentResponse.json(), expected);
  const aliasPath = `/v2/deployments/${encodeURIComponent(deploymentId)}/aliases`;
  const assignmentResponse = await api({
    fetchImpl,
    token,
    teamId,
    path: aliasPath,
    method: "POST",
    body: { alias: domain },
    statuses: [200, 409],
  });
  if (assignmentResponse.status === 200) {
    const assignment = await assignmentResponse.json();
    invariant(isRecord(assignment) && assignment.alias === domain, "Vercel returned an invalid alias assignment.");
  }

  const aliasesResponse = await api({
    fetchImpl,
    token,
    teamId,
    path: aliasPath,
    statuses: [200],
  });
  validateAliasListing(await aliasesResponse.json(), domain);
  return { deploymentId, domain };
}
