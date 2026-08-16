const apiRoot = "https://api.vercel.com";
const idPattern = /^[A-Za-z0-9_]{4,128}$/u;
const deploymentIdPattern = /^dpl_[A-Za-z0-9]{8,128}$/u;
const deploymentHostPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app$/u;

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
  return { deploymentHost: parsed.hostname, domain, channel, teamId, projectId };
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
