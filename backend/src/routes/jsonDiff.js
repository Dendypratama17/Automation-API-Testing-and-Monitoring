const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const catchAsync = require('../utils/catchAsync');
const { diffValues } = require('../services/jsonDiff');

// Standalone JSON Diff tool — paste any two JSON payloads and compare them,
// independent of any saved Endpoint (see routes/endpoints.js's per-endpoint
// /:id/diff for the reference-response version of this same idea).

// Stateless — never writes to the DB on its own. Only a "Save" click (below)
// persists anything.
router.post('/compute', catchAsync(async (req, res) => {
  const { json_a, json_b, ignore_paths = [] } = req.body;
  if (json_a === undefined || json_b === undefined) {
    return res.status(400).json({ error: 'json_a and json_b are required' });
  }
  const diffs = diffValues(json_a, json_b, ignore_paths);
  res.json({ diffs });
}));

router.post('/save', catchAsync(async (req, res) => {
  const { name = null, json_a, json_b, ignore_paths = [], diffs } = req.body;
  if (json_a === undefined || json_b === undefined || !Array.isArray(diffs)) {
    return res.status(400).json({ error: 'json_a, json_b, and diffs are required' });
  }
  const result = await pool.query(
    `INSERT INTO saved_json_diffs (name, json_a, json_b, ignore_paths, diffs)
     VALUES ($1,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb) RETURNING *`,
    [name, JSON.stringify(json_a), JSON.stringify(json_b), JSON.stringify(ignore_paths), JSON.stringify(diffs)]
  );
  res.status(201).json(result.rows[0]);
}));

// Excludes json_a/json_b (can be large) from the list view — the diff count
// plus name/date is enough to pick which saved comparison to open.
router.get('/', catchAsync(async (req, res) => {
  const result = await pool.query(
    'SELECT id, name, ignore_paths, diffs, created_at FROM saved_json_diffs ORDER BY created_at ASC'
  );
  res.json(result.rows);
}));

router.get('/:id', catchAsync(async (req, res) => {
  const result = await pool.query('SELECT * FROM saved_json_diffs WHERE id=$1', [req.params.id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Saved diff not found' });
  res.json(result.rows[0]);
}));

router.put('/:id/rename', catchAsync(async (req, res) => {
  const { name } = req.body;
  const result = await pool.query(
    'UPDATE saved_json_diffs SET name=$1 WHERE id=$2 RETURNING id, name, ignore_paths, diffs, created_at',
    [name?.trim() || null, req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Saved diff not found' });
  res.json(result.rows[0]);
}));

router.delete('/:id', catchAsync(async (req, res) => {
  await pool.query('DELETE FROM saved_json_diffs WHERE id=$1', [req.params.id]);
  res.status(204).send();
}));

module.exports = router;
