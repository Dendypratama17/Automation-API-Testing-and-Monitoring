const pool = require('../db/pool');

async function getDefaultHeaders() {
  const result = await pool.query('SELECT key, value FROM default_headers ORDER BY sort_order ASC, id ASC');
  return result.rows;
}

// A key can have several default rows (several allowed values, used as
// dropdown choices) — the auto-fill value is always whichever sorts first
// (drag-to-reorder in Config > Default Headers controls this), not whichever
// was added most recently.
function firstValuePerKey(defaults) {
  const byKeyLower = new Map();
  for (const { key, value } of defaults) {
    const lower = key.toLowerCase();
    if (!byKeyLower.has(lower)) byKeyLower.set(lower, { key, value });
  }
  return [...byKeyLower.values()];
}

// These headers describe which client/app is calling (platform, app name,
// app version) — always the same across every environment/import, so the
// Config > Default Headers value is the source of truth even when a cURL
// paste happened to carry its own (often stale, copied-from-somewhere-else)
// value for one of them. Every other header keeps the normal rule: an
// existing/captured value wins over the generic default.
const FORCE_DEFAULT_KEYS = new Set(['x-platform-name', 'x-platform-type', 'x-application-name', 'x-application-version']);

// Merge the default header template into an endpoint's headers — an existing
// key (imported or manually set) wins, case-insensitively, since a real
// captured value is usually more trustworthy than a generic default. The
// FORCE_DEFAULT_KEYS above are the exception: those always follow whatever
// Config > Default Headers currently says, even overwriting a curl-provided
// value for that same key (keeping its original casing).
function mergeHeaders(headers, defaults) {
  const merged = { ...(headers || {}) };
  const existingKeyByLower = new Map(Object.keys(merged).map((k) => [k.toLowerCase(), k]));
  for (const { key, value } of firstValuePerKey(defaults)) {
    const lower = key.toLowerCase();
    const existingKey = existingKeyByLower.get(lower);
    if (!existingKey) {
      merged[key] = value;
    } else if (FORCE_DEFAULT_KEYS.has(lower)) {
      merged[existingKey] = value;
    }
  }
  return merged;
}

// Backfills the current default header template onto every endpoint that
// doesn't already define one of those keys. Called right after the template
// itself changes, so existing endpoints (not just future imports) pick up a
// newly-added default. Never removes or overwrites a key an endpoint already has.
async function syncDefaultHeadersToEndpoints() {
  const defaults = await getDefaultHeaders();
  if (defaults.length === 0) return;

  const endpointsResult = await pool.query('SELECT id, headers FROM endpoints');
  for (const ep of endpointsResult.rows) {
    const merged = mergeHeaders(ep.headers, defaults);
    if (JSON.stringify(merged) !== JSON.stringify(ep.headers || {})) {
      await pool.query('UPDATE endpoints SET headers=$1::jsonb WHERE id=$2', [JSON.stringify(merged), ep.id]);
    }
  }
}

module.exports = { getDefaultHeaders, mergeHeaders, syncDefaultHeadersToEndpoints };
