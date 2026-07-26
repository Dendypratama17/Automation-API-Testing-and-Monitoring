const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const catchAsync = require('../utils/catchAsync');
const { encrypt, decrypt } = require('../utils/crypto');
const { fetchWebLoginToken, primeTokenCache } = require('../services/webLogin');

// Password never leaves the server in any API response — the UI only ever
// needs to know one exists (to render the masked dots), never its value.
function withoutPassword(row) {
  const { password, ...rest } = row;
  return { ...rest, has_password: !!password };
}

// LIST saved Basic Auth credentials
router.get('/', catchAsync(async (req, res) => {
  const result = await pool.query(
    `SELECT ac.*, env.name as environment_name
     FROM auth_credentials ac
     LEFT JOIN environments env ON env.id = ac.environment_id
     ORDER BY ac.sort_order ASC, ac.id ASC`
  );
  res.json(result.rows.map(withoutPassword));
}));

// REORDER: persist drag-and-drop order from Config > Authorization — `ids`
// is the full list of credential ids in their new display order.
router.put('/reorder', catchAsync(async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids must be a non-empty array' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < ids.length; i++) {
      await client.query('UPDATE auth_credentials SET sort_order=$1 WHERE id=$2', [i, ids[i]]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  const result = await pool.query(
    `SELECT ac.*, env.name as environment_name
     FROM auth_credentials ac
     LEFT JOIN environments env ON env.id = ac.environment_id
     ORDER BY ac.sort_order ASC, ac.id ASC`
  );
  res.json(result.rows.map(withoutPassword));
}));

// CREATE credential
router.post('/', catchAsync(async (req, res) => {
  const { name, type = 'basic', username, password, login_url, environment_id } = req.body;
  const result = await pool.query(
    'INSERT INTO auth_credentials (name, type, username, password, login_url, environment_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [name, type, username, encrypt(password), type === 'web_login' ? login_url : null, environment_id || null]
  );
  res.status(201).json(withoutPassword(result.rows[0]));
}));

// UPDATE credential — an empty/omitted `password` means "keep the current
// one" (the edit form never gets it back to prefill, so there's nothing to
// resubmit unless the user is deliberately changing it).
router.put('/:id', catchAsync(async (req, res) => {
  const { name, type = 'basic', username, password, login_url, environment_id } = req.body;
  const existing = await pool.query('SELECT password FROM auth_credentials WHERE id=$1', [req.params.id]);
  if (!existing.rows[0]) return res.status(404).json({ error: 'Credential not found' });
  const encryptedPassword = password ? encrypt(password) : existing.rows[0].password;

  const result = await pool.query(
    'UPDATE auth_credentials SET name=$1, type=$2, username=$3, password=$4, login_url=$5, environment_id=$6, updated_at=NOW() WHERE id=$7 RETURNING *',
    [name, type, username, encryptedPassword, type === 'web_login' ? login_url : null, environment_id || null, req.params.id]
  );
  res.json(withoutPassword(result.rows[0]));
}));

// DELETE credential (flow steps using it just fall back to no auth, via ON DELETE SET NULL)
router.delete('/:id', catchAsync(async (req, res) => {
  await pool.query('DELETE FROM auth_credentials WHERE id=$1', [req.params.id]);
  res.status(204).send();
}));

// TEST a Web Login credential right now — drives the real login page and
// reports whether a token was actually retrieved, without needing to run a
// whole flow just to find out the PrivyID/password (or the page layout) broke.
router.post('/:id/test-login', catchAsync(async (req, res) => {
  const result = await pool.query('SELECT * FROM auth_credentials WHERE id=$1', [req.params.id]);
  const cred = result.rows[0];
  if (!cred) return res.status(404).json({ error: 'Credential not found' });
  if (cred.type !== 'web_login') return res.status(400).json({ error: 'Only Web Login credentials can be tested this way.' });

  const { token, expires } = await fetchWebLoginToken({ ...cred, password: decrypt(cred.password) });
  // A manual test is always a real, uncached login — but prime the cache
  // with its result so the next actual flow run doesn't pay for a second one.
  primeTokenCache(cred.id, token, expires);
  res.json({ ok: true, token_preview: `${token.slice(0, 24)}...`, expires });
}));

module.exports = router;
