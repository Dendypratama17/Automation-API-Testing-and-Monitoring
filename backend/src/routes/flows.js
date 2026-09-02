const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const catchAsync = require('../utils/catchAsync');
const { runFlowAndPersist } = require('../services/flowRunner');
const { parseCurl, toPathTemplate } = require('../services/curlParser');
const { markCancelled, isCancelled, clearToken } = require('../services/runCancellation');
const { initProgress, clearProgress, getProgress } = require('../services/runProgress');

async function replaceSteps(client, flowId, steps) {
  await client.query('DELETE FROM flow_steps WHERE flow_id=$1', [flowId]);
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    await client.query(
      `INSERT INTO flow_steps (flow_id, endpoint_id, auth_credential_id, step_order, name, method, url_template, headers, body_template, body_type, body_text, response_type, extract, assertions, enabled, delay_ms, parallel_with_previous, run_condition_status_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16,$17,$18)`,
      [
        flowId, s.endpoint_id || null, s.auth_credential_id || null, i, s.name, s.method, s.url_template,
        JSON.stringify(s.headers || {}),
        JSON.stringify(s.body_template ?? null),
        s.body_type || 'json',
        s.body_type === 'json' ? (s.body_text ?? null) : null,
        s.response_type === 'base64' ? 'base64' : 'auto',
        JSON.stringify(s.extract || []),
        JSON.stringify(s.assertions || []),
        s.enabled !== false,
        Number(s.delay_ms) || 0,
        i > 0 && s.parallel_with_previous === true,
        // No previous step to check for the first one — always null there
        // regardless of what's sent.
        i > 0 && Number.isInteger(s.run_condition_status_code) ? s.run_condition_status_code : null,
      ]
    );
  }
}

// Parses a curl command into a step's fields (method/url/headers/body)
// without creating an Endpoint row — used by the Flow step editor's "Paste
// curl" option to fill in a step directly, for a one-off request that
// doesn't need its own reusable Endpoint template. URL gets the same
// {{base_url}}-templating an Endpoint import would get, so the step still
// runs correctly across environments instead of only against whichever
// environment the pasted curl happened to be captured from.
router.post('/parse-curl', catchAsync(async (req, res) => {
  const { curl } = req.body;
  if (!curl?.trim()) return res.status(400).json({ error: 'curl string is required' });

  const parsed = parseCurl(curl);
  if (!parsed.url) return res.status(400).json({ error: 'Could not detect URL in curl command' });

  const envResult = await pool.query('SELECT * FROM environments');
  const urlTemplate = toPathTemplate(parsed.url, envResult.rows);

  res.json({
    method: parsed.method,
    url_template: urlTemplate,
    headers: parsed.headers,
    body: parsed.body,
    is_multipart: parsed.isMultipart === true,
  });
}));

// Cancels an in-flight run started with this same token (see `run_token` on
// POST /:id/run) — the run stops at the next step boundary rather than
// mid-request, and persists as far as it got with status CANCELLED. No-op
// (still 200) if the run already finished or the token is unrecognized,
// since the client can't tell which case it is from here.
router.post('/runs/:runToken/cancel', catchAsync(async (req, res) => {
  markCancelled(req.params.runToken);
  res.json({ ok: true });
}));

// Steps completed so far for a run (or Batch Run) still in flight — polled
// by the frontend while `running` is true so results appear as each step
// lands instead of only once the whole thing finishes. `segments` is one
// entry per flow run under this token — always exactly one for a plain
// manual run, one per flow (in start order) for a Batch Run. Empty array
// once the run ends (or for an unrecognized token), same "can't tell which
// case" shrug as cancel above.
router.get('/runs/:runToken/progress', catchAsync(async (req, res) => {
  res.json({ segments: getProgress(req.params.runToken) });
}));

// LIST flows, optionally filtered by folder (folder_id=null for uncategorized)
router.get('/', catchAsync(async (req, res) => {
  const { folder_id } = req.query;
  const params = [];
  let where = '';
  if (folder_id === 'null') {
    where = 'WHERE f.folder_id IS NULL';
  } else if (folder_id) {
    params.push(folder_id);
    where = 'WHERE f.folder_id = $1';
  }

  const result = await pool.query(
    `SELECT f.*, COUNT(fs.id) as step_count
     FROM flows f LEFT JOIN flow_steps fs ON fs.flow_id = f.id
     ${where}
     GROUP BY f.id ORDER BY f.sort_order ASC, f.id DESC`,
    params
  );
  res.json(result.rows);
}));

// REORDER: persist drag-and-drop order from the Flow List — `ids` is the
// full list of flow ids in their new display order.
router.put('/reorder', catchAsync(async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids must be a non-empty array' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < ids.length; i++) {
      await client.query('UPDATE flows SET sort_order=$1 WHERE id=$2', [i, ids[i]]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  const result = await pool.query(
    `SELECT f.*, COUNT(fs.id) as step_count
     FROM flows f LEFT JOIN flow_steps fs ON fs.flow_id = f.id
     GROUP BY f.id ORDER BY f.sort_order ASC, f.id DESC`
  );
  res.json(result.rows);
}));

// GET single flow with its ordered steps
router.get('/:id', catchAsync(async (req, res) => {
  const flowResult = await pool.query('SELECT * FROM flows WHERE id=$1', [req.params.id]);
  const flow = flowResult.rows[0];
  if (!flow) return res.status(404).json({ error: 'Not found' });

  const stepsResult = await pool.query(
    'SELECT * FROM flow_steps WHERE flow_id=$1 ORDER BY step_order ASC',
    [req.params.id]
  );
  res.json({ ...flow, steps: stepsResult.rows });
}));

// CREATE flow + steps
router.post('/', catchAsync(async (req, res) => {
  const { name, description, folder_id = null, stop_on_failure = true, steps = [] } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const flowResult = await client.query(
      `INSERT INTO flows (name, description, folder_id, stop_on_failure) VALUES ($1,$2,$3,$4) RETURNING *`,
      [name, description || null, folder_id, stop_on_failure]
    );
    const flow = flowResult.rows[0];
    await replaceSteps(client, flow.id, steps);
    await client.query('COMMIT');

    const stepsResult = await pool.query('SELECT * FROM flow_steps WHERE flow_id=$1 ORDER BY step_order', [flow.id]);
    res.status(201).json({ ...flow, steps: stepsResult.rows });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// UPDATE flow (name/description/folder/settings) and replace its steps wholesale
router.put('/:id', catchAsync(async (req, res) => {
  const { name, description, folder_id = null, stop_on_failure = true, steps = [] } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const flowResult = await client.query(
      `UPDATE flows SET name=$1, description=$2, folder_id=$3, stop_on_failure=$4, updated_at=NOW() WHERE id=$5 RETURNING *`,
      [name, description || null, folder_id, stop_on_failure, req.params.id]
    );
    const flow = flowResult.rows[0];
    if (!flow) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found' });
    }
    await replaceSteps(client, flow.id, steps);
    await client.query('COMMIT');

    const stepsResult = await pool.query('SELECT * FROM flow_steps WHERE flow_id=$1 ORDER BY step_order', [flow.id]);
    res.json({ ...flow, steps: stepsResult.rows });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// DELETE flow
router.delete('/:id', catchAsync(async (req, res) => {
  await pool.query('DELETE FROM flows WHERE id=$1', [req.params.id]);
  res.status(204).send();
}));

// DUPLICATE flow: copies the flow (name suffixed " (Copy)") and all its steps
// into a new flow in the same folder — speeds up building edge-case variants
// (e.g. a "force failed" version) from an existing flow.
router.post('/:id/duplicate', catchAsync(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const flowResult = await client.query('SELECT * FROM flows WHERE id=$1', [req.params.id]);
    const original = flowResult.rows[0];
    if (!original) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Flow not found' });
    }

    const stepsResult = await client.query('SELECT * FROM flow_steps WHERE flow_id=$1 ORDER BY step_order', [original.id]);

    const newFlowResult = await client.query(
      `INSERT INTO flows (name, description, folder_id, stop_on_failure) VALUES ($1,$2,$3,$4) RETURNING *`,
      [`${original.name} (Copy)`, original.description, original.folder_id, original.stop_on_failure]
    );
    const newFlow = newFlowResult.rows[0];
    await replaceSteps(client, newFlow.id, stepsResult.rows);
    await client.query('COMMIT');

    const newStepsResult = await pool.query('SELECT * FROM flow_steps WHERE flow_id=$1 ORDER BY step_order', [newFlow.id]);
    res.status(201).json({ ...newFlow, steps: newStepsResult.rows });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// RUN flow: execute all steps in order against an environment, chaining
// extracted variables, and persist the result (flow_runs / flow_run_steps).
router.post('/:id/run', catchAsync(async (req, res) => {
  const { environment_id, confirm_prod = false, triggered_by = 'manual', run_token = null } = req.body;

  const flowResult = await pool.query('SELECT * FROM flows WHERE id=$1', [req.params.id]);
  const flow = flowResult.rows[0];
  if (!flow) return res.status(404).json({ error: 'Flow not found' });

  const stepsResult = await pool.query('SELECT * FROM flow_steps WHERE flow_id=$1 ORDER BY step_order', [flow.id]);
  if (stepsResult.rows.length === 0) return res.status(400).json({ error: 'Flow has no steps' });
  const stepsToRun = stepsResult.rows.filter((s) => s.enabled !== false);
  if (stepsToRun.length === 0) return res.status(400).json({ error: 'Flow has no enabled steps' });

  const envResult = await pool.query('SELECT * FROM environments WHERE id=$1', [environment_id]);
  const environment = envResult.rows[0];
  if (!environment) return res.status(404).json({ error: 'Environment not found' });

  // Safety gate: protected environments (e.g. PROD) require explicit confirmation
  if (environment.is_protected && !confirm_prod) {
    return res.status(412).json({
      error: 'CONFIRMATION_REQUIRED',
      message: `Environment "${environment.name}" is protected. Resend with confirm_prod: true to proceed.`,
    });
  }

  initProgress(run_token);
  let result;
  try {
    result = await runFlowAndPersist(flow, stepsToRun, environment, triggered_by, null, {}, run_token);
  } finally {
    clearProgress(run_token);
  }
  // Don't expose `variables` (environment secrets + everything extracted) —
  // it only exists internally for chaining into the next flow in a batch run.
  res.json({ flow_run: result.flow_run, steps: result.steps });
}));

// RUN a single step in isolation (ad-hoc re-test of one request). Other
// steps in the flow don't run in this call, but any variable they'd normally
// have extracted (e.g. a token or a {{url}} pulled from an earlier step's
// response) is seeded from the flow's most recent full run — otherwise
// re-testing one step deep in a chain would always see an unresolved
// {{variable}} placeholder instead of the real value. Still persisted like
// any other run, so it shows up in the Dashboard same as a full flow run would.
router.post('/:id/steps/:stepId/run', catchAsync(async (req, res) => {
  const { environment_id, confirm_prod = false, triggered_by = 'manual' } = req.body;

  const flowResult = await pool.query('SELECT * FROM flows WHERE id=$1', [req.params.id]);
  const flow = flowResult.rows[0];
  if (!flow) return res.status(404).json({ error: 'Flow not found' });

  const stepResult = await pool.query('SELECT * FROM flow_steps WHERE id=$1 AND flow_id=$2', [req.params.stepId, flow.id]);
  const step = stepResult.rows[0];
  if (!step) return res.status(404).json({ error: 'Step not found' });

  const envResult = await pool.query('SELECT * FROM environments WHERE id=$1', [environment_id]);
  const environment = envResult.rows[0];
  if (!environment) return res.status(404).json({ error: 'Environment not found' });

  if (environment.is_protected && !confirm_prod) {
    return res.status(412).json({
      error: 'CONFIRMATION_REQUIRED',
      message: `Environment "${environment.name}" is protected. Resend with confirm_prod: true to proceed.`,
    });
  }

  const lastRun = await pool.query('SELECT id FROM flow_runs WHERE flow_id=$1 ORDER BY created_at DESC LIMIT 1', [flow.id]);
  const initialVariables = {};
  if (lastRun.rows[0]) {
    const lastRunSteps = await pool.query(
      'SELECT extracted_variables FROM flow_run_steps WHERE flow_run_id=$1 ORDER BY step_order ASC',
      [lastRun.rows[0].id]
    );
    for (const row of lastRunSteps.rows) Object.assign(initialVariables, row.extracted_variables || {});
  }

  const result = await runFlowAndPersist(flow, [step], environment, triggered_by, null, initialVariables);
  res.json({ flow_run: result.flow_run, steps: result.steps });
}));

// TOGGLE a single step's enabled flag — unchecked steps are skipped on the
// next full/batch/scheduled run of this flow, without needing to open the
// full edit form and re-save every step.
router.patch('/:id/steps/:stepId', catchAsync(async (req, res) => {
  const { enabled } = req.body;
  const result = await pool.query(
    'UPDATE flow_steps SET enabled=$1 WHERE id=$2 AND flow_id=$3 RETURNING *',
    [enabled !== false, req.params.stepId, req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Step not found' });
  res.json(result.rows[0]);
}));

// BULK TOGGLE every step of a flow's enabled flag in one call — backs the
// View Flow panel's "Select All" / "Unselect All" controls.
router.patch('/:id/steps', catchAsync(async (req, res) => {
  const { enabled } = req.body;
  const result = await pool.query(
    'UPDATE flow_steps SET enabled=$1 WHERE flow_id=$2 RETURNING *',
    [enabled !== false, req.params.id]
  );
  res.json(result.rows);
}));

// BATCH RUN: run several flows in sequence against one environment, chaining
// each flow's extracted variables into the next — e.g. run a "Login" flow
// first, then a "Get Profile" flow that reuses the token it extracted.
// Looks up one flow + its enabled steps and runs it, returning the same
// `{ flow_id, flow_name, flow_run, steps }` (or `{ flow_id, [flow_name,]
// error }`) shape either way — shared by both the serial and parallel paths
// below so they only differ in how they call this, not in what a "result"
// looks like.
async function runOneBatchFlow(flowId, environment, triggeredBy, initialVariables, runToken) {
  const flowResult = await pool.query('SELECT * FROM flows WHERE id=$1', [flowId]);
  const flow = flowResult.rows[0];
  if (!flow) return { flow_id: flowId, error: 'Flow not found' };

  const stepsResult = await pool.query('SELECT * FROM flow_steps WHERE flow_id=$1 ORDER BY step_order', [flow.id]);
  const stepsToRun = stepsResult.rows.filter((s) => s.enabled !== false);
  if (stepsToRun.length === 0) return { flow_id: flow.id, flow_name: flow.name, error: 'Flow has no enabled steps' };

  // ownsToken: false — several flows in a batch share one cancellation token
  // (concurrently, for a Parallel batch), so the route clears it exactly
  // once after the whole batch finishes instead of each flow clearing it
  // out from under whichever siblings are still running.
  const result = await runFlowAndPersist(flow, stepsToRun, environment, triggeredBy, null, initialVariables, runToken, runToken, false);
  return { flow_id: flow.id, flow_name: flow.name, flow_run: result.flow_run, steps: result.steps, variables: result.variables };
}

router.post('/batch-run', catchAsync(async (req, res) => {
  const { flow_ids, environment_id, confirm_prod = false, triggered_by = 'manual', run_token = null, parallel = false } = req.body;
  if (!Array.isArray(flow_ids) || flow_ids.length === 0) {
    return res.status(400).json({ error: 'flow_ids must be a non-empty array' });
  }

  const envResult = await pool.query('SELECT * FROM environments WHERE id=$1', [environment_id]);
  const environment = envResult.rows[0];
  if (!environment) return res.status(404).json({ error: 'Environment not found' });

  if (environment.is_protected && !confirm_prod) {
    return res.status(412).json({
      error: 'CONFIRMATION_REQUIRED',
      message: `Environment "${environment.name}" is protected. Resend with confirm_prod: true to proceed.`,
    });
  }

  // One shared token for the whole batch — used for BOTH progress (each flow
  // below gets its own segment under it, polled via GET /runs/:runToken/progress
  // same as a single run) and cancellation. runOneBatchFlow passes ownsToken:
  // false so the token isn't cleared until the WHOLE batch is done (see the
  // finally block below) — for a Parallel batch several flows share it AT
  // THE SAME TIME, and one finishing (cancelled or not) clearing it early
  // would erase the cancellation flag out from under a sibling still running.
  initProgress(run_token);
  let results;
  try {
    if (parallel) {
      // Flows run independently — no variable chaining between them (there's
      // no "previous flow" once they're all in flight at once), and one
      // flow's hard failure (a thrown error, not just a FAIL/ERROR step
      // result) shouldn't take the rest down with it, hence allSettled
      // instead of Promise.all.
      const settled = await Promise.allSettled(
        flow_ids.map((flowId) => runOneBatchFlow(flowId, environment, triggered_by, {}, run_token))
      );
      results = settled.map((s, i) => (
        s.status === 'fulfilled' ? s.value : { flow_id: flow_ids[i], error: s.reason?.message || 'Unexpected error' }
      ));
    } else {
      results = [];
      let carryVariables = {};
      for (const flowId of flow_ids) {
        if (isCancelled(run_token)) break;
        const r = await runOneBatchFlow(flowId, environment, triggered_by, carryVariables, run_token);
        if (r.variables) carryVariables = r.variables; // hand off to the next flow in the batch
        results.push(r);
        if (r.flow_run?.status === 'CANCELLED') break;
      }
    }
  } finally {
    clearProgress(run_token);
    clearToken(run_token);
  }

  res.json({ results: results.map(({ variables, ...r }) => r) });
}));

// Run history for a flow (for a simple list; use /api/flow-runs/:id for full detail)
router.get('/:id/runs', catchAsync(async (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const result = await pool.query(
    `SELECT fr.*, e.name as environment_name
     FROM flow_runs fr JOIN environments e ON e.id = fr.environment_id
     WHERE fr.flow_id=$1 ORDER BY fr.created_at DESC LIMIT $2`,
    [req.params.id, limit]
  );
  res.json(result.rows);
}));

module.exports = router;
