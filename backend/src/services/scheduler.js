const cron = require('node-cron');
const pool = require('../db/pool');
const { runFlowAndPersist } = require('./flowRunner');

// Keep track of active cron tasks so they can be stopped/restarted on update
const activeTasks = new Map(); // schedule_id -> cron task

// A flow_runs row only gets INSERTed once executeFlow finishes — there's no
// "in progress" row to poll from the DB while a scheduled run is mid-flight.
// Track it here instead so the UI can show a live "Running..." state; purely
// in-memory, so it resets (harmlessly) on server restart.
const runningScheduleIds = new Set();
function isScheduleRunning(scheduleId) {
  return runningScheduleIds.has(scheduleId);
}

async function executeSchedule(schedule) {
  console.log(`[scheduler] Running schedule "${schedule.name}" (id=${schedule.id})`);
  runningScheduleIds.add(schedule.id);
  try {
    const flowResult = await pool.query('SELECT * FROM flows WHERE id=$1', [schedule.flow_id]);
    const flow = flowResult.rows[0];
    if (!flow) throw new Error(`Flow ${schedule.flow_id} not found`);

    const stepsResult = await pool.query('SELECT * FROM flow_steps WHERE flow_id=$1 ORDER BY step_order', [flow.id]);
    const stepsToRun = stepsResult.rows.filter((s) => s.enabled !== false);
    const envResult = await pool.query('SELECT * FROM environments WHERE id=$1', [schedule.environment_id]);
    const environment = envResult.rows[0];
    if (!environment) throw new Error(`Environment ${schedule.environment_id} not found`);
    if (stepsToRun.length === 0) throw new Error(`Flow ${flow.id} has no enabled steps`);

    await runFlowAndPersist(flow, stepsToRun, environment, 'scheduler', schedule.id);
    await pool.query('UPDATE schedules SET last_run_at = NOW() WHERE id = $1', [schedule.id]);
  } catch (err) {
    console.error(`[scheduler] Schedule "${schedule.name}" failed:`, err.message);
  } finally {
    runningScheduleIds.delete(schedule.id);
  }
}

function scheduleTask(schedule) {
  if (activeTasks.has(schedule.id)) {
    activeTasks.get(schedule.id).stop();
    activeTasks.delete(schedule.id);
  }
  if (!schedule.is_active) return;

  if (!cron.validate(schedule.cron_expression)) {
    console.error(`[scheduler] Invalid cron expression for schedule ${schedule.id}: ${schedule.cron_expression}`);
    return;
  }

  const task = cron.schedule(schedule.cron_expression, () => executeSchedule(schedule));
  activeTasks.set(schedule.id, task);
  console.log(`[scheduler] Registered "${schedule.name}" with cron "${schedule.cron_expression}"`);
}

// Schedules created with a "run for N minutes" duration carry an
// auto_stop_at cutoff — node-cron itself has no concept of "run until a
// point in time", so a separate watchdog checks for expired ones and stops
// them the same way the manual Stop action does. Runs independently of each
// schedule's own cron interval so a long interval (e.g. hourly) with a short
// duration (e.g. 5 minutes) still stops on time instead of waiting for its
// next tick.
const AUTO_STOP_CHECK_INTERVAL_MS = 15000;

async function checkAutoStops() {
  const result = await pool.query(
    `SELECT id, name FROM schedules WHERE is_active = TRUE AND auto_stop_at IS NOT NULL AND auto_stop_at <= NOW()`
  );
  for (const schedule of result.rows) {
    console.log(`[scheduler] Schedule "${schedule.name}" (id=${schedule.id}) reached its auto-stop time.`);
    await pool.query('UPDATE schedules SET is_active = false, deleted_at = NOW() WHERE id=$1', [schedule.id]);
    stopSchedule(schedule.id);
  }
}

/**
 * Load all active schedules from DB and register cron tasks.
 * Call once at server startup.
 */
async function initScheduler() {
  const result = await pool.query('SELECT * FROM schedules WHERE is_active = TRUE');
  for (const schedule of result.rows) {
    scheduleTask(schedule);
  }
  console.log(`[scheduler] Initialized with ${result.rows.length} active schedule(s)`);
  setInterval(() => { checkAutoStops().catch((err) => console.error('[scheduler] auto-stop check failed:', err.message)); }, AUTO_STOP_CHECK_INTERVAL_MS);
}

/**
 * Re-register a single schedule (used after create/update/delete via API).
 */
function refreshSchedule(schedule) {
  scheduleTask(schedule);
}

function stopSchedule(scheduleId) {
  if (activeTasks.has(scheduleId)) {
    activeTasks.get(scheduleId).stop();
    activeTasks.delete(scheduleId);
  }
}

module.exports = { initScheduler, refreshSchedule, stopSchedule, isScheduleRunning };
