// Shared sessionStorage draft for the JSON Diff page (frontend/src/pages/JsonDiff.jsx)
// — lets other pages (e.g. a "Send to JSON Diff" action on a response body)
// hand off a JSON value into JSON A/B without threading props/context
// through the whole app.
export const JSON_DIFF_DRAFT_KEY = 'qa-tool:json-diff-draft';

export function readJsonDiffDraft() {
  try {
    return JSON.parse(sessionStorage.getItem(JSON_DIFF_DRAFT_KEY)) || {};
  } catch {
    return {};
  }
}

export function writeJsonDiffDraft(patch) {
  const next = { ...readJsonDiffDraft(), ...patch };
  sessionStorage.setItem(JSON_DIFF_DRAFT_KEY, JSON.stringify(next));
}
