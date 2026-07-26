const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const catchAsync = require('../utils/catchAsync');

// List excludes the actual `data` blob (only its byte length) — this is only
// used to render the library picker, which just needs name/filename/type,
// not the full base64 payload.
router.get('/', catchAsync(async (req, res) => {
  const result = await pool.query(
    `SELECT id, name, file_name, mime_type, created_at,
      (length(data) * 3 / 4) as approx_bytes
     FROM test_files ORDER BY sort_order ASC, id ASC`
  );
  res.json(result.rows);
}));

// REORDER: persist drag-and-drop order from Config > Test Files — `ids` is
// the full list of test file ids in their new display order.
router.put('/reorder', catchAsync(async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids must be a non-empty array' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < ids.length; i++) {
      await client.query('UPDATE test_files SET sort_order=$1 WHERE id=$2', [i, ids[i]]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  const result = await pool.query(
    `SELECT id, name, file_name, mime_type, created_at, (length(data) * 3 / 4) as approx_bytes
     FROM test_files ORDER BY sort_order ASC, id ASC`
  );
  res.json(result.rows);
}));

// Full record (including `data`) — fetched only when a file is actually
// picked from the library for a step's form-data field.
router.get('/:id', catchAsync(async (req, res) => {
  const result = await pool.query('SELECT * FROM test_files WHERE id=$1', [req.params.id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(result.rows[0]);
}));

router.post('/', catchAsync(async (req, res) => {
  const { name, file_name, mime_type, data } = req.body;
  if (!name?.trim() || !file_name?.trim() || !data) {
    return res.status(400).json({ error: 'name, file_name and data are required' });
  }
  const result = await pool.query(
    'INSERT INTO test_files (name, file_name, mime_type, data) VALUES ($1,$2,$3,$4) RETURNING id, name, file_name, mime_type, created_at',
    [name.trim(), file_name.trim(), mime_type || 'application/octet-stream', data]
  );
  res.status(201).json(result.rows[0]);
}));

// RENAME: only file_name is shown/used anywhere (picker dropdown, saved step
// data), so keep `name` in sync with it rather than maintaining two labels.
router.put('/:id', catchAsync(async (req, res) => {
  const { file_name } = req.body;
  if (!file_name?.trim()) return res.status(400).json({ error: 'file_name is required' });
  const result = await pool.query(
    'UPDATE test_files SET name=$1, file_name=$1 WHERE id=$2 RETURNING id, name, file_name, mime_type, created_at',
    [file_name.trim(), req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(result.rows[0]);
}));

router.delete('/:id', catchAsync(async (req, res) => {
  await pool.query('DELETE FROM test_files WHERE id=$1', [req.params.id]);
  res.status(204).send();
}));

module.exports = router;
