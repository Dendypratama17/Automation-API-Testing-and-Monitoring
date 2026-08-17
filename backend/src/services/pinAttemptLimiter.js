// In-memory attempt tracker for PIN-gated actions (currently just Authorization
// credentials' "reveal password") — resets on server restart, same accepted
// tradeoff as runCancellation.js/runProgress.js elsewhere in this codebase.
// A hardcoded 3-digit PIN is only a meaningful gate if it can't just be
// brute-forced in a few seconds; this adds a lockout after repeated wrong
// attempts for a given key (e.g. a credential id).
const attemptsByKey = new Map();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 60_000;

function getLockState(key) {
  const entry = attemptsByKey.get(key);
  if (!entry || entry.lockedUntil <= Date.now()) return { locked: false };
  return { locked: true, retryAfterMs: entry.lockedUntil - Date.now() };
}

function recordFailedAttempt(key) {
  const now = Date.now();
  const entry = attemptsByKey.get(key) || { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = now + LOCKOUT_MS;
    entry.count = 0;
  }
  attemptsByKey.set(key, entry);
}

function clearAttempts(key) {
  attemptsByKey.delete(key);
}

module.exports = { getLockState, recordFailedAttempt, clearAttempts };
