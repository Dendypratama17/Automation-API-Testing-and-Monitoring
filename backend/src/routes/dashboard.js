const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const catchAsync = require('../utils/catchAsync');

// LIST endpoints with health score (% pass in last N days) and latest p95,
// computed from flow_run_steps (every hit made through a Flow).
router.get('/endpoints-overview', catchAsync(async (req, res) => {
  const days = parseInt(req.query.days) || 7;

  const query = `
    SELECT
      e.id, e.name, e.method, e.path_template, e.tags,
      COUNT(frs.id) as total_runs,
      COUNT(frs.id) FILTER (WHERE frs.status = 'PASS') as pass_count,
      ROUND(
        100.0 * COUNT(frs.id) FILTER (WHERE frs.status = 'PASS') / GREATEST(COUNT(frs.id), 1), 1
      ) as health_score,
      COUNT(frs.id) FILTER (WHERE frs.status = 'SCHEMA_DRIFT') as drift_count,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY frs.response_time_ms) as p95_ms,
      MAX(frs.created_at) as last_run_at,
      latest.base_url as last_base_url,
      latest.response_status_code as last_status_code,
      latest.response_time_ms as last_duration_ms
    FROM endpoints e
    LEFT JOIN flow_run_steps frs ON frs.endpoint_id = e.id AND frs.created_at > NOW() - INTERVAL '${days} days'
    LEFT JOIN LATERAL (
      SELECT frs2.response_status_code, frs2.response_time_ms, env.base_url
      FROM flow_run_steps frs2
      JOIN flow_runs fr2 ON fr2.id = frs2.flow_run_id
      JOIN environments env ON env.id = fr2.environment_id
      WHERE frs2.endpoint_id = e.id
      ORDER BY frs2.created_at DESC LIMIT 1
    ) latest ON true
    GROUP BY e.id, latest.base_url, latest.response_status_code, latest.response_time_ms
    ORDER BY e.id DESC
  `;

  const result = await pool.query(query);
  res.json(result.rows);
}));

// Endpoint detail: base config (method/path/headers/body) + the most recent hit,
// so the Dashboard can show base_url/headers/request/response on click.
router.get('/endpoints/:id/detail', catchAsync(async (req, res) => {
  const endpointResult = await pool.query('SELECT * FROM endpoints WHERE id=$1', [req.params.id]);
  const endpoint = endpointResult.rows[0];
  if (!endpoint) return res.status(404).json({ error: 'Endpoint not found' });

  const latestResult = await pool.query(
    `SELECT frs.*, e.base_url, e.name as environment_name, fr.flow_id, f.name as flow_name
     FROM flow_run_steps frs
     JOIN flow_runs fr ON fr.id = frs.flow_run_id
     JOIN environments e ON e.id = fr.environment_id
     JOIN flows f ON f.id = fr.flow_id
     WHERE frs.endpoint_id = $1
     ORDER BY frs.created_at DESC LIMIT 1`,
    [req.params.id]
  );

  res.json({ endpoint, latest_run: latestResult.rows[0] || null });
}));

// Response time trend for a specific endpoint (for line chart)
router.get('/endpoints/:id/trend', catchAsync(async (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const environment_id = req.query.environment_id;

  let query = `
    SELECT frs.created_at, frs.response_time_ms, frs.status, fr.environment_id
    FROM flow_run_steps frs
    JOIN flow_runs fr ON fr.id = frs.flow_run_id
    WHERE frs.endpoint_id = $1 AND frs.created_at > NOW() - INTERVAL '${days} days'
  `;
  const params = [req.params.id];
  if (environment_id) {
    params.push(environment_id);
    query += ` AND fr.environment_id = $${params.length}`;
  }
  query += ' ORDER BY frs.created_at ASC';

  const result = await pool.query(query, params);
  res.json(result.rows);
}));

// Environment comparison (STG vs PROD side by side) for a given endpoint
router.get('/endpoints/:id/env-comparison', catchAsync(async (req, res) => {
  const query = `
    SELECT
      env.name as environment, env.id as environment_id,
      COUNT(frs.id) as total_runs,
      ROUND(100.0 * COUNT(frs.id) FILTER (WHERE frs.status='PASS') / GREATEST(COUNT(frs.id),1), 1) as health_score,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY frs.response_time_ms) as p95_ms
    FROM environments env
    LEFT JOIN flow_runs fr ON fr.environment_id = env.id
    LEFT JOIN flow_run_steps frs ON frs.flow_run_id = fr.id AND frs.endpoint_id = $1
    GROUP BY env.id
    ORDER BY env.id
  `;
  const result = await pool.query(query, [req.params.id]);
  res.json(result.rows);
}));

// Every individual hit across all endpoints/flows (any status), for a "Recent
// Hits" activity feed — unlike endpoints-overview this is per-hit, not
// aggregated per endpoint, so the same endpoint can appear more than once.
// Optional since/until (ISO timestamps) filter the date range; capped at
// `limit` (default 300) since the FE renders this in a scrollable table.
router.get('/last-runs', catchAsync(async (req, res) => {
  const { since, until } = req.query;
  const limit = req.query.limit ? parseInt(req.query.limit) : 300;
  const params = [];
  let where = '';
  if (since) { params.push(since); where += ` AND frs.created_at >= $${params.length}`; }
  if (until) { params.push(until); where += ` AND frs.created_at <= $${params.length}`; }

  // Total count (ignoring `limit`) alongside the capped rows, so the FE can
  // tell the user "showing 300 of 512" instead of silently truncating.
  const countResult = await pool.query(
    `SELECT COUNT(*) FROM flow_run_steps frs WHERE 1=1 ${where}`,
    params
  );
  const total = parseInt(countResult.rows[0].count, 10);

  params.push(limit);
  const query = `
    SELECT frs.*, e.name as endpoint_name, f.name as flow_name, fr.flow_id, env.name as environment_name,
      env.base_url, env.id as environment_id, env.is_protected, fr.triggered_by
    FROM flow_run_steps frs
    JOIN flow_runs fr ON fr.id = frs.flow_run_id
    JOIN flows f ON f.id = fr.flow_id
    JOIN environments env ON env.id = fr.environment_id
    LEFT JOIN endpoints e ON e.id = frs.endpoint_id
    WHERE 1=1 ${where}
    ORDER BY frs.created_at DESC
    LIMIT $${params.length}
  `;
  const result = await pool.query(query, params);
  res.json({ rows: result.rows, total });
}));

// One row per Flow Run (not per step) for the "Recent Hits" activity feed —
// aggregates every step in a run into a single summary (overall status, step
// pass count, total duration), since a flow run reads better as one entry
// than as N separate endpoint rows. Alerts stays per-step (see below) since
// knowing exactly which step failed inside a run is the point there.
router.get('/last-flow-runs', catchAsync(async (req, res) => {
  const { since, until } = req.query;
  const limit = req.query.limit ? parseInt(req.query.limit) : 300;
  const params = [];
  let where = '';
  if (since) { params.push(since); where += ` AND fr.created_at >= $${params.length}`; }
  if (until) { params.push(until); where += ` AND fr.created_at <= $${params.length}`; }

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM flow_runs fr WHERE 1=1 ${where}`,
    params
  );
  const total = parseInt(countResult.rows[0].count, 10);

  params.push(limit);
  const query = `
    SELECT
      fr.id, fr.flow_id, fr.status, fr.triggered_by, fr.created_at,
      f.name as flow_name, env.name as environment_name, env.id as environment_id,
      env.is_protected, env.base_url,
      COUNT(frs.id) as step_count,
      COUNT(frs.id) FILTER (WHERE frs.status = 'PASS') as pass_count,
      SUM(frs.response_time_ms) as total_duration_ms,
      STRING_AGG(DISTINCT e.name, ', ') as endpoint_names
    FROM flow_runs fr
    JOIN flows f ON f.id = fr.flow_id
    JOIN environments env ON env.id = fr.environment_id
    LEFT JOIN flow_run_steps frs ON frs.flow_run_id = fr.id
    LEFT JOIN endpoints e ON e.id = frs.endpoint_id
    WHERE 1=1 ${where}
    GROUP BY fr.id, f.name, env.name, env.id, env.is_protected, env.base_url
    ORDER BY fr.created_at DESC
    LIMIT $${params.length}
  `;
  const result = await pool.query(query, params);
  res.json({ rows: result.rows, total });
}));

// Recent failures / drifts across all endpoints (for an "alerts" widget).
// Same optional since/until date-range filter as /last-runs.
router.get('/alerts', catchAsync(async (req, res) => {
  const { since, until } = req.query;
  const limit = req.query.limit ? parseInt(req.query.limit) : 300;
  const params = [];
  let where = `WHERE frs.status IN ('FAIL', 'ERROR', 'SCHEMA_DRIFT')`;
  if (since) { params.push(since); where += ` AND frs.created_at >= $${params.length}`; }
  if (until) { params.push(until); where += ` AND frs.created_at <= $${params.length}`; }

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM flow_run_steps frs ${where}`,
    params
  );
  const total = parseInt(countResult.rows[0].count, 10);

  params.push(limit);
  const query = `
    SELECT frs.*, f.name as flow_name, fr.flow_id, e.name as endpoint_name, env.name as environment_name,
      env.id as environment_id, env.is_protected, fr.triggered_by
    FROM flow_run_steps frs
    JOIN flow_runs fr ON fr.id = frs.flow_run_id
    JOIN flows f ON f.id = fr.flow_id
    JOIN environments env ON env.id = fr.environment_id
    LEFT JOIN endpoints e ON e.id = frs.endpoint_id
    ${where}
    ORDER BY frs.created_at DESC LIMIT $${params.length}
  `;
  const result = await pool.query(query, params);
  res.json({ rows: result.rows, total });
}));

// Daily hit-volume + outcome breakdown for the analytics chart, optionally
// scoped to the same since/until date range as /last-runs and /alerts.
// Zero-fills every day in the range (not just days with traffic) so the
// chart always spans the full requested period instead of looking sparse
// when only one or two days actually have hits.
router.get('/analytics', catchAsync(async (req, res) => {
  let sinceDate = req.query.since ? new Date(req.query.since) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const untilDate = req.query.until ? new Date(req.query.until) : new Date();
  const env = req.query.env || null;

  // Guard against generating an unreasonable number of series rows for a huge custom range.
  const MAX_DAYS = 366;
  const spanMs = untilDate.getTime() - sinceDate.getTime();
  if (spanMs > MAX_DAYS * 24 * 60 * 60 * 1000) {
    sinceDate = new Date(untilDate.getTime() - MAX_DAYS * 24 * 60 * 60 * 1000);
  }

  // The env filter lives in its own CTE (not a WHERE on the final query) so
  // it only decides which steps count — it must never suppress a day's
  // zero-fill row, or the chart goes sparse again for non-"all" filters.
  const query = `
    WITH days AS (
      SELECT generate_series(
        date_trunc('day', $1::timestamptz),
        date_trunc('day', $2::timestamptz),
        interval '1 day'
      ) as day
    ),
    filtered_steps AS (
      SELECT frs.*
      FROM flow_run_steps frs
      JOIN flow_runs fr ON fr.id = frs.flow_run_id
      JOIN environments env ON env.id = fr.environment_id
      WHERE ($3::text IS NULL OR env.name = $3)
    )
    SELECT
      d.day,
      COUNT(fs.id) as total,
      COUNT(fs.id) FILTER (WHERE fs.status = 'PASS') as pass_count,
      COUNT(fs.id) FILTER (WHERE fs.status = 'FAIL') as fail_count,
      COUNT(fs.id) FILTER (WHERE fs.status = 'ERROR') as error_count,
      COUNT(fs.id) FILTER (WHERE fs.status = 'SCHEMA_DRIFT') as drift_count,
      ROUND(AVG(fs.response_time_ms)) as avg_duration_ms
    FROM days d
    LEFT JOIN filtered_steps fs
      ON date_trunc('day', fs.created_at) = d.day
     AND fs.created_at >= $1::timestamptz AND fs.created_at <= $2::timestamptz
    GROUP BY d.day
    ORDER BY d.day ASC
  `;
  const result = await pool.query(query, [sinceDate.toISOString(), untilDate.toISOString(), env]);
  res.json(result.rows);
}));

module.exports = router;
