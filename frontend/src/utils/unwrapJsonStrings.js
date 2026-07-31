// A multipart form field is sometimes itself a JSON-encoded string — the
// only way to send structured data alongside a file in form-data, since
// multipart fields are flat strings — which JSON.stringify would otherwise
// render as one escaped blob (e.g. "participants": "[{\"type\":\"SIGNER\"...").
// Unwrap it into a real nested structure so it reads normally, recursively
// (a field can itself contain further JSON-as-string values). Used anywhere
// a request/response body gets shown as formatted JSON — the step editor's
// Form Data → JSON preview, and a completed run's actual request/response
// body in Flows/Schedules/Dashboard.
export function unwrapJsonStrings(value) {
  if (Array.isArray(value)) return value.map(unwrapJsonStrings);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = unwrapJsonStrings(v);
    return out;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') return unwrapJsonStrings(parsed);
      } catch {
        // Not valid JSON — leave it as a plain string.
      }
    }
  }
  return value;
}
