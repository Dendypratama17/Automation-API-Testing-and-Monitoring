// A flow run is one long synchronous HTTP request/response — there's no
// long-lived connection to push a "stop" signal down, so cancellation works
// the other way around: the client hands the run a token up front, and
// flowExecutor's step loop polls this in-memory set on that same token
// between steps. In-memory only (resets on server restart) — a run that
// outlives a restart just can't be cancelled anymore, no worse than before
// this existed.
const cancelledTokens = new Set();

function markCancelled(token) {
  if (token) cancelledTokens.add(token);
}
function isCancelled(token) {
  return !!token && cancelledTokens.has(token);
}
// Called once the run finishes (cancelled or not) so a reused/short-lived
// token doesn't sit in the set forever.
function clearToken(token) {
  if (token) cancelledTokens.delete(token);
}

module.exports = { markCancelled, isCancelled, clearToken };
