const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const catchAsync = require('../utils/catchAsync');

// Keys with a known default, used whenever the `settings` table has no row
// for that key yet (e.g. a fresh install, or before anyone's touched it) —
// so absence means "default", not "off"/unset/undefined.
const DEFAULTS = {
  telegram_notifications_enabled: true,
};

// GET all settings, merged with defaults for any key not yet in the table.
router.get('/', catchAsync(async (req, res) => {
  const result = await pool.query('SELECT key, value FROM settings');
  const settings = { ...DEFAULTS };
  for (const row of result.rows) settings[row.key] = row.value;
  res.json(settings);
}));

// UPSERT one setting by key.
router.put('/:key', catchAsync(async (req, res) => {
  const { value } = req.body;
  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
    [req.params.key, JSON.stringify(value)]
  );
  res.json({ [req.params.key]: value });
}));

module.exports = router;
