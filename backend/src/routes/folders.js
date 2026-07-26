const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const catchAsync = require('../utils/catchAsync');

// GET folders, filtered by kind ('endpoint' | 'flow') — flat list, FE builds the tree/nesting
router.get('/', catchAsync(async (req, res) => {
  const { kind } = req.query;
  if (!kind) return res.status(400).json({ error: 'kind query param is required (endpoint|flow)' });
  const result = await pool.query('SELECT * FROM folders WHERE kind=$1 ORDER BY name', [kind]);
  res.json(result.rows);
}));

// CREATE folder
router.post('/', catchAsync(async (req, res) => {
  const { kind, name, parent_id = null } = req.body;
  if (!kind) return res.status(400).json({ error: 'kind is required (endpoint|flow)' });
  const result = await pool.query(
    'INSERT INTO folders (kind, name, parent_id) VALUES ($1,$2,$3) RETURNING *',
    [kind, name, parent_id]
  );
  res.status(201).json(result.rows[0]);
}));

// RENAME / MOVE folder
router.put('/:id', catchAsync(async (req, res) => {
  const { name, parent_id } = req.body;
  const result = await pool.query(
    'UPDATE folders SET name=$1, parent_id=$2, updated_at=NOW() WHERE id=$3 RETURNING *',
    [name, parent_id ?? null, req.params.id]
  );
  res.json(result.rows[0]);
}));

// DELETE folder (children folders cascade; endpoints/flows inside become uncategorized)
router.delete('/:id', catchAsync(async (req, res) => {
  await pool.query('DELETE FROM folders WHERE id=$1', [req.params.id]);
  res.status(204).send();
}));

module.exports = router;
