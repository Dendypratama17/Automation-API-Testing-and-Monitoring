const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const catchAsync = require('../utils/catchAsync');
const { syncDefaultHeadersToEndpoints } = require('../services/defaultHeaders');

// Drag-to-reorder in Config > Default Headers controls this ordering — rows
// sharing a key sit together by convention (dragging keeps them grouped in
// practice), and within a key, whichever sorts first is the auto-fill default.
router.get('/', catchAsync(async (req, res) => {
  const result = await pool.query('SELECT * FROM default_headers ORDER BY sort_order ASC, id ASC');
  res.json(result.rows);
}));

// REORDER: persist drag-and-drop order from Config > Default Headers — `ids`
// is the full list of row ids in their new display order. Also changes which
// value is "default" for a key, since that's just whichever sorts first.
router.put('/reorder', catchAsync(async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids must be a non-empty array' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < ids.length; i++) {
      await client.query('UPDATE default_headers SET sort_order=$1 WHERE id=$2', [i, ids[i]]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await syncDefaultHeadersToEndpoints();
  const result = await pool.query('SELECT * FROM default_headers ORDER BY sort_order ASC, id ASC');
  res.json(result.rows);
}));

// Adding a default immediately backfills it onto every endpoint missing that
// key — placed at the end of the order (lowest priority as a "default").
router.post('/', catchAsync(async (req, res) => {
  const { key, value } = req.body;
  if (!key?.trim() || !value?.trim()) return res.status(400).json({ error: 'key and value are required' });

  const maxOrderResult = await pool.query('SELECT COALESCE(MAX(sort_order), 0) + 1 as next FROM default_headers');
  const result = await pool.query(
    'INSERT INTO default_headers (key, value, sort_order) VALUES ($1,$2,$3) RETURNING *',
    [key.trim(), value.trim(), maxOrderResult.rows[0].next]
  );
  await syncDefaultHeadersToEndpoints();
  res.status(201).json(result.rows[0]);
}));

router.put('/:id', catchAsync(async (req, res) => {
  const { key, value } = req.body;
  if (!key?.trim() || !value?.trim()) return res.status(400).json({ error: 'key and value are required' });

  const result = await pool.query(
    'UPDATE default_headers SET key=$1, value=$2 WHERE id=$3 RETURNING *',
    [key.trim(), value.trim(), req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
  await syncDefaultHeadersToEndpoints();
  res.json(result.rows[0]);
}));

// Only removes the template row — endpoints that already inherited this
// header keep it, since there's no reliable way to tell a default-inherited
// value apart from one the endpoint owner set on purpose afterwards.
router.delete('/:id', catchAsync(async (req, res) => {
  await pool.query('DELETE FROM default_headers WHERE id=$1', [req.params.id]);
  res.status(204).send();
}));

module.exports = router;
