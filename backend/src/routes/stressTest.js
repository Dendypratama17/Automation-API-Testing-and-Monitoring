const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const catchAsync = require('../utils/catchAsync');
const { runStressTest, MAX_TOTAL_REQUESTS, MAX_CONCURRENCY } = require('../services/stressTestRunner');
const { markCancelled, clearToken } = require('../services/runCancellation');

// Marks a stress test's run_token cancelled — checked before every request
// in the worker pool below, so this stops it at the next request boundary.
router.post('/:runToken/cancel', catchAsync(async (req, res) => {
  markCancelled(req.params.runToken);
  res.json({ ok: true });
}));

// Fires `total_requests` real requests at one Endpoint (with `concurrency`
// in flight at a time) and returns just an aggregate summary — no per-request
// persistence, since a run can be hundreds of requests and nobody needs a
// flow_runs-style row for each one the way a normal Flow run does.
router.post('/', catchAsync(async (req, res) => {
  const {
    endpoint_id, environment_id, auth_credential_id = null,
    total_requests, concurrency, confirm_prod = false, run_token = null,
  } = req.body;

  const total = Number(total_requests);
  const conc = Number(concurrency);
  if (!Number.isInteger(total) || total < 1 || total > MAX_TOTAL_REQUESTS) {
    return res.status(400).json({ error: `total_requests must be a whole number between 1 and ${MAX_TOTAL_REQUESTS}` });
  }
  if (!Number.isInteger(conc) || conc < 1 || conc > MAX_CONCURRENCY) {
    return res.status(400).json({ error: `concurrency must be a whole number between 1 and ${MAX_CONCURRENCY}` });
  }
  if (conc > total) {
    return res.status(400).json({ error: 'concurrency cannot exceed total_requests' });
  }

  const endpointResult = await pool.query('SELECT * FROM endpoints WHERE id=$1', [endpoint_id]);
  const endpoint = endpointResult.rows[0];
  if (!endpoint) return res.status(404).json({ error: 'Endpoint not found' });

  const envResult = await pool.query('SELECT * FROM environments WHERE id=$1', [environment_id]);
  const environment = envResult.rows[0];
  if (!environment) return res.status(404).json({ error: 'Environment not found' });

  // Same safety gate as a normal run/batch-run — a stress test against a
  // protected (e.g. PROD) environment is exactly the kind of thing that
  // shouldn't fire on a misclick.
  if (environment.is_protected && !confirm_prod) {
    return res.status(412).json({
      error: 'CONFIRMATION_REQUIRED',
      message: `Environment "${environment.name}" is protected. Resend with confirm_prod: true to proceed.`,
    });
  }

  let credential = null;
  if (auth_credential_id) {
    const credResult = await pool.query('SELECT * FROM auth_credentials WHERE id=$1', [auth_credential_id]);
    credential = credResult.rows[0];
    if (!credential) return res.status(404).json({ error: 'Credential not found' });
  }

  let summary;
  try {
    summary = await runStressTest({ endpoint, environment, credential, totalRequests: total, concurrency: conc, runToken: run_token });
  } finally {
    clearToken(run_token);
  }
  res.json(summary);
}));

module.exports = router;
