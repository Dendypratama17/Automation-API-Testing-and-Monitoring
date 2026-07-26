const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const catchAsync = require('../utils/catchAsync');

// GET single flow run with all its step results
router.get('/:id', catchAsync(async (req, res) => {
  const runResult = await pool.query(
    `SELECT fr.*, f.name as flow_name, e.name as environment_name
     FROM flow_runs fr
     JOIN flows f ON f.id = fr.flow_id
     JOIN environments e ON e.id = fr.environment_id
     WHERE fr.id=$1`,
    [req.params.id]
  );
  const flowRun = runResult.rows[0];
  if (!flowRun) return res.status(404).json({ error: 'Not found' });

  const stepsResult = await pool.query(
    'SELECT * FROM flow_run_steps WHERE flow_run_id=$1 ORDER BY step_order',
    [req.params.id]
  );
  res.json({ ...flowRun, steps: stepsResult.rows });
}));

module.exports = router;
