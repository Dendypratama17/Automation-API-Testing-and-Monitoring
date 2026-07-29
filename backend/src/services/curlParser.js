/**
 * Parse curl command string into structured endpoint definition.
 * Supports: -X/--request, -H/--header, -d/--data/--data-raw, -F/--form, URL detection.
 */
function parseCurl(curlString) {
  const clean = curlString.replace(/\\\n/g, ' ').trim();
  const tokens = tokenize(clean);

  let method = null;
  let url = '';
  const headers = {};
  let body = null;
  let isMultipart = false;
  const formFields = {};

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    if (t === '-X' || t === '--request') {
      method = tokens[++i].toUpperCase();
    } else if (t === '-H' || t === '--header') {
      const headerStr = tokens[++i];
      const idx = headerStr.indexOf(':');
      if (idx > -1) {
        const key = headerStr.slice(0, idx).trim();
        const val = headerStr.slice(idx + 1).trim();
        headers[key] = val;
      }
    } else if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary') {
      const dataStr = tokens[++i];
      try {
        body = JSON.parse(dataStr);
      } catch {
        body = dataStr;
      }
      if (!method) method = 'POST';
    } else if (t === '-F' || t === '--form') {
      isMultipart = true;
      const fieldStr = tokens[++i];
      const idx = fieldStr.indexOf('=');
      if (idx > -1) {
        const key = fieldStr.slice(0, idx).trim();
        let val = fieldStr.slice(idx + 1).trim();
        const isFile = val.startsWith('@');
        if (isFile) val = val.slice(1);
        val = val.replace(/^"|"$/g, '');
        formFields[key] = isFile ? `@file:${val}` : val;
      }
      if (!method) method = 'POST';
    } else if (t === '-u' || t === '--user') {
      i++; // skip basic auth value, not handled yet
    } else if (!t.startsWith('-') && t !== 'curl') {
      // Every recognized flag above consumes its own value via tokens[++i],
      // and an unrecognized flag (e.g. --location) is simply skipped without
      // ever reaching this branch (it still starts with '-') — so the one
      // remaining bare token here is always the URL, exactly like real curl.
      // It may have no scheme (e.g. a local `localhost:9191/decrypt`), which
      // is normalized below rather than silently dropped.
      url = t;
    }
  }

  if (isMultipart) body = formFields;
  if (url && !/^https?:\/\//.test(url)) url = `http://${url}`;

  return { method: method || 'GET', url, headers, body, isMultipart };
}

// Basic shell-like tokenizer respecting single/double quotes
function tokenize(str) {
  const tokens = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (c === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (c === ' ' && !inSingle && !inDouble) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += c;
  }
  if (current) tokens.push(current);
  return tokens;
}

// A standard UUID (v1-v5, 8-4-4-4-12 hex) sitting in the URL path is almost
// always a specific record's id captured at import time (e.g.
// /v1/documents/<uuid>/share) — replace it with {{id}} so the endpoint stays
// reusable across different documents instead of being pinned to whichever
// one the curl happened to be copied from.
const UUID_IN_PATH_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

// Replace known base_url with {{base_url}} placeholder for portability, and
// any UUID in the path with {{id}}.
function toPathTemplate(url, environments) {
  let result = url;
  for (const env of environments) {
    if (env.base_url && result.startsWith(env.base_url)) {
      result = result.replace(env.base_url, '{{base_url}}');
      break;
    }
  }
  return result.replace(UUID_IN_PATH_RE, '{{id}}');
}

module.exports = { parseCurl, toPathTemplate };
