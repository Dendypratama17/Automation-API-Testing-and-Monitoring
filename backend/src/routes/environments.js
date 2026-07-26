const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const catchAsync = require('../utils/catchAsync');

// GET all environments
router.get('/', catchAsync(async (req, res) => {
  const result = await pool.query('SELECT * FROM environments ORDER BY sort_order, id');
  res.json(result.rows);
}));

// REORDER: persist the drag-and-drop order from Config > Environments —
// `ids` is the full list of environment ids in their new display order.
router.put('/reorder', catchAsync(async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids must be a non-empty array' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < ids.length; i++) {
      await client.query('UPDATE environments SET sort_order=$1 WHERE id=$2', [i, ids[i]]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  const result = await pool.query('SELECT * FROM environments ORDER BY sort_order, id');
  res.json(result.rows);
}));

// CREATE environment
router.post('/', catchAsync(async (req, res) => {
  const { name, base_url, variables = {}, is_protected = false } = req.body;
  const result = await pool.query(
    `INSERT INTO environments (name, base_url, variables, is_protected) VALUES ($1,$2,$3::jsonb,$4) RETURNING *`,
    [name, base_url, JSON.stringify(variables), is_protected]
  );
  res.status(201).json(result.rows[0]);
}));

// UPDATE environment
router.put('/:id', catchAsync(async (req, res) => {
  const { name, base_url, variables, is_protected } = req.body;
  const result = await pool.query(
    `UPDATE environments SET name=$1, base_url=$2, variables=$3::jsonb, is_protected=$4, updated_at=NOW() WHERE id=$5 RETURNING *`,
    [name, base_url, JSON.stringify(variables), is_protected, req.params.id]
  );
  res.json(result.rows[0]);
}));

// DELETE environment
router.delete('/:id', catchAsync(async (req, res) => {
  await pool.query('DELETE FROM environments WHERE id=$1', [req.params.id]);
  res.status(204).send();
}));

// IMPORT from Postman Environment JSON format
router.post('/import/postman', catchAsync(async (req, res) => {
  const { name: envName, values = [] } = req.body; // postman_environment.json shape
  const variables = {};
  let baseUrl = '';

  for (const v of values) {
    if (v.key === 'base_url' || v.key === 'baseUrl') baseUrl = v.value;
    else variables[v.key] = v.value;
  }

  const result = await pool.query(
    `INSERT INTO environments (name, base_url, variables, is_protected) VALUES ($1,$2,$3::jsonb,$4) RETURNING *`,
    [envName || 'Imported Environment', baseUrl, JSON.stringify(variables), false]
  );
  res.status(201).json(result.rows[0]);
}));

// IMPORT from .env text format
router.post('/import/dotenv', catchAsync(async (req, res) => {
  const { name: envName, content } = req.body; // raw .env file text
  const variables = {};
  let baseUrl = '';

  content.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const idx = trimmed.indexOf('=');
    if (idx === -1) return;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (key.toLowerCase() === 'base_url') baseUrl = value;
    else variables[key] = value;
  });

  const result = await pool.query(
    `INSERT INTO environments (name, base_url, variables, is_protected) VALUES ($1,$2,$3::jsonb,$4) RETURNING *`,
    [envName || 'Imported Environment', baseUrl, JSON.stringify(variables), false]
  );
  res.status(201).json(result.rows[0]);
}));

module.exports = router;
