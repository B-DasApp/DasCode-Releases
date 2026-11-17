// Retries only failures that say nothing about the release itself: network errors, timeouts and
// transient server statuses on side-effect-free reads. A wrong answer (assertion, digest, identity)
// is never retried here.

const transientStatuses = new Set([429, 500, 502, 503, 504]);
const defaultDelaysMs = [1_000, 3_000, 9_000];

export const isTransientStatus = (status) => transientStatuses.has(status);

const defaultSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * `fetch` for idempotent reads. Retries network errors, timeouts and transient statuses with
 * bounded backoff; every other response (including 4xx) is returned to the caller unchanged.
 * Writes are never retried because a lost response may hide a request that was applied.
 */
export async function fetchRead(url, init = {}, {
  fetchImpl = fetch,
  sleep = defaultSleep,
  delaysMs = defaultDelaysMs,
  timeoutMs,
  onRetry = () => {},
} = {}) {
  const method = (init.method ?? "GET").toUpperCase();
  // The timeout signal is created per attempt: an aborted signal would fail every later attempt.
  const attemptInit = () =>
    timeoutMs === undefined ? init : { ...init, signal: AbortSignal.timeout(timeoutMs) };
  if (method !== "GET" && method !== "HEAD") return fetchImpl(url, attemptInit());
  for (let attempt = 0; ; attempt += 1) {
    const final = attempt >= delaysMs.length;
    try {
      const response = await fetchImpl(url, attemptInit());
      if (final || !isTransientStatus(response.status)) return response;
      await response.body?.cancel().catch(() => {});
      onRetry(`HTTP ${response.status}`, attempt + 1);
    } catch (error) {
      if (final) throw error;
      onRetry(error instanceof Error ? error.name : "network error", attempt + 1);
    }
    await sleep(delaysMs[attempt]);
  }
}

/**
 * Re-reads until `accept(value)` holds. For read-after-write lag, such as reading back a ref that
 * was created a moment ago. Returns the last value when the budget is spent so the caller applies
 * its own strict check and fails with its own message.
 */
export async function readUntil(read, accept, { attempts = 6, delayMs = 2_000, sleep = defaultSleep } = {}) {
  let value = await read();
  for (let attempt = 1; attempt < attempts && !accept(value); attempt += 1) {
    await sleep(delayMs);
    value = await read();
  }
  return value;
}
