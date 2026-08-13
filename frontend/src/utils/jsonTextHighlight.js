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

export function computeLineDiff(linesA, linesB) {
  if (linesA.length > MAX_LINES_FOR_DIFF || linesB.length > MAX_LINES_FOR_DIFF) {
    return { unmatchedA: new Set(), unmatchedB: new Set() };
  }
  const n = linesA.length;
  const m = linesB.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = linesA[i] === linesB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const matchedA = new Set();
  const matchedB = new Set();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (linesA[i] === linesB[j]) {
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
  const unmatchedA = new Set();
  for (let k = 0; k < n; k++) if (!matchedA.has(k) && linesA[k].trim() !== '') unmatchedA.add(k);
  const unmatchedB = new Set();
  for (let k = 0; k < m; k++) if (!matchedB.has(k) && linesB[k].trim() !== '') unmatchedB.add(k);
  return { unmatchedA, unmatchedB };
}
