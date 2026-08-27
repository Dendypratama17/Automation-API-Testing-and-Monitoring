// A form-data request body is an array of [key, value] tuples rather than
// a plain {key: value} object — the only shape that can hold a repeated
// key (e.g. two separate "documents" file parts in one upload) without one
// silently overwriting the other (see FormDataEditor.jsx's formRowsToBody).
// Plain `JSON.stringify` renders that literally as nested arrays —
// `[\n  "key",\n  value\n],\n` per entry — which is technically correct but
// far harder to read than the old flat-object body ever was. This walks the
// same structure but renders a tuple array looking like a plain object (one
// "key": value line per entry, duplicates included) — real JSON.stringify
// still handles everything else (nested objects/arrays/primitives) exactly
// as before. Shared by JsonBlock.jsx (the in-app viewer) and
// exportRunResultPdf.js (the downloaded/shared PDF) so a request body reads
// identically in both places.
//
// A real API response can legitimately BE an array of 2-element string
// tuples (e.g. `[["us","United States"],["ca","Canada"]]`) — structure
// alone can't tell that apart from our own form-data body shape. Requiring
// an actual `__file__`/`__file_url__` marker somewhere inside (the default,
// `loose=false`) removes that ambiguity for values that might be a
// response. Callers that KNOW the value is a request body they built
// themselves (never a response from some external API) can pass
// `loose=true` to widen this to ANY tuple-shaped array, file attached or
// not — safe there because the tuple shape only ever comes from our own
// form-data body construction.
export function containsFileMarker(value) {
  if (Array.isArray(value)) return value.some(containsFileMarker);
  if (value && typeof value === 'object') {
    if (value.__file__ || value.__file_url__) return true;
    return Object.values(value).some(containsFileMarker);
  }
  return false;
}

export function isTupleShaped(value) {
  return Array.isArray(value) && value.length > 0
    && value.every((el) => Array.isArray(el) && el.length === 2 && typeof el[0] === 'string');
}

export function isTupleArray(value, loose = false) {
  if (!isTupleShaped(value)) return false;
  return loose || value.some(([, v]) => containsFileMarker(v));
}

export function stringifyBodyForDisplay(value, indent = 0, loose = false) {
  const pad = '  '.repeat(indent);
  const childPad = '  '.repeat(indent + 1);
  if (isTupleArray(value, loose)) {
    const lines = value.map(([k, v]) => `${childPad}${JSON.stringify(k)}: ${stringifyBodyForDisplay(v, indent + 1, loose)}`);
    return `{\n${lines.join(',\n')}\n${pad}}`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const lines = value.map((v) => `${childPad}${stringifyBodyForDisplay(v, indent + 1, loose)}`);
    return `[\n${lines.join(',\n')}\n${pad}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    const lines = keys.map((k) => `${childPad}${JSON.stringify(k)}: ${stringifyBodyForDisplay(value[k], indent + 1, loose)}`);
    return `{\n${lines.join(',\n')}\n${pad}}`;
  }
  return JSON.stringify(value);
}
