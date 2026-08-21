const pool = require('../db/pool');
const { executeFlow } = require('./flowExecutor');
const { notifyFlowIfNeeded } = require('./telegramNotifier');
const { decrypt } = require('../utils/crypto');
const { getWebLoginToken } = require('./webLogin');
const { isCancelled, clearToken, getAbortSignal } = require('./runCancellation');
const { startFlowSegment } = require('./runProgress');

// File fields carry a base64 blob (see FormDataEditor) — persisting that raw
// on every historical run would bloat the DB fast, especially for flows on a
// short schedule interval. Keep the metadata, drop the actual bytes.
function sanitizeBodyForStorage(body) {
  if (Array.isArray(body)) return body.map(sanitizeBodyForStorage);
  if (body && typeof body === 'object') {
    if (body.__file__) {
      const bytes = body.data ? Math.round((body.data.length * 3) / 4) : 0;
      return { __file__: true, name: body.name, mimeType: body.mimeType, data: `<${bytes} bytes omitted>` };
    }
    const out = {};
    for (const [k, v] of Object.entries(body)) out[k] = sanitizeBodyForStorage(v);
    return out;
  }
  return body;
}

/**
 * Execute a flow's steps, persist the run + per-step results, bump schema
 * versions for any endpoint that drifted, and fire a notification if the
 * overall result warrants it. Shared by the manual run route and the cron
 * scheduler so both go through the exact same path.
 */
async function runFlowAndPersist(flow, steps, environment, triggeredBy, scheduleId = null, initialVariables = {}, runToken = null, progressToken = runToken, ownsToken = true) {
  const previousSchemas = {};
  for (const step of steps) {
    if (step.endpoint_id) {
      const schemaResult = await pool.query(
        'SELECT schema FROM endpoint_schemas WHERE endpoint_id=$1 ORDER BY version DESC LIMIT 1',
        [step.endpoint_id]
      );
      previousSchemas[step.endpoint_id] = schemaResult.rows[0]?.schema || null;
    }
  }

  // One shared map of credential id -> resolved credential (with a fresh
  // Web Login token, or a decrypted Basic password) — covers every step's
  // own `auth_credential_id`. Fetched once per unique credential per run,
  // not once per step.
  const authCredentials = {};
  const authIds = [...new Set(steps.filter((s) => s.auth_credential_id).map((s) => s.auth_credential_id))];
  if (authIds.length) {
    const credResult = await pool.query('SELECT * FROM auth_credentials WHERE id = ANY($1)', [authIds]);
    for (const row of credResult.rows) {
      // This whole resolution loop runs BEFORE executeFlow's own
      // isCancelled check ever gets a chance to run — without checking here
      // too, clicking Cancel while a slow (~15-20s) Web Login is still in
      // flight, or before the next credential in this loop starts, did
      // nothing at all, leaving the run stuck. `token` fetch itself is also
      // abort-aware via getAbortSignal (see webLogin.js), so a login already
      // in progress stops promptly instead of only being noticed here on
      // its next loop iteration.
      if (isCancelled(runToken)) break;
      if (row.type === 'web_login') {
        // Reuses a cached token until it's close to expiring (see
        // getWebLoginToken) instead of paying for a real ~15-20s browser
        // login on every run. If the login itself fails, skip setting this
        // credential — a step referencing it falls back to whatever
        // Authorization it already had configured (surfacing as that
        // step's own real HTTP error) instead of aborting the whole run.
        try {
          const decryptedPassword = decrypt(row.password);
          const token = await getWebLoginToken({ ...row, password: decryptedPassword }, getAbortSignal(runToken));
          // Keeps the decrypted password around (not just the token) so a
          // step that gets a 401 mid-run can force a fresh login itself
          // (see flowExecutor.js's runStep) — the cached token's predicted
          // expiry can be wrong if the server revokes it earlier.
          authCredentials[row.id] = { ...row, password: decryptedPassword, token };
        } catch (err) {
          console.error(`[flowRunner] Web Login credential "${row.name}" failed: ${err.message}`);
        }
      } else {
        authCredentials[row.id] = { ...row, password: decrypt(row.password) };
      }
    }
  }

  // Lifecycle (initProgress/clearProgress) is owned by the caller — a single
  // manual run wraps one runFlowAndPersist call, a Batch Run wraps several
  // under the same token, and only the caller knows when the whole thing
  // (not just this one flow) is actually done. This call just registers
  // this flow's own segment so its steps land in the right bucket.
  startFlowSegment(progressToken, flow.id, flow.name);
  let execution;
  try {
    // Cancelled while still resolving credentials above — no step has run
    // yet, so there's nothing for executeFlow itself to stop mid-way.
    execution = isCancelled(runToken)
      ? { status: 'CANCELLED', steps: [], variables: initialVariables }
      : await executeFlow(flow, steps, environment, previousSchemas, authCredentials, initialVariables, runToken, progressToken);
  } finally {
    // ownsToken is false for a Batch Run: several of these calls share one
    // token (serially, or — for a Parallel batch — several genuinely AT ONCE),
    // so clearing it here the moment THIS flow finishes would erase the
    // cancellation flag while a sibling flow that hasn't reached its own
    // isCancelled check yet is still relying on it (confirmed: cancelling a
    // parallel batch right at the start still let one flow run to completion
    // because another flow's near-instant CANCELLED exit cleared the token
    // out from under it). The caller clears it exactly once, after the whole
    // batch is done, same as clearProgress.
    if (ownsToken) clearToken(runToken);
  }

  // The run right before this one, for the same schedule (or the same
  // flow+environment+trigger-type when run manually) — only used to detect a
  // recovery (bad → PASS), since every bad run now always alerts.
  const previousRunResult = await pool.query(
    scheduleId
      ? `SELECT status FROM flow_runs WHERE schedule_id=$1 ORDER BY created_at DESC LIMIT 1`
      : `SELECT status FROM flow_runs WHERE flow_id=$1 AND environment_id=$2 AND triggered_by=$3 ORDER BY created_at DESC LIMIT 1`,
    scheduleId ? [scheduleId] : [flow.id, environment.id, triggeredBy]
  );
  const previousStatus = previousRunResult.rows[0]?.status ?? null;

  const runInsert = await pool.query(
    `INSERT INTO flow_runs (flow_id, environment_id, status, triggered_by, schedule_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [flow.id, environment.id, execution.status, triggeredBy, scheduleId]
  );
  const flowRun = runInsert.rows[0];

  for (const step of execution.steps) {
    await pool.query(
      `INSERT INTO flow_run_steps
        (flow_run_id, endpoint_id, step_order, name, status, request_method, request_url, request_id, request_body, request_headers, response_status_code, response_time_ms, response_body, error_message, assertion_results, extracted_variables, schema_diffs)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13::jsonb,$14,$15::jsonb,$16::jsonb,$17::jsonb)`,
      [
        flowRun.id, step.endpoint_id, step.step_order, step.name, step.status, step.request_method, step.request_url,
        step.request_id ?? null, JSON.stringify(sanitizeBodyForStorage(step.request_body ?? null)),
        JSON.stringify(step.request_headers ?? null),
        step.response_status_code, step.response_time_ms, JSON.stringify(step.response_body ?? null),
        step.error_message, JSON.stringify(step.assertion_results ?? null), JSON.stringify(step.extracted_variables || {}), JSON.stringify(step.schema_diffs || []),
      ]
    );

    if (step.endpoint_id && step.schema_diffs?.length > 0) {
      const versionResult = await pool.query(
        'SELECT COALESCE(MAX(version),0)+1 as next FROM endpoint_schemas WHERE endpoint_id=$1',
        [step.endpoint_id]
      );
      await pool.query(
        'INSERT INTO endpoint_schemas (endpoint_id, schema, version) VALUES ($1,$2::jsonb,$3)',
        [step.endpoint_id, JSON.stringify(step.schema), versionResult.rows[0].next]
      );
    }
  }

  await notifyFlowIfNeeded({
    ...flowRun,
    flow_name: flow.name,
    environment_name: environment.name,
    steps: execution.steps,
  }, previousStatus);

  return { flow_run: flowRun, steps: execution.steps, variables: execution.variables };
}

module.exports = { runFlowAndPersist };
