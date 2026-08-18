// Tokenizes ONE line of raw (already-typed/pasted) JSON text into colored
// spans — operates on the literal source text instead of re-serializing a
// parsed value, so it stays byte-for-byte aligned with the real <textarea>
// underneath (re-stringifying would e.g. collapse "250.00" to "250",
// desyncing the overlay from the invisible real text one character at a
// time). Also tolerates invalid/in-progress JSON, since it only needs a
// single line to make sense, not the whole document.
const TOKEN_RE = /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\],:]|\s+|./g;

export function tokenizeJsonLine(line) {
  const tokens = [];
  let match;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(line))) {
    const text = match[0];
    let type = 'plain';
    if (text[0] === '"') {
      // A key vs. a string value look identical on their own — a key is
      // just whichever quoted string is immediately followed by a colon
      // (skipping whitespace), same convention "key": value always follows
      // in standard pretty-printed JSON.
      const after = line.slice(match.index + text.length);
      type = /^\s*:/.test(after) ? 'key' : 'string';
    } else if (/^-?\d/.test(text)) {
      type = 'number';
    } else if (text === 'true' || text === 'false') {
      type = 'boolean';
    } else if (text === 'null') {
      type = 'null';
    } else if (/[{}[\],:]/.test(text)) {
      type = 'punct';
    } else if (/^\s+$/.test(text)) {
      type = 'ws';
    }
    tokens.push({ text, type });
  }
  return tokens;
}

// Longest-common-subsequence line diff — deliberately independent of the
// structural (path-based, ignore-paths-aware) diff shown in the results
// panel below; this is just a quick "which raw lines don't have an
// identical match on the other side" visual aid inside the paste boxes
// themselves, so it works even before/without running a full Compare.
// Skipped for very large payloads (O(lines_a * lines_b) time/space).
const MAX_LINES_FOR_DIFF = 2000;

// A line with nothing but braces/brackets/commas (however indented) never
// carries a value on its own — it's just where an object/array happens to
// open or close. Flagging it as "different" only ever reflects indentation
// noise from something else shifting depth, never an actual value change.
function isStructuralOnly(trimmedLine) {
  return /^[{}[\],]*$/.test(trimmedLine);
}

// A leading `"key":` on a line, if it has one (array elements and bare
// values don't) — same "quoted string immediately followed by a colon"
// convention as tokenizeJsonLine's key/string distinction.
const LEADING_KEY_RE = /^"((?:\\.|[^"\\])*)"\s*:/;
function extractKey(trimmedLine) {
  const m = LEADING_KEY_RE.exec(trimmedLine);
  return m ? m[1] : null;
}

// Full dotted path for every key line (e.g. "customer.name"), not just its
// bare local key — matching on the bare key alone means an unrelated field
// that happens to share the same name elsewhere in the document (very
// common: "id", "name", "status", "amount"...) gets treated as "the same
// field exists over there", masking a genuinely missing nested field as a
// same-key value change instead. Tracked via an indent-depth stack, since
// that's the only structure available from raw, possibly-invalid-JSON text.
function buildPaths(lines) {
  const paths = new Array(lines.length).fill(null);
  const stack = []; // { indent, key }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const indentChars = line.match(/^\s*/)[0].length;
    const trimmed = line.slice(indentChars);
    while (stack.length && stack[stack.length - 1].indent >= indentChars) stack.pop();
    const key = extractKey(trimmed);
    if (key !== null) {
      paths[i] = [...stack.map((s) => s.key), key].join('.');
      stack.push({ indent: indentChars, key });
    }
  }
  return paths;
}

export function computeLineDiff(linesA, linesB) {
  if (linesA.length > MAX_LINES_FOR_DIFF || linesB.length > MAX_LINES_FOR_DIFF) {
    return { unmatchedA: new Set(), unmatchedB: new Set(), missingA: new Set(), missingB: new Set() };
  }
  // Leading whitespace stripped, not the whole line trimmed — a line that
  // only moved to a different indent depth (because something else nested
  // above it changed) isn't a value difference and shouldn't light up on
  // its own. Trailing content is left alone so a genuine difference that
  // happens to sit at the end of the line (e.g. mid-edit/unterminated
  // string content) still gets caught.
  const trimmedA = linesA.map((l) => l.replace(/^\s+/, ''));
  const trimmedB = linesB.map((l) => l.replace(/^\s+/, ''));
  const n = linesA.length;
  const m = linesB.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = trimmedA[i] === trimmedB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const matchedA = new Set();
  const matchedB = new Set();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (trimmedA[i] === trimmedB[j]) {
      matchedA.add(i);
      matchedB.add(j);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  // Full paths present anywhere on the OTHER side — lets an unmatched "key":
  // value line be told apart as either the same field with a different
  // value (unmatched*) or a field that doesn't exist over there at all
  // (missing*), instead of highlighting both identically.
  const pathsA = buildPaths(linesA);
  const pathsB = buildPaths(linesB);
  const pathSetA = new Set(pathsA.filter((p) => p !== null));
  const pathSetB = new Set(pathsB.filter((p) => p !== null));

  const unmatchedA = new Set();
  const missingA = new Set();
  for (let k = 0; k < n; k++) {
    if (matchedA.has(k) || trimmedA[k] === '' || isStructuralOnly(trimmedA[k])) continue;
    const path = pathsA[k];
    if (path !== null && !pathSetB.has(path)) missingA.add(k);
    else unmatchedA.add(k);
  }
  const unmatchedB = new Set();
  const missingB = new Set();
  for (let k = 0; k < m; k++) {
    if (matchedB.has(k) || trimmedB[k] === '' || isStructuralOnly(trimmedB[k])) continue;
    const path = pathsB[k];
    if (path !== null && !pathSetA.has(path)) missingB.add(k);
    else unmatchedB.add(k);
  }
  return { unmatchedA, unmatchedB, missingA, missingB };
}
