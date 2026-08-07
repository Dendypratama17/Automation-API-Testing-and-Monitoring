const pool = require('../db/pool');
const { executeFlow } = require('./flowExecutor');
const { notifyFlowIfNeeded } = require('./telegramNotifier');
const { decrypt } = require('../utils/crypto');
const { getWebLoginToken } = require('./webLogin');

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
async function runFlowAndPersist(flow, steps, environment, triggeredBy, scheduleId = null, initialVariables = {}) {
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

  const authCredentials = {};
  const authIds = [...new Set(steps.filter((s) => s.auth_credential_id).map((s) => s.auth_credential_id))];
  if (authIds.length) {
    const credResult = await pool.query('SELECT * FROM auth_credentials WHERE id = ANY($1)', [authIds]);
    for (const row of credResult.rows) {
      if (row.type === 'web_login') {
        // Reuses a cached token until it's close to expiring (see
        // getWebLoginToken) instead of paying for a real ~15-20s browser
        // login on every run. If the login itself fails, skip setting this
        // credential — the step falls back to whatever Authorization it
        // already had configured (surfacing as that step's own real HTTP
        // error) instead of aborting every other step in the run.
        try {
          const token = await getWebLoginToken({ ...row, password: decrypt(row.password) });
          authCredentials[row.id] = { ...row, token };
        } catch (err) {
          console.error(`[flowRunner] Web Login credential "${row.name}" failed: ${err.message}`);
        }
      } else {
        authCredentials[row.id] = { ...row, password: decrypt(row.password) };
      }
    }
  }

  // Flow-level Web Login credential: refreshes the Authorization header of
  // every step whose header is ALREADY Bearer-scheme (e.g. a stale token
  // baked in from a curl import), with no per-step assignment needed —
  // unlike the `auth_credential_id` mechanism above, which only touches the
  // one step it's explicitly assigned to. Deliberately does NOT touch a step
  // whose Authorization uses a different scheme (Basic, a custom internal
  // format, ...) — that step may intentionally authenticate against a
  // different service (e.g. an internal-only endpoint using service-to-
  // service Basic auth) than the customer-facing steps this credential is
  // meant to refresh, and blindly overwriting it caused those steps to send
  // the wrong credential entirely (a 401, not just a stale token).
  if (flow.web_login_credential_id) {
    const credResult = await pool.query(
      `SELECT * FROM auth_credentials WHERE id=$1 AND type='web_login'`,
      [flow.web_login_credential_id]
    );
    const cred = credResult.rows[0];
    if (cred) {
      try {
        const token = await getWebLoginToken({ ...cred, password: decrypt(cred.password) });
        steps = steps.map((step) => {
          if (step.skip_web_login_refresh) return step;
          const authKey = Object.keys(step.headers || {}).find((k) => k.toLowerCase() === 'authorization');
          if (!authKey) return step;
          const raw = step.headers[authKey];
          const isDisabledWrapper = raw && typeof raw === 'object' && raw.__disabled__;
          const currentValue = isDisabledWrapper ? raw.value : raw;
          if (typeof currentValue !== 'string' || !/^bearer\s/i.test(currentValue.trim())) return step;
          const newValue = `Bearer ${token}`;
          return {
            ...step,
            headers: { ...step.headers, [authKey]: isDisabledWrapper ? { ...raw, value: newValue } : newValue },
          };
        });
      } catch (err) {
        console.error(`[flowRunner] Flow-level Web Login credential "${cred.name}" failed: ${err.message}`);
      }
    }
  }

  const execution = await executeFlow(flow, steps, environment, previousSchemas, authCredentials, initialVariables);

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
