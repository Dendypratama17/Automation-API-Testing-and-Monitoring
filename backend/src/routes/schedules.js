const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const catchAsync = require('../utils/catchAsync');
const { refreshSchedule, stopSchedule } = require('../services/scheduler');

// Matches a flow_run to a specific schedule: precisely via schedule_id for
// runs recorded after that column existed, falling back to a flow+environment
// +time-window match (the run happened while this schedule was active) for
// older runs recorded before schedule_id was tracked. Without this, two
// schedules pointed at the same flow+environment would share run counts.
const SCHEDULE_RUN_MATCH = `
  (
    fr.schedule_id = s.id
    OR (
      fr.schedule_id IS NULL AND fr.triggered_by = 'scheduler'
      AND fr.flow_id = s.flow_id AND fr.environment_id = s.environment_id
      AND fr.created_at >= s.created_at AND fr.created_at <= COALESCE(s.deleted_at, NOW())
    )
  )
`;

// GET all schedules, with a per-row run-outcome summary (pass/fail/error/drift
// counts scoped to this specific schedule) so the list itself shows health at
// a glance, without a separate request per row.
router.get('/', catchAsync(async (req, res) => {
  const result = await pool.query(`
    SELECT
      s.*, e.name as environment_name, e.is_protected, f.name as flow_name,
      COALESCE(stats.total_runs, 0) as total_runs,
      COALESCE(stats.pass_count, 0) as pass_count,
      COALESCE(stats.fail_count, 0) as fail_count,
      COALESCE(stats.error_count, 0) as error_count,
      COALESCE(stats.drift_count, 0) as drift_count
    FROM schedules s
    JOIN environments e ON e.id = s.environment_id
    JOIN flows f ON f.id = s.flow_id
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) as total_runs,
        COUNT(*) FILTER (WHERE status = 'PASS') as pass_count,
        COUNT(*) FILTER (WHERE status = 'FAIL') as fail_count,
        COUNT(*) FILTER (WHERE status = 'ERROR') as error_count,
        COUNT(*) FILTER (WHERE status = 'SCHEMA_DRIFT') as drift_count
      FROM flow_runs fr
      WHERE ${SCHEDULE_RUN_MATCH}
    ) stats ON true
    ORDER BY s.id DESC
  `);
  res.json(result.rows);
}));

// Run history/stats for this specific schedule — shown before deleting a
// schedule so the user knows what they're giving up.
router.get('/:id/history', catchAsync(async (req, res) => {
  const scheduleResult = await pool.query('SELECT * FROM schedules WHERE id=$1', [req.params.id]);
  const schedule = scheduleResult.rows[0];
  if (!schedule) return res.status(404).json({ error: 'Schedule not found' });

  const statsResult = await pool.query(
    `SELECT
       COUNT(*) as total_runs,
       COUNT(*) FILTER (WHERE fr.status = 'PASS') as pass_count,
       COUNT(*) FILTER (WHERE fr.status = 'FAIL') as fail_count,
       COUNT(*) FILTER (WHERE fr.status = 'ERROR') as error_count,
       COUNT(*) FILTER (WHERE fr.status = 'SCHEMA_DRIFT') as drift_count,
       MIN(fr.created_at) as first_run_at,
       MAX(fr.created_at) as last_run_at
     FROM flow_runs fr, schedules s
     WHERE s.id = $1 AND ${SCHEDULE_RUN_MATCH}`,
    [req.params.id]
  );
  res.json(statsResult.rows[0]);
}));

// Individual past Flow Runs for this specific schedule (most recent first) —
// one row per run (not per step), same shape as the Dashboard's Recent Hits,
// so a schedule that ran an 11-step flow shows as ONE entry instead of 11.
// Full step-by-step detail for a given run is fetched separately via
// GET /flow-runs/:id when a row is expanded.
router.get('/:id/runs', catchAsync(async (req, res) => {
  const limit = req.query.limit ? parseInt(req.query.limit) : 20;
  const scheduleResult = await pool.query('SELECT * FROM schedules WHERE id=$1', [req.params.id]);
  const schedule = scheduleResult.rows[0];
  if (!schedule) return res.status(404).json({ error: 'Schedule not found' });

  const runsResult = await pool.query(
    `SELECT
       fr.id, fr.status, fr.created_at, fr.triggered_by,
       COUNT(frs.id) as step_count,
       COUNT(frs.id) FILTER (WHERE frs.status = 'PASS') as pass_count,
       SUM(frs.response_time_ms) as total_duration_ms
     FROM flow_runs fr
     JOIN schedules s ON s.id = $1
     LEFT JOIN flow_run_steps frs ON frs.flow_run_id = fr.id
     WHERE ${SCHEDULE_RUN_MATCH}
     GROUP BY fr.id
     ORDER BY fr.created_at DESC
     LIMIT $2`,
    [req.params.id, limit]
  );
  res.json(runsResult.rows);
}));

// CREATE schedule — optional `duration_minutes` means "run for N minutes then
// auto-stop"; a watchdog in scheduler.js checks auto_stop_at and stops the
// schedule once it's reached. Omitted/falsy means it runs indefinitely.
router.post('/', catchAsync(async (req, res) => {
  const { name, cron_expression, flow_id, environment_id, is_active = true, duration_minutes } = req.body;
  const result = await pool.query(
    `INSERT INTO schedules (name, cron_expression, flow_id, environment_id, is_active, auto_stop_at)
     VALUES ($1,$2,$3,$4,$5, CASE WHEN $6::int IS NOT NULL THEN NOW() + make_interval(mins => $6::int) END) RETURNING *`,
    [name, cron_expression, flow_id, environment_id, is_active, duration_minutes || null]
  );
  refreshSchedule(result.rows[0]);
  res.status(201).json(result.rows[0]);
}));

// UPDATE schedule
router.put('/:id', catchAsync(async (req, res) => {
  const { name, cron_expression, flow_id, environment_id, is_active } = req.body;
  const result = await pool.query(
    `UPDATE schedules SET name=$1, cron_expression=$2, flow_id=$3, environment_id=$4, is_active=$5, updated_at=NOW()
     WHERE id=$6 RETURNING *`,
    [name, cron_expression, flow_id, environment_id, is_active, req.params.id]
  );
  refreshSchedule(result.rows[0]);
  res.json(result.rows[0]);
}));

// Soft-delete: unregisters the cron job but keeps the row (and its past run
// history) visible in the list, marked as deleted, instead of erasing it.
router.delete('/:id', catchAsync(async (req, res) => {
  stopSchedule(Number(req.params.id));
  await pool.query('UPDATE schedules SET is_active = false, deleted_at = NOW() WHERE id=$1', [req.params.id]);
  res.status(204).send();
}));

// Hard-delete: only for a schedule that's already stopped (deleted_at set) —
// actually removes the row so the list doesn't accumulate dead entries
// forever. Its past flow_runs aren't touched (schedule_id isn't a foreign
// key), so run history still shows in the Dashboard even after this.
router.delete('/:id/permanent', catchAsync(async (req, res) => {
  const result = await pool.query('SELECT deleted_at FROM schedules WHERE id=$1', [req.params.id]);
  const schedule = result.rows[0];
  if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
  if (!schedule.deleted_at) return res.status(400).json({ error: 'Stop the schedule before deleting it permanently.' });

  await pool.query('DELETE FROM schedules WHERE id=$1', [req.params.id]);
  res.status(204).send();
}));

module.exports = router;
