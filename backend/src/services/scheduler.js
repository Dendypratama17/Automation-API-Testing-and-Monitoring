const cron = require('node-cron');
const pool = require('../db/pool');
const { runFlowAndPersist } = require('./flowRunner');

// Keep track of active cron tasks so they can be stopped/restarted on update
const activeTasks = new Map(); // schedule_id -> cron task

async function executeSchedule(schedule) {
  console.log(`[scheduler] Running schedule "${schedule.name}" (id=${schedule.id})`);
  try {
    const flowResult = await pool.query('SELECT * FROM flows WHERE id=$1', [schedule.flow_id]);
    const flow = flowResult.rows[0];
    if (!flow) throw new Error(`Flow ${schedule.flow_id} not found`);

    const stepsResult = await pool.query('SELECT * FROM flow_steps WHERE flow_id=$1 ORDER BY step_order', [flow.id]);
    const envResult = await pool.query('SELECT * FROM environments WHERE id=$1', [schedule.environment_id]);
    const environment = envResult.rows[0];
    if (!environment) throw new Error(`Environment ${schedule.environment_id} not found`);

    await runFlowAndPersist(flow, stepsResult.rows, environment, 'scheduler', schedule.id);
    await pool.query('UPDATE schedules SET last_run_at = NOW() WHERE id = $1', [schedule.id]);
  } catch (err) {
    console.error(`[scheduler] Schedule "${schedule.name}" failed:`, err.message);
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

module.exports = { initScheduler, refreshSchedule, stopSchedule };
