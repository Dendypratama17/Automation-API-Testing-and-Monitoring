// A flow run is one long synchronous HTTP request/response — there's no
// long-lived connection to push a "stop" signal down, so cancellation works
// the other way around: the client hands the run a token up front, and
// flowExecutor's step loop polls this in-memory set on that same token
// between steps. In-memory only (resets on server restart) — a run that
// outlives a restart just can't be cancelled anymore, no worse than before
// this existed.
const cancelledTokens = new Set();

// Checking isCancelled between batches/steps only helps once whatever's
// currently in flight (an axios request, a Puppeteer login) actually
// finishes on its own — a slow/hanging one could ignore Cancel for its full
// 15s timeout, or a 15-30s Web Login attempt, with the button just sitting
// there doing nothing. One AbortController per run token lets markCancelled
// actually interrupt that in-flight work immediately instead of only being
// noticed afterward.
const abortControllers = new Map();

function markCancelled(token) {
  if (!token) return;
  cancelledTokens.add(token);
  abortControllers.get(token)?.abort();
}
function isCancelled(token) {
  return !!token && cancelledTokens.has(token);
}
// Called once the run finishes (cancelled or not) so a reused/short-lived
// token doesn't sit in the set forever.
function clearToken(token) {
  if (!token) return;
  cancelledTokens.delete(token);
  abortControllers.delete(token);
}
// Lazily creates (and reuses) the AbortController backing a run token, so
// every request fired under the same token shares one signal — cancelling
// stops all of them, not just whichever call happens to ask first. If
// markCancelled already ran before anything registered a signal (a plausible
// race — cancel clicked the instant a run starts), the freshly-created
// controller is aborted immediately instead of missing that signal.
function getAbortSignal(token) {
  if (!token) return undefined;
  let controller = abortControllers.get(token);
  if (!controller) {
    controller = new AbortController();
    if (cancelledTokens.has(token)) controller.abort();
    abortControllers.set(token, controller);
  }
  return controller.signal;
}

module.exports = { markCancelled, isCancelled, clearToken, getAbortSignal };
