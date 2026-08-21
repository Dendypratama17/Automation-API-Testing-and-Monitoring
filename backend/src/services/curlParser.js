// Flags real curl accepts that take NO value — anything else starting with
// '-' that isn't one of the specially-handled cases below (-X, -H, -d/data*,
// -F, -u, -b, --url) is assumed to take a value and has that value consumed
// (see the loop below). Without this, an unrecognized value-taking flag
// (e.g. -A/--user-agent, -e/--referer, -o/--output, -x/--proxy) leaves its
// value token to fall through to the bare-token branch and get
// misinterpreted as the URL — the exact bug -b/--cookie had before it got
// its own case.
const BOOLEAN_FLAGS = new Set([
  '-k', '--insecure', '-L', '--location', '-s', '--silent', '-S', '--show-error',
  '-v', '--verbose', '-i', '--include', '-I', '--head', '--compressed', '-g', '--globoff',
  '-4', '--ipv4', '-6', '--ipv6', '-f', '--fail', '-N', '--no-buffer', '-n', '--netrc',
  '-G', '--get', '-J', '--remote-header-name', '-O', '--remote-name',
]);

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
  // An array of [key, value] tuples, not a {key: value} object — a real
  // multipart body can carry the same field name more than once (e.g. two
  // separate "documents" file parts for a 2-document upload), which a
  // plain object can't hold (the second would silently overwrite the
  // first).
  const formFields = [];

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
        formFields.push([key, isFile ? `@file:${val}` : val]);
      }
      if (!method) method = 'POST';
    } else if (t === '-u' || t === '--user') {
      i++; // skip basic auth value, not handled yet
    } else if (t === '-b' || t === '--cookie') {
      headers['Cookie'] = tokens[++i];
    } else if (t === '--url') {
      url = tokens[++i];
    } else if (t.startsWith('-') && t !== '-' && !BOOLEAN_FLAGS.has(t)) {
      // An unrecognized flag that (per real curl) takes a value — consume
      // and discard it so it never reaches the bare-token branch below.
      i++;
    } else if (!t.startsWith('-') && t !== 'curl') {
      // Every recognized flag above consumes its own value via tokens[++i],
      // and a genuinely no-argument flag (BOOLEAN_FLAGS) is simply skipped
      // without ever reaching this branch — so the one remaining bare token
      // here is always the URL, exactly like real curl. It may have no
      // scheme (e.g. a local `localhost:9191/decrypt`), which is normalized
      // below rather than silently dropped.
      url = t;
    }
  }

  if (isMultipart) body = formFields;

  // -F/--form builds its own formFields directly above, but a curl copied
  // straight from a browser's devtools instead carries the WHOLE multipart
  // body as one --data-raw string (boundary and all) — isMultipart above
  // only ever gets set by an actual -F flag, so that shape falls through
  // untouched unless it's caught here too, from the Content-Type header.
  if (!isMultipart && typeof body === 'string') {
    const contentType = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] || '';
    const boundaryMatch = contentType.match(/boundary=("?)([^;"]+)\1/i);
    if (boundaryMatch) {
      const parsedFields = parseMultipartBody(body, boundaryMatch[2]);
      if (parsedFields) {
        isMultipart = true;
        body = parsedFields;
      }
    }
  }

  if (url && !/^https?:\/\//.test(url)) url = `http://${url}`;

  return { method: method || 'GET', url, headers, body, isMultipart };
}

// Splits a raw multipart/form-data body on its boundary into an array of
// [fieldName, value] tuples — same shape -F/--form builds above, and for
// the same reason: a field name (e.g. "documents") legitimately repeats
// once per file in a multi-file upload, which a plain object can't hold
// without one occurrence silently overwriting another.
function parseMultipartBody(raw, boundary) {
  const marker = `--${boundary}`;
  if (!raw.includes(marker)) return null;
  const parts = raw.split(marker).slice(1, -1);
  if (parts.length === 0) return null;

  const fields = [];
  for (let part of parts) {
    part = part.replace(/^\r\n/, '').replace(/\r\n$/, '');
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headerBlock = part.slice(0, headerEnd);
    const value = part.slice(headerEnd + 4);
    const nameMatch = headerBlock.match(/name="([^"]*)"/i);
    if (!nameMatch) continue;
    const filenameMatch = headerBlock.match(/filename="([^"]*)"/i);
    fields.push([nameMatch[1], filenameMatch ? `@file:${filenameMatch[1]}` : value]);
  }
  return fields.length ? fields : null;
}

// Basic shell-like tokenizer respecting single/double quotes
function tokenize(str) {
  const tokens = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  // Maps a backslash-escape's letter to the real character it stands for,
  // used only inside $'...' below — unlike a plain '...' string (fully
  // literal) or "..." string (only a few escapes), ANSI-C quoting is where
  // a browser's "Copy as cURL" puts a multipart body's real \r\n line
  // breaks, so these must become actual CR/LF bytes for the boundary
  // splitter below to find them.
  const ANSI_C_ESCAPES = { r: '\r', n: '\n', t: '\t', '\\': '\\', "'": "'", '"': '"', '0': '\0' };

  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    // $'...' (bash ANSI-C quoting) — not just a plain '...' string, so it
    // can't be left to the ordinary single-quote toggle below (that would
    // leave the leading `$` stuck onto the next token, and never unescape
    // the \r\n inside). Consumed as its own self-contained unit here.
    if (c === '$' && str[i + 1] === "'" && !inSingle && !inDouble) {
      i += 2;
      while (i < str.length && str[i] !== "'") {
        if (str[i] === '\\' && i + 1 < str.length) {
          const esc = ANSI_C_ESCAPES[str[i + 1]];
          current += esc !== undefined ? esc : str[i + 1];
          i += 2;
        } else {
          current += str[i];
          i += 1;
        }
      }
      continue;
    }
    // Backslash-escape (outside single quotes, where POSIX shells treat
    // backslash as fully literal) — consumes the next character as-is.
    // Without this, `-d "{\"a\":1}"` (a common "copy as cURL" shape from
    // Windows/cmd) has its escaped `\"` read as a real closing quote by the
    // toggle logic below, silently mangling the JSON body.
    if (c === '\\' && !inSingle && i + 1 < str.length) {
      current += str[i + 1];
      i++;
      continue;
    }
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
