const crypto = require('crypto');
const { decrypt } = require('../utils/crypto');
const { getWebLoginToken, invalidateTokenCache } = require('./webLogin');
const { resolveDeep, activeHeaders, requestWithRetry, describeConnectionError, buildRequestBody, formatTimestampWIB } = require('./flowExecutor');
const { isCancelled, getAbortSignal } = require('./runCancellation');

// Hard ceiling on both knobs, enforced server-side (not just whatever the
// form happens to send) — this fires real requests at a real API, some of
// them PROD, so a typo like an extra zero shouldn't be able to turn into an
// actual denial-of-service attempt against the target.
const MAX_TOTAL_REQUESTS = 500;
const MAX_CONCURRENCY = 50;

// `credential` is already decrypted by the time this is called (see
// runStressTest) — cheap to call per-request despite the name suggesting
// otherwise, since getWebLoginToken caches internally; only the very first
// call across the whole run actually pays for a real login.
async function resolveAuthHeader(credential, runToken) {
  if (!credential) return null;
  if (credential.type === 'web_login') {
    const token = await getWebLoginToken(credential, getAbortSignal(runToken));
    return `Bearer ${token}`;
  }
  const basic = Buffer.from(`${credential.username}:${credential.password}`).toString('base64');
  return `Basic ${basic}`;
}

async function sendOneRequest(endpoint, environment, credential, runToken) {
  const variables = {
    base_url: environment.base_url,
    ...(environment.variables || {}),
    request_id: crypto.randomUUID(),
    random: crypto.randomBytes(4).toString('hex'),
    timestamp: formatTimestampWIB(),
  };
  const url = resolveDeep(endpoint.path_template, variables);
  const headers = resolveDeep(activeHeaders(endpoint.headers), variables);
  const authHeaderValue = await resolveAuthHeader(credential, runToken);
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
    let response = await requestWithRetry({
      method: endpoint.method,
      url,
      headers,
      data: body,
      validateStatus: () => true,
      timeout: 15000,
      signal: getAbortSignal(runToken),
    }, endpoint.name);

    // Same reasoning as flowExecutor.js's runStep: a cached Web Login token
    // can be revoked by the server earlier than its predicted expiry — force
    // a fresh login and retry exactly once instead of letting every
    // remaining request in this run fail with 401 until the cache's own
    // clock catches up.
    if (response.status === 401 && credential?.type === 'web_login') {
      try {
        invalidateTokenCache(credential.id);
        const freshHeader = await resolveAuthHeader(credential, runToken);
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === 'authorization') delete headers[key];
        }
        if (freshHeader) headers['Authorization'] = freshHeader;
        response = await requestWithRetry({
          method: endpoint.method,
          url,
          headers,
          data: body,
          validateStatus: () => true,
          timeout: 15000,
          signal: getAbortSignal(runToken),
        }, endpoint.name);
      } catch (reloginErr) {
        console.error(`[stressTestRunner] Re-login after 401 failed: ${reloginErr.message}`);
      }
    }

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
  // Decrypted once up front — sendOneRequest resolves (and caches) its own
  // auth header per request instead of reusing one static value computed
  // here, so a 401 partway through the run can force a fresh login without
  // needing anything outside sendOneRequest itself.
  const resolvedCredential = credential ? { ...credential, password: decrypt(credential.password) } : null;
  // Priming the cache now — possibly a real ~15-20s Web Login sign-in —
  // BEFORE the clock below starts, so that setup time isn't counted as
  // part of the endpoint's own throughput. Every request's own
  // resolveAuthHeader call inside sendOneRequest just hits this cache.
  await resolveAuthHeader(resolvedCredential, runToken);
  const results = [];
  let started = 0;

  const worker = async () => {
    while (started < totalRequests) {
      if (isCancelled(runToken)) break;
      started += 1;
      results.push(await sendOneRequest(endpoint, environment, resolvedCredential, runToken));
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
