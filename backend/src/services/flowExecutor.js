const axios = require('axios');
const crypto = require('crypto');
const { generateSchema, diffSchema } = require('./schemaTool');
const { isCancelled, getAbortSignal } = require('./runCancellation');
const { pushProgress } = require('./runProgress');
const { getWebLoginToken, invalidateTokenCache } = require('./webLogin');

// SKIPPED ranks below PASS on purpose — a step deliberately not run (its
// run condition wasn't met) shouldn't drag an otherwise-passing flow's
// overall status down to something that reads as a problem.
const SEVERITY = { SKIPPED: -1, PASS: 0, SCHEMA_DRIFT: 1, FAIL: 2, ERROR: 3 };

// {{timestamp}} — real wall-clock time as of the exact moment it's resolved
// (see runStep/sendOneRequest), formatted as WIB (Indonesia, UTC+7, no DST)
// e.g. "2026-08-20T14:24:00+07:00" — hardcoded rather than derived from the
// server's own timezone, since that could vary by deployment while the APIs
// this hits are always Indonesia-local.
function formatTimestampWIB(date = new Date()) {
  const wib = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${wib.getUTCFullYear()}-${pad(wib.getUTCMonth() + 1)}-${pad(wib.getUTCDate())}T${pad(wib.getUTCHours())}:${pad(wib.getUTCMinutes())}:${pad(wib.getUTCSeconds())}+07:00`;
}

// A header row unchecked in the editor is saved as { __disabled__: true, value }
// instead of being dropped (see KeyValueEditor.jsx) so it can still be shown
// and re-enabled later. Strip those out (and unwrap the rest) before a header
// object is actually sent as real HTTP headers.
function activeHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (value && typeof value === 'object' && value.__disabled__) continue;
    out[key] = value;
  }
  return out;
}

// Same idea as activeHeaders above, for a form-data body's own array-of-
// tuples shape (see FormDataEditor.jsx's formRowsToBody) — filtered out
// here, before resolveDeep/resolveFileUrls, so a disabled row's file (if
// any) is never even fetched, not just excluded later in buildRequestBody.
// Only form-data bodies are ever this array-of-tuples shape with our own
// __disabled__ marker inside — a JSON body_template passes through
// untouched.
function activeBodyEntries(body, bodyType) {
  if (bodyType !== 'form-data' || !Array.isArray(body)) return body;
  return body.filter(([, v]) => !(v && typeof v === 'object' && v.__disabled__));
}

// A step hitting a "download the actual file" endpoint (e.g. the signed PDF
// itself) gets back raw binary bytes as response.data — nothing here ever
// sets axios's responseType to arraybuffer for a normal step, so it's
// decoded as a plain string, which can end up containing a literal NUL byte
// or other invalid UTF-16. Postgres's jsonb column flatly refuses to store
// a NUL byte ("unsupported Unicode escape sequence"), which previously
// crashed the run's persistence — the whole request came back as a 500
// instead of a saved result. A body-path assertion or schema diff against
// mangled binary text would also be meaningless anyway. Detect it from the
// response's own declared Content-Type and swap it for a small, safe
// placeholder before assertions, schema generation, or storage ever touch
// it — status code and header assertions are unaffected.
function sanitizeBinaryResponseData(data, contentType) {
  if (typeof data !== 'string') return data;
  const ct = (contentType || '').toLowerCase();
  const looksTextual = !ct || ct.startsWith('text/') || ct.includes('json') || ct.includes('xml')
    || ct.includes('javascript') || ct.includes('yaml') || ct.includes('www-form-urlencoded');
  if (looksTextual) return data;
  return { __binary_response__: true, content_type: contentType || null, approx_bytes: Buffer.byteLength(data, 'utf8') };
}

// Only retry when the request never got a response at all (connection-level
// hiccups) — never retry a completed response, even a 5xx, since that's a
// real result to capture rather than a transient failure to hide.
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED']);
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestWithRetry(config, stepName) {
  let attempt = 0;
  while (true) {
    try {
      return await axios(config);
    } catch (err) {
      const retryable = !err.response && RETRYABLE_CODES.has(err.code);
      if (!retryable || attempt >= MAX_RETRIES) throw err;
      attempt += 1;
      console.warn(`[flowExecutor] Transient error on step "${stepName}" (${err.code}), retry ${attempt}/${MAX_RETRIES}...`);
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }
}

// `validateStatus: () => true` (see requestWithRetry's config) means axios
// only ever throws here for connection-level failures — no HTTP response was
// received at all — so every error reaching this point is some flavor of
// "the socket closed before a response arrived". Node/axios surface that as
// a variety of raw, unhelpful strings ("aborted", "socket hang up") depending
// on exactly when the connection dropped. Translate the common ones into a
// message that points at the actual likely cause instead of the raw string.
function describeConnectionError(err) {
  const raw = err.message || 'Unknown error';
  if (err.response) return raw; // has a real HTTP response — not this class of error
  switch (err.code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `Could not resolve the host — check the environment's base_url. (${raw})`;
    case 'ECONNREFUSED':
      return `Connection refused — nothing accepted the connection at that host/port. (${raw})`;
    case 'ETIMEDOUT':
      return `Connection timed out before a response arrived. (${raw})`;
    case 'ECONNABORTED':
      if (/timeout/i.test(raw)) return `Request timed out waiting for a response (15s limit). (${raw})`;
      break;
  }
  if (err.code === 'ERR_CANCELED' || err.name === 'CanceledError') {
    return 'Cancelled by user.';
  }
  if (/aborted|socket hang up|ECONNRESET|EPIPE/i.test(raw)) {
    return `Connection was closed before a full response arrived — often caused by an upstream WAF/gateway/proxy blocking or resetting the request rather than returning a clean error status. Try replaying the same request with curl to confirm. (${raw})`;
  }
  return raw;
}

/**
 * Recursively replace {{variable}} placeholders in strings, objects, and arrays.
 */
function resolveDeep(value, variables) {
  if (typeof value === 'string') {
    let resolved = value;
    // {{timestamp+120}} / {{timestamp-60}} — N is a signed offset in SECONDS
    // from right now (e.g. +120 for "2 minutes from now"), computed fresh at
    // resolution time same as plain {{timestamp}}. Handled before the normal
    // substitution loop below since the offset varies per use, so it can't
    // just be one more fixed entry in `variables` the way {{timestamp}}
    // itself is — "{{timestamp}} + 120" (as a separate, literal suffix)
    // would NOT work here, since this only does string substitution, not
    // arithmetic on the result.
    resolved = resolved.replace(/\{\{timestamp([+-]\d+)\}\}/g, (_, offsetSeconds) => (
      formatTimestampWIB(new Date(Date.now() + Number(offsetSeconds) * 1000))
    ));
    for (const [key, val] of Object.entries(variables)) {
      resolved = resolved.replace(new RegExp(`{{${key}}}`, 'g'), val ?? '');
    }
    return resolved;
  }
  if (Array.isArray(value)) return value.map((v) => resolveDeep(v, variables));
  if (value && typeof value === 'object') {
    if (value.__file__) {
      // Skip templating the (potentially large) base64 payload — only the filename is worth resolving.
      return { ...value, name: resolveDeep(value.name, variables) };
    }
    if (value.__file_url__) {
      // Resolved later by resolveFileUrls (needs to actually fetch the URL,
      // which is async) — just template the url/name strings here, same as
      // every other field.
      return { ...value, url: resolveDeep(value.url, variables), name: resolveDeep(value.name, variables) };
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveDeep(v, variables);
    return out;
  }
  return value;
}

// Downloads whatever's at `url` and returns it as an inline { __file__ }
// blob (base64 + the response's declared content-type), so a form-data
// field can be "fetch this document from a previous step's download link,
// then re-upload it" instead of only ever uploading a fixed local file.
async function fetchFileFromUrl(url) {
  const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
  return {
    data: Buffer.from(response.data).toString('base64'),
    mimeType: response.headers['content-type'] || 'application/octet-stream',
  };
}

// Walks the already-{{variable}}-resolved body and swaps every
// `{ __file_url__, url, name }` field for a real `{ __file__, name,
// mimeType, data }` one by actually downloading it — done as a separate
// async pass since resolveDeep (template substitution) has to stay
// synchronous.
async function resolveFileUrls(value) {
  if (Array.isArray(value)) return Promise.all(value.map(resolveFileUrls));
  if (value && typeof value === 'object') {
    if (value.__file_url__) {
      const fetched = await fetchFileFromUrl(value.url);
      return { __file__: true, name: value.name || 'file', mimeType: fetched.mimeType, data: fetched.data };
    }
    if (value.__file__) return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = await resolveFileUrls(v);
    return out;
  }
  return value;
}

function getField(obj, path) {
  if (!path) return undefined;
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

// Recursively walks every object/array under `node`, collecting the value of
// every key literally named `key`, at any depth — e.g. a `trustedStatus`
// field that appears both directly on a signature and again on each entry of
// a nested certificateChain array. getField's dot-path only reaches one
// fixed depth per call; this is for "find every occurrence, regardless of
// how deep or how many array levels it's nested under".
function collectDeepValues(node, key, out = []) {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectDeepValues(item, key, out);
  } else {
    for (const [k, v] of Object.entries(node)) {
      if (k === key) out.push(v);
      if (v != null && typeof v === 'object') collectDeepValues(v, key, out);
    }
  }
  return out;
}

/**
 * form-data bodies come in two shapes: a flat {key: value} object (the
 * original, still what every body_template saved before duplicate field
 * names were supported looks like), or an array of [key, value] tuples (the
 * current shape FormDataEditor saves) — the array form exists because a
 * plain object literally can't hold two entries under the same key (e.g. a
 * multipart envelope upload with two separate "documents" file parts, one
 * per document — the second would just silently overwrite the first).
 * File fields carry { __file__: true, name, mimeType, data (base64) }
 * instead of a plain string, whichever shape holds them.
 *
 * - No file fields (and nothing already saying otherwise): axios would
 *   otherwise JSON.stringify a plain object regardless of Content-Type, so
 *   encode it ourselves as application/x-www-form-urlencoded.
 * - Any file field, OR the step's own headers already declare a real
 *   multipart Content-Type (e.g. imported from a curl capture that used
 *   multipart/boundary even though none of its fields happen to be files —
 *   some APIs strictly require that encoding for anything hitting a
 *   multipart endpoint): build a real multipart/form-data body (native
 *   FormData + Blob, available in Node 18+) so it's replayed exactly as
 *   captured. FormData.append naturally supports calling it more than once
 *   with the same key, so a repeated key in the tuple array becomes two
 *   real parts, exactly like a real browser upload.
 */
function buildRequestBody(body, bodyType, headers) {
  if (bodyType === 'form-data' && body && typeof body === 'object') {
    const rawEntries = Array.isArray(body) ? body : Object.entries(body);
    // A row unchecked in the editor is saved as [key, { __disabled__: true,
    // value }] instead of being dropped (see FormDataEditor.jsx's
    // formRowsToBody) so it survives a save/reload as a disabled row —
    // strip those here so they're excluded from what's actually sent, same
    // as activeHeaders() does for a disabled header.
    const entries = rawEntries.filter(([, v]) => !(v && typeof v === 'object' && v.__disabled__));
    const hasFile = entries.some(([, v]) => v && typeof v === 'object' && v.__file__);
    const existingContentType = Object.entries(headers).find(([h]) => h.toLowerCase() === 'content-type')?.[1];
    const declaresMultipart = typeof existingContentType === 'string' && /multipart\/form-data/i.test(existingContentType);

    if (hasFile || declaresMultipart) {
      const form = new FormData();
      for (const [key, value] of entries) {
        if (value && typeof value === 'object' && value.__file__) {
          const buffer = Buffer.from(value.data || '', 'base64');
          const blob = new Blob([buffer], { type: value.mimeType || 'application/octet-stream' });
          form.append(key, blob, value.name || key);
        } else {
          form.append(key, value == null ? '' : String(value));
        }
      }
      // Let axios set the multipart boundary Content-Type — drop any stale one.
      for (const h of Object.keys(headers)) {
        if (h.toLowerCase() === 'content-type') delete headers[h];
      }
      return form;
    }

    const params = new URLSearchParams();
    for (const [key, value] of entries) params.append(key, value == null ? '' : String(value));
    // Same reasoning as the FormData branch above: a step imported from a
    // curl capture that itself used real multipart (boundary and all) keeps
    // that literal Content-Type in its saved headers — if this step's body
    // no longer has a file field (e.g. edited to reference an already-
    // uploaded file's id instead), leaving that stale multipart/boundary
    // header in place would send a URL-encoded body under a Content-Type
    // that claims it's multipart, which no server can parse correctly.
    // Always overwrite it with the Content-Type that actually matches what
    // was just built, never just fill it in when absent.
    for (const h of Object.keys(headers)) {
      if (h.toLowerCase() === 'content-type') delete headers[h];
    }
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    return params.toString();
  }
  return body;
}

// A small, safe subset — digits, +-*/ and whitespace only, never eval() —
// so an assertion's expected value can be a simple derived expression like
// "{{initial_quota}} + 2" (after {{}} resolution below) instead of only ever
// a fixed literal. Returns undefined (leaving the resolved string as-is) for
// anything that isn't purely this shape, e.g. a plain non-numeric string.
function evalSimpleArithmetic(str) {
  const trimmed = String(str).trim();
  if (!/^-?\d+(\.\d+)?(\s*[+\-*/]\s*-?\d+(\.\d+)?)+$/.test(trimmed)) return undefined;
  const tokens = trimmed.match(/-?\d+(\.\d+)?|[+\-*/]/g);
  let result = parseFloat(tokens[0]);
  for (let i = 1; i < tokens.length; i += 2) {
    const num = parseFloat(tokens[i + 1]);
    if (tokens[i] === '+') result += num;
    else if (tokens[i] === '-') result -= num;
    else if (tokens[i] === '*') result *= num;
    else if (tokens[i] === '/') result /= num;
  }
  return result;
}

// `variables` is the same {{variable}}-substitution scope used for the
// step's own url/headers/body (see resolveDeep) — passing it through here
// lets an assertion's expected value reference something extracted from an
// earlier step's response (e.g. "assert the ending balance is exactly
// {{initial_quota}} + 2"), not just a fixed value typed in ahead of time.
// A bare {{variable}} reference (no arithmetic operator) resolves to a
// plain string via resolveDeep even when the underlying extracted value was
// really a number/boolean — coerce it back for a strict-equality assertion
// (field_equals and friends) to compare correctly against a JSON field that
// really is a number/boolean, e.g. {{initial_quota}} alone (no "+ N") should
// still match a numeric `quota` field. Left as a string if it doesn't
// unambiguously look like a number/boolean/null (e.g. a UUID, a plain label).
function coercePrimitive(str) {
  if (str === 'true') return true;
  if (str === 'false') return false;
  if (str === 'null') return null;
  const trimmed = str.trim();
  // Only coerce when the number round-trips back to the exact same text —
  // "42" -> 42 -> "42" is safe, but "194.250" -> 194.25 -> "194.25" isn't:
  // that trailing zero (or a leading one, like "007") is often significant
  // in the actual field being compared (e.g. an amount extracted with "."
  // as a thousands separator, or a zero-padded code), not a real decimal.
  // Comparing it as a number would silently assert against the wrong value.
  if (trimmed !== '' && !Number.isNaN(Number(trimmed)) && String(Number(trimmed)) === trimmed) return Number(trimmed);
  return str;
}

function checkAssertions(assertions, response, responseTimeMs, variables = {}) {
  return assertions.filter((assertion) => assertion.enabled !== false).map((assertionRaw) => {
    const assertion = { ...assertionRaw };
    for (const field of ['expected', 'matchValue']) {
      if (typeof assertion[field] === 'string' && assertion[field].includes('{{')) {
        const resolved = resolveDeep(assertion[field], variables);
        const evaluated = evalSimpleArithmetic(resolved);
        assertion[field] = evaluated !== undefined ? evaluated : coercePrimitive(resolved);
      }
    }
    switch (assertion.type) {
      case 'status_code':
        return { ...assertion, passed: response.status === assertion.expected };
      // Passes if the actual status is ANY of a list of acceptable codes —
      // e.g. an endpoint that can legitimately return either 200 or 204 —
      // instead of only ever matching one exact value.
      case 'status_code_in': {
        const list = Array.isArray(assertion.expected) ? assertion.expected.map(Number) : [];
        return { ...assertion, passed: list.includes(response.status) };
      }
      case 'response_time':
        return { ...assertion, passed: responseTimeMs <= assertion.max_ms };
      case 'field_exists':
        return { ...assertion, passed: getField(response.data, assertion.path) !== undefined };
      case 'field_not_null': {
        const value = getField(response.data, assertion.path);
        return { ...assertion, passed: value !== null && value !== undefined };
      }
      case 'field_equals':
        return { ...assertion, passed: getField(response.data, assertion.path) === assertion.expected };
      case 'field_contains': {
        const value = getField(response.data, assertion.path);
        return { ...assertion, passed: value != null && String(value).includes(String(assertion.expected)) };
      }
      case 'field_matches': {
        const value = getField(response.data, assertion.path);
        let passed = false;
        try { passed = value != null && new RegExp(assertion.pattern).test(String(value)); } catch { passed = false; }
        return { ...assertion, passed };
      }
      case 'field_greater_than': {
        const value = Number(getField(response.data, assertion.path));
        return { ...assertion, passed: !Number.isNaN(value) && value > Number(assertion.expected) };
      }
      case 'field_less_than': {
        const value = Number(getField(response.data, assertion.path));
        return { ...assertion, passed: !Number.isNaN(value) && value < Number(assertion.expected) };
      }
      case 'array_length': {
        const value = getField(response.data, assertion.path);
        return { ...assertion, passed: Array.isArray(value) && value.length === Number(assertion.expected) };
      }
      // Finds the first item in the array at `path` whose `matchField` equals
      // `matchValue`, then checks that same item's `checkField` equals
      // `expected` — e.g. "in data[], find the item where participantRole ==
      // SIGNER, then check its state == TO_SIGN" without depending on that
      // item always being at a fixed array index.
      case 'array_find_equals': {
        const arr = getField(response.data, assertion.path);
        if (!Array.isArray(arr)) return { ...assertion, passed: false };
        const match = arr.find((item) => item && getField(item, assertion.matchField) === assertion.matchValue);
        const passed = match !== undefined && getField(match, assertion.checkField) === assertion.expected;
        return { ...assertion, passed };
      }
      // Inverse of array_find_equals: checks that NO item in the array at
      // `path` has its `checkField` equal to `expected` — e.g. "none of the
      // signatures' certificateInfo.trustedStatus is UNTRUSTED" — without
      // needing to know the array's length ahead of time (unlike a fixed-
      // index field_equals per item, which breaks as soon as the count varies).
      case 'array_none_equals': {
        const arr = getField(response.data, assertion.path);
        if (!Array.isArray(arr)) return { ...assertion, passed: false };
        const match = arr.find((item) => (assertion.checkField ? getField(item, assertion.checkField) : item) === assertion.expected);
        return { ...assertion, passed: match === undefined };
      }
      // For each item in the array at `path`, scopes down to `subPath` (e.g.
      // "certificateInfo" — omit to use the whole item), then recursively
      // scans that scoped subtree for every field literally named `key`, at
      // any nesting depth/array level, and checks that NONE of the values
      // found equal `expected` — e.g. "no `trustedStatus` anywhere under each
      // signature's certificateInfo is UNTRUSTED", covering both the field
      // directly on certificateInfo AND every entry of its nested
      // certificateChain array, without also reaching into timeStampInfo.
      case 'array_deep_none_equals': {
        const arr = getField(response.data, assertion.path);
        if (!Array.isArray(arr)) return { ...assertion, passed: false };
        const values = [];
        for (const item of arr) {
          const scoped = assertion.subPath ? getField(item, assertion.subPath) : item;
          collectDeepValues(scoped, assertion.key, values);
        }
        return { ...assertion, passed: !values.includes(assertion.expected) };
      }
      case 'header_exists': {
        const name = String(assertion.header || '').toLowerCase();
        return { ...assertion, passed: response.headers?.[name] !== undefined };
      }
      case 'header_equals': {
        const name = String(assertion.header || '').toLowerCase();
        return { ...assertion, passed: response.headers?.[name] === assertion.expected };
      }
      default:
        return { ...assertion, passed: false, note: 'unknown assertion type' };
    }
  });
}

// Runs one step against a read-only snapshot of the variable scope (never
// mutates it — request_id/random are freshly derived per call instead of
// written onto a shared object) so this is safe to fire concurrently for
// several steps at once, not just one at a time. Whatever it extracts is
// handed back for the caller to merge into the shared scope once the step
// (or its whole parallel batch) has finished.
async function runStep(step, baseVariables, flow, authCredentials, previousSchemas, runToken) {
  // Waited before this step runs at all — e.g. giving an async backend
  // process (document indexing, a webhook) time to finish before the next
  // check, without hardcoding a delay into every step's own request. Runs
  // independently of any other step in the same parallel batch.
  if (step.delay_ms > 0) await sleep(step.delay_ms);

  // Fresh per request (not per flow run) — lets a {{request_id}} header
  // uniquely trace each individual call, even across steps in the same run.
  // {{random}} is a short random string for body/URL fields that need a
  // unique value on every run (e.g. a document title) without wiring up an
  // Extract Variable rule just for that. {{timestamp}} is the real
  // wall-clock time this exact request is about to fire (WIB, ISO-ish with
  // offset — see formatTimestampWIB), not the flow's start time — e.g. a
  // signature/nonce field some APIs require to be genuinely current.
  const variables = {
    ...baseVariables,
    request_id: crypto.randomUUID(),
    random: crypto.randomBytes(4).toString('hex'),
    timestamp: formatTimestampWIB(),
  };

  const url = resolveDeep(step.url_template, variables);
  const headers = resolveDeep(activeHeaders(step.headers), variables);
  // Each step's own Authorization credential is the only source — no
  // flow-level fallback. getWebLoginToken() (see flowRunner.js) already
  // re-logs-in whenever a credential's cached token is near expiry, so a
  // step referencing a credential always gets a fresh-enough token without
  // needing any extra opt-in/opt-out here.
  if (step.auth_credential_id && authCredentials[step.auth_credential_id]) {
    const cred = authCredentials[step.auth_credential_id];
    // A picked credential always wins over anything already in the headers
    // config, but a plain assignment below only ever writes the literal key
    // "Authorization" — a differently-cased leftover (e.g. "authorization"
    // from a pasted curl command, still present from before this step had a
    // credential picked) would stay behind as its own key and get sent/
    // persisted as a second Authorization header. Clear every case-variant
    // first so exactly one survives.
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'authorization') delete headers[key];
    }
    if (cred.type === 'web_login') {
      headers['Authorization'] = `Bearer ${cred.token}`;
    } else {
      const basic = Buffer.from(`${cred.username}:${cred.password}`).toString('base64');
      headers['Authorization'] = `Basic ${basic}`;
    }
  }
  // A manually-typed or {{variable}}-templated Authorization value (e.g. a
  // raw token extracted from a login step's response) commonly forgets the
  // "Bearer " scheme prefix, which silently turns into a 401 — add it back
  // when it's missing, unless some other scheme (Basic, Digest, ...) is
  // already present.
  const authKey = Object.keys(headers).find((k) => k.toLowerCase() === 'authorization');
  if (authKey && typeof headers[authKey] === 'string' && headers[authKey].trim() && !/^[a-z]+\s/i.test(headers[authKey].trim())) {
    headers[authKey] = `Bearer ${headers[authKey].trim()}`;
  }
  const bodyTemplate = activeBodyEntries(step.body_template, step.body_type);
  const resolvedBody = bodyTemplate != null ? resolveDeep(bodyTemplate, variables) : undefined;

  const start = Date.now();
  let stepResult;
  const extractedVariables = {};

  try {
    // Fetching a __file_url__ field can fail (bad URL, timeout, 404) —
    // done inside the try so that surfaces as this step's own ERROR result
    // instead of crashing the whole flow run.
    const bodyWithFiles = resolvedBody != null ? await resolveFileUrls(resolvedBody) : resolvedBody;
    const body = buildRequestBody(bodyWithFiles, step.body_type, headers);
    let response = await requestWithRetry({
      method: step.method,
      url,
      headers,
      data: body,
      validateStatus: () => true,
      timeout: 15000,
      signal: getAbortSignal(runToken),
    }, step.name);

    // A cached Web Login token can get revoked by the server earlier than
    // its predicted expiry (see webLogin.js's expiresAt/REFRESH_MARGIN_MS)
    // — without this, every later step/run reusing that same credential
    // would keep failing with 401 until the cache's own clock catches up.
    // Force a fresh login and retry exactly once instead; a 401 that
    // survives the retry (wrong credentials, endpoint genuinely requires
    // something else) is left as a real failure, not retried again.
    const credForAuth = step.auth_credential_id ? authCredentials[step.auth_credential_id] : null;
    if (response.status === 401 && credForAuth?.type === 'web_login') {
      try {
        invalidateTokenCache(credForAuth.id);
        const freshToken = await getWebLoginToken(credForAuth, getAbortSignal(runToken));
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === 'authorization') delete headers[key];
        }
        headers['Authorization'] = `Bearer ${freshToken}`;
        response = await requestWithRetry({
          method: step.method,
          url,
          headers,
          data: body,
          validateStatus: () => true,
          timeout: 15000,
          signal: getAbortSignal(runToken),
        }, step.name);
      } catch (reloginErr) {
        console.error(`[flowExecutor] Re-login after 401 for "${credForAuth.name}" failed: ${reloginErr.message}`);
      }
    }

    const responseTimeMs = Date.now() - start;
    response.data = sanitizeBinaryResponseData(response.data, response.headers?.['content-type']);

    const newSchema = generateSchema(response.data);
    const previousSchema = step.endpoint_id ? previousSchemas[step.endpoint_id] : null;
    const schemaDiffs = previousSchema ? diffSchema(previousSchema, newSchema) : [];

    let assertionResults = null;
    if (step.assertions && step.assertions.length > 0) {
      assertionResults = checkAssertions(step.assertions, response, responseTimeMs, variables);
    }
    // A response shape change (schemaDiffs) no longer downgrades an
    // otherwise-passing run — it's still recorded below for reference,
    // but doesn't affect status, Dashboard badges, or Telegram alerts.
    const status = assertionResults
      ? (assertionResults.every((a) => a.passed) ? 'PASS' : 'FAIL')
      : (response.status < 400 ? 'PASS' : 'FAIL');

    for (const rule of step.extract || []) {
      let value = getField(response.data, rule.path);
      if (value !== undefined) {
        // Strips a formatted number down to plain digits (e.g. "4.662.000"
        // -> "4662000") so it can be reused as a numeric value in a later
        // step, instead of carrying thousand-separator dots/commas along.
        if (rule.strip_symbols && typeof value === 'string') value = value.replace(/[^0-9]/g, '');
        extractedVariables[rule.variable] = value;
      }
    }

    stepResult = {
      step_order: step.step_order,
      name: step.name,
      endpoint_id: step.endpoint_id || null,
      status,
      request_method: step.method,
      request_url: url,
      request_body: resolvedBody ?? null,
      request_headers: headers,
      request_id: variables.request_id,
      response_status_code: response.status,
      response_time_ms: responseTimeMs,
      response_body: response.data,
      error_message: status === 'FAIL'
        ? JSON.stringify(assertionResults ? assertionResults.filter((a) => !a.passed) : [{ type: 'http_status', expected: '< 400', actual: response.status }])
        : null,
      assertion_results: assertionResults,
      extracted_variables: extractedVariables,
      schema: newSchema,
      schema_diffs: schemaDiffs,
    };
  } catch (err) {
    stepResult = {
      step_order: step.step_order,
      name: step.name,
      endpoint_id: step.endpoint_id || null,
      status: 'ERROR',
      request_method: step.method,
      request_url: url,
      request_body: resolvedBody ?? null,
      request_headers: headers,
      request_id: variables.request_id,
      response_status_code: null,
      response_time_ms: Date.now() - start,
      response_body: null,
      error_message: describeConnectionError(err),
      assertion_results: null,
      extracted_variables: {},
      schema: null,
      schema_diffs: [],
    };
  }

  return { stepResult, extractedVariables };
}

// Groups consecutive steps into batches — a step marked parallel_with_previous
// joins the batch its predecessor is in instead of starting a new one, so
// e.g. steps 5-6-7 all flagged this way become a single 3-way-concurrent
// batch, not three separate pairs. A step without the flag always starts a
// fresh (initially size-1) batch. A step with a run_condition_status_code
// ALWAYS starts its own fresh batch regardless of the flag — it needs the
// immediately preceding step's real, already-completed result to decide
// whether to run at all, which isn't available yet if they ran concurrently.
function groupIntoBatches(steps) {
  const batches = [];
  for (const step of steps) {
    if (step.parallel_with_previous && step.run_condition_status_code == null && batches.length > 0) {
      batches[batches.length - 1].push(step);
    } else {
      batches.push([step]);
    }
  }
  return batches;
}

/**
 * Run a flow's steps in order against an environment. Variables extracted
 * from one step's response (via step.extract) are available as {{variable}}
 * in every following step's url/headers/body — this is what makes chains
 * like "login then use the token" work. Each step optionally carries its own
 * assertions (falls back to plain HTTP-status-based pass/fail) and, when tied
 * to an endpoint, is checked for schema drift against that endpoint's last
 * known response shape.
 *
 * A step flagged `parallel_with_previous` runs concurrently with the step(s)
 * immediately before it (see groupIntoBatches) rather than waiting for them
 * to finish — steps in the same batch can't see each other's extracted
 * variables (none of them exist yet when the batch starts), and if two of
 * them extract the same variable name, whichever is later in step_order
 * wins deterministically, not whichever happened to respond first.
 *
 * `initialVariables` seeds the variable scope before step 1 — used to chain
 * a value extracted by a PREVIOUS flow into this one when several flows are
 * run together as a batch (see routes/flows.js's /batch-run). The final
 * variables object is returned so the batch runner can pass it on again.
 */
// progressToken defaults to runToken — a plain manual/scheduled run tracks
// progress under the same token it's cancelled by, and a Batch Run now
// reuses that same one token across every flow in the batch too (see
// routes/flows.js's /batch-run), so a single Cancel stops the whole batch,
// not just whichever flow happens to be running at the time.
async function executeFlow(flow, steps, environment, previousSchemas = {}, authCredentials = {}, initialVariables = {}, runToken = null, progressToken = runToken) {
  let variables = { base_url: environment.base_url, ...(environment.variables || {}), ...initialVariables };
  const stepResults = [];
  let overallStatus = 'PASS';

  for (const batch of groupIntoBatches(steps)) {
    // Checked between batches (not mid-request — an in-flight HTTP call
    // still runs to completion) so cancelling a run stops it at the next
    // natural boundary instead of leaving it in a half-applied state.
    if (isCancelled(runToken)) {
      overallStatus = 'CANCELLED';
      break;
    }

    // A step with a run_condition_status_code always gets its own batch (see
    // groupIntoBatches), so the immediately preceding step's real result is
    // guaranteed to already be the last entry in stepResults — never sent
    // its request at all if that condition isn't met.
    const conditionStep = batch.length === 1 ? batch[0] : null;
    if (conditionStep && conditionStep.run_condition_status_code != null) {
      const previousStatusCode = stepResults[stepResults.length - 1]?.response_status_code ?? null;
      if (previousStatusCode !== conditionStep.run_condition_status_code) {
        const skippedResult = {
          step_order: conditionStep.step_order,
          name: conditionStep.name,
          endpoint_id: conditionStep.endpoint_id || null,
          status: 'SKIPPED',
          request_method: conditionStep.method,
          request_url: null,
          request_body: null,
          request_headers: null,
          request_id: null,
          response_status_code: null,
          response_time_ms: 0,
          response_body: null,
          error_message: `Skipped — previous step returned ${previousStatusCode ?? 'no status'}, expected ${conditionStep.run_condition_status_code}.`,
          assertion_results: null,
          extracted_variables: {},
          schema: null,
          schema_diffs: [],
        };
        stepResults.push(skippedResult);
        pushProgress(progressToken, flow.id, skippedResult);
        if (SEVERITY[skippedResult.status] > SEVERITY[overallStatus]) overallStatus = skippedResult.status;
        continue;
      }
    }

    const results = await Promise.all(batch.map((step) => runStep(step, variables, flow, authCredentials, previousSchemas, runToken)));

    let batchFailed = false;
    for (const { stepResult, extractedVariables } of results) {
      stepResults.push(stepResult);
      pushProgress(progressToken, flow.id, stepResult);
      variables = { ...variables, ...extractedVariables };
      if (SEVERITY[stepResult.status] > SEVERITY[overallStatus]) overallStatus = stepResult.status;
      if (['FAIL', 'ERROR'].includes(stepResult.status)) batchFailed = true;
    }
    if (batchFailed && flow.stop_on_failure !== false) break;
  }

  return { status: overallStatus, steps: stepResults, variables };
}

module.exports = {
  executeFlow, resolveDeep, getField, checkAssertions,
  activeHeaders, requestWithRetry, describeConnectionError, buildRequestBody, formatTimestampWIB,
};
