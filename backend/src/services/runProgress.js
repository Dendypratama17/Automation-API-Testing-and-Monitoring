// A flow run is one long synchronous HTTP request/response from the client's
// point of view — nothing is persisted to flow_run_steps until the whole run
// finishes (see flowRunner.js), so there's otherwise no way to show which
// steps have already completed while a run is still in flight. This is an
// in-memory, per-runToken buffer that flowExecutor appends each step's
// result to as soon as it completes, so the frontend can poll it and render
// steps as they land instead of waiting for the final response. In-memory
// only (resets on server restart) — same tradeoff as runCancellation.js.
//
// Shape: token -> array of "segments", one per flow run under that token —
// a single manual/scheduled run has exactly one segment; a Batch Run has one
// segment per flow in the batch, appended in the order they start, so the
// frontend can tell which steps belong to which flow. Lifecycle is owned by
// each route (not by runFlowAndPersist itself) so a batch can span several
// runFlowAndPersist calls under one shared token without one flow's finally
// block clearing/resetting progress out from under the next.
const progressByToken = new Map();

function initProgress(token) {
  if (token) progressByToken.set(token, []);
}
// Call once per flow run about to start under this token — a plain manual
// run calls this once; a batch calls it once per flow in the loop.
function startFlowSegment(token, flowId, flowName) {
  if (!token) return;
  const segments = progressByToken.get(token);
  if (segments) segments.push({ flow_id: flowId, flow_name: flowName, steps: [] });
}
// Finds THIS flow's own segment rather than assuming "whichever one was
// started last" — several flows in a parallel batch can be appending steps
// at the same time, so "last" wouldn't reliably mean "mine" once more than
// one is in flight at once. Searches from the end so a re-run of the same
// flow_id within one token (shouldn't normally happen, but not assumed
// impossible) attributes to its own most-recently-started segment.
function pushProgress(token, flowId, stepResult) {
  if (!token) return;
  const segments = progressByToken.get(token);
  if (!segments) return;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].flow_id === flowId) {
      segments[i].steps.push(stepResult);
      return;
    }
  }
}
function getProgress(token) {
  return progressByToken.get(token) || [];
}
// Called once the run (or whole batch) finishes, same moment as
// runCancellation's clearToken, so a reused/short-lived token doesn't sit in
// memory forever.
function clearProgress(token) {
  if (token) progressByToken.delete(token);
}

module.exports = { initProgress, startFlowSegment, pushProgress, getProgress, clearProgress };
