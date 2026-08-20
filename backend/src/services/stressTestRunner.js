const crypto = require('crypto');
const { decrypt } = require('../utils/crypto');
const { getWebLoginToken } = require('./webLogin');
const { resolveDeep, activeHeaders, requestWithRetry, describeConnectionError, buildRequestBody } = require('./flowExecutor');
const { isCancelled } = require('./runCancellation');

// Hard ceiling on both knobs, enforced server-side (not just whatever the
// form happens to send) — this fires real requests at a real API, some of
// them PROD, so a typo like an extra zero shouldn't be able to turn into an
// actual denial-of-service attempt against the target.
const MAX_TOTAL_REQUESTS = 500;
const MAX_CONCURRENCY = 50;

// Resolved once up front (not per-request) — every request in one stress
// test run authenticates as the same account, same as picking one credential
// for a Flow step. A fresh Web Login token is fetched (or reused from cache)
// exactly like a normal flow run would.
async function resolveAuthHeader(credential) {
  if (!credential) return null;
  if (credential.type === 'web_login') {
    const token = await getWebLoginToken({ ...credential, password: decrypt(credential.password) });
    return `Bearer ${token}`;
  }
  const basic = Buffer.from(`${credential.username}:${decrypt(credential.password)}`).toString('base64');
  return `Basic ${basic}`;
}

async function sendOneRequest(endpoint, environment, authHeaderValue) {
  const variables = {
    base_url: environment.base_url,
    ...(environment.variables || {}),
    request_id: crypto.randomUUID(),
    random: crypto.randomBytes(4).toString('hex'),
  };
  const url = resolveDeep(endpoint.path_template, variables);
  const headers = resolveDeep(activeHeaders(endpoint.headers), variables);
  if (authHeaderValue) {
    // Same dedup as flowExecutor's credential injection — an endpoint's own
    // headers might already carry a raw (possibly stale) Authorization value
    // under some casing; the picked credential always wins.
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'authorization') delete headers[key];
    }
    headers['Authorization'] = authHeaderValue;
  }
  const bodyResolved = endpoint.body_template != null ? resolveDeep(endpoint.body_template, variables) : undefined;
  const body = buildRequestBody(bodyResolved, endpoint.body_type, headers);

  const start = Date.now();
  try {
    const response = await requestWithRetry({
      method: endpoint.method,
      url,
      headers,
      data: body,
      validateStatus: () => true,
      timeout: 15000,
    }, endpoint.name);
    return { ok: response.status < 400, status: response.status, ms: Date.now() - start };
  } catch (err) {
    return { ok: false, status: null, ms: Date.now() - start, error: describeConnectionError(err) };
  }
}

// `wallClockMs` is the actual start-to-finish time of the whole test, not
// derived from the individual request durations — with concurrency > 1,
// requests overlap in time, so summing their durations overcounts how long
// the run actually took (and dividing by it would understate real
// throughput). Requests/sec only means something against the real clock.
function summarize(results, wallClockMs) {
  const n = results.length;
  const passCount = results.filter((r) => r.ok).length;
  const durations = results.map((r) => r.ms).sort((a, b) => a - b);
  const sum = durations.reduce((a, b) => a + b, 0);
  const statusCounts = {};
  const errorSamples = [];
  for (const r of results) {
    const key = r.status != null ? String(r.status) : 'ERROR';
    statusCounts[key] = (statusCounts[key] || 0) + 1;
    // A handful of distinct error messages is enough to point at the
    // problem — every one of hundreds of identical timeouts adds nothing.
    if (r.error && errorSamples.length < 5 && !errorSamples.includes(r.error)) errorSamples.push(r.error);
  }
  const p = (pct) => (durations.length ? durations[Math.min(durations.length - 1, Math.floor(pct * durations.length))] : 0);
  return {
    total_requests: n,
    pass_count: passCount,
    fail_count: n - passCount,
    avg_ms: n ? Math.round(sum / n) : 0,
    min_ms: durations[0] ?? 0,
    max_ms: durations[durations.length - 1] ?? 0,
    p95_ms: p(0.95),
    requests_per_sec: wallClockMs > 0 ? Math.round((n / (wallClockMs / 1000)) * 100) / 100 : 0,
    status_counts: statusCounts,
    error_samples: errorSamples,
  };
}

// Fixed-concurrency worker pool: `concurrency` workers each pull the next
// request off a shared counter until `totalRequests` have all been sent —
// requests fire as fast as each worker's previous one completes (no
// artificial delay), same constant-load model as ab/wrk/k6's simplest mode.
// The counter check-then-increment never yields between the two, so it's
// safe across concurrent workers despite there being no actual lock.
//
// `runToken` is checked before EVERY request (not just between batches like
// a Flow run) — each request here is its own natural boundary, so this is
// the tightest granularity cancellation can reasonably have. isCancelled(null)
// is always false, so omitting runToken just makes this uncancellable, same
// as before this existed.
async function runStressTest({ endpoint, environment, credential, totalRequests, concurrency, runToken = null }) {
  // Resolved (and, for Web Login, possibly a real ~15-20s sign-in) BEFORE
  // the clock below starts — that's setup, not part of the endpoint's own
  // throughput.
  const authHeaderValue = await resolveAuthHeader(credential);
  const results = [];
  let started = 0;

  const worker = async () => {
    while (started < totalRequests) {
      if (isCancelled(runToken)) break;
      started += 1;
      results.push(await sendOneRequest(endpoint, environment, authHeaderValue));
    }
  };
  const wallClockStart = Date.now();
  await Promise.all(Array.from({ length: Math.min(concurrency, totalRequests) }, worker));
  const wallClockMs = Date.now() - wallClockStart;

  const summary = summarize(results, wallClockMs);
  summary.cancelled = results.length < totalRequests;
  return summary;
}

module.exports = { runStressTest, MAX_TOTAL_REQUESTS, MAX_CONCURRENCY };
