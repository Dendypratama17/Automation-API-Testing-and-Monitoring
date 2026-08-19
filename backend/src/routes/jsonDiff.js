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
  const { name = null, json_a, json_b, ignore_paths = [], diffs, folder_id = null } = req.body;
  if (json_a === undefined || json_b === undefined || !Array.isArray(diffs)) {
    return res.status(400).json({ error: 'json_a, json_b, and diffs are required' });
  }
  const result = await pool.query(
    `INSERT INTO saved_json_diffs (name, json_a, json_b, ignore_paths, diffs, folder_id)
     VALUES ($1,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb,$6) RETURNING *`,
    [name, JSON.stringify(json_a), JSON.stringify(json_b), JSON.stringify(ignore_paths), JSON.stringify(diffs), folder_id]
  );
  res.status(201).json(result.rows[0]);
}));

// Excludes json_a/json_b (can be large) from the list view — the diff count
// plus name/date is enough to pick which saved comparison to open. Optional
// folder_id filter — 'null' (string) means "no folder", matching the
// endpoints/flows list convention.
router.get('/', catchAsync(async (req, res) => {
  const { folder_id } = req.query;
  const params = [];
  let where = '';
  if (folder_id === 'null') {
    where = 'WHERE folder_id IS NULL';
  } else if (folder_id) {
    params.push(folder_id);
    where = 'WHERE folder_id = $1';
  }
  const result = await pool.query(
    `SELECT id, name, ignore_paths, diffs, folder_id, created_at FROM saved_json_diffs ${where} ORDER BY created_at ASC`,
    params
  );
  res.json(result.rows);
}));

router.get('/:id', catchAsync(async (req, res) => {
  const result = await pool.query('SELECT * FROM saved_json_diffs WHERE id=$1', [req.params.id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Saved diff not found' });
  res.json(result.rows[0]);
}));

// Overwrites an already-saved comparison's content (json_a/json_b/diffs) —
// used when the user re-opens a saved comparison, edits the JSON, and wants
// to update that same record rather than creating a separate new one (see
// saveJsonDiff/POST /save for the "always creates a new row" case).
router.put('/:id', catchAsync(async (req, res) => {
  const { name, json_a, json_b, ignore_paths = [], diffs } = req.body;
  if (json_a === undefined || json_b === undefined || !Array.isArray(diffs)) {
    return res.status(400).json({ error: 'json_a, json_b, and diffs are required' });
  }
  const existing = await pool.query('SELECT name FROM saved_json_diffs WHERE id=$1', [req.params.id]);
  if (!existing.rows[0]) return res.status(404).json({ error: 'Saved diff not found' });
  // name is optional in the request body (undefined) — keep the current one
  // in that case, rather than treating "not sent" the same as "clear it".
  const nextName = name === undefined ? existing.rows[0].name : name;
  const result = await pool.query(
    `UPDATE saved_json_diffs SET name=$1, json_a=$2::jsonb, json_b=$3::jsonb, ignore_paths=$4::jsonb, diffs=$5::jsonb WHERE id=$6 RETURNING *`,
    [nextName, JSON.stringify(json_a), JSON.stringify(json_b), JSON.stringify(ignore_paths), JSON.stringify(diffs), req.params.id]
  );
  res.json(result.rows[0]);
}));

// Lightweight metadata update — name and/or folder_id, without touching the
// (potentially large) json_a/json_b content. Each field is independently
// optional: omitting one keeps its current value, so "just move to a
// folder" and "just rename" can both call this without clobbering the
// other field.
router.put('/:id/rename', catchAsync(async (req, res) => {
  const { name, folder_id } = req.body;
  const existing = await pool.query('SELECT name, folder_id FROM saved_json_diffs WHERE id=$1', [req.params.id]);
  if (!existing.rows[0]) return res.status(404).json({ error: 'Saved diff not found' });
  const nextName = name === undefined ? existing.rows[0].name : (name?.trim() || null);
  const nextFolderId = folder_id === undefined ? existing.rows[0].folder_id : folder_id;
  const result = await pool.query(
    'UPDATE saved_json_diffs SET name=$1, folder_id=$2 WHERE id=$3 RETURNING id, name, ignore_paths, diffs, folder_id, created_at',
    [nextName, nextFolderId, req.params.id]
  );
  res.json(result.rows[0]);
}));

router.delete('/:id', catchAsync(async (req, res) => {
  await pool.query('DELETE FROM saved_json_diffs WHERE id=$1', [req.params.id]);
  res.status(204).send();
}));

module.exports = router;
