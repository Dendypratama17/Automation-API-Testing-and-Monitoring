const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const catchAsync = require('../utils/catchAsync');
const { parseCurl, toPathTemplate } = require('../services/curlParser');
const { parseCollection } = require('../services/postmanParser');
const { generateSchema } = require('../services/schemaTool');
const { getDefaultHeaders, mergeHeaders } = require('../services/defaultHeaders');
const axios = require('axios');

// LIST endpoints, optionally filtered by folder (folder_id=null for uncategorized)
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
    `SELECT id, folder_id, name, method, path_template, headers, body_template, body_type, body_text, tags, sort_order, created_at, updated_at
     FROM endpoints ${where} ORDER BY sort_order ASC, created_at ASC, id ASC`,
    params
  );
  res.json(result.rows);
}));

// REORDER: persist drag-and-drop order from Config > Endpoints — `ids` is
// the full list of endpoint ids in their new display order.
router.put('/reorder', catchAsync(async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids must be a non-empty array' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < ids.length; i++) {
      await client.query('UPDATE endpoints SET sort_order=$1 WHERE id=$2', [i, ids[i]]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.json({ ok: true });
}));

// IMPORT from curl string -> creates endpoint + auto test-run to generate schema + suggest assertions
router.post('/from-curl', catchAsync(async (req, res) => {
  const { curl, name, folder_id = null } = req.body;
  if (!curl) return res.status(400).json({ error: 'curl string is required' });

  const parsed = parseCurl(curl);
  if (!parsed.url) return res.status(400).json({ error: 'Could not detect URL in curl command' });

  const envResult = await pool.query('SELECT * FROM environments');
  const pathTemplate = toPathTemplate(parsed.url, envResult.rows);
  const defaults = await getDefaultHeaders();
  const headers = mergeHeaders(parsed.headers, defaults);

  // Explicit next sort_order — the column's DEFAULT 0 would otherwise collide
  // with whichever existing endpoint(s) also still sit at 0 (e.g. one never
  // manually reordered), landing this new import somewhere in the middle of
  // the list instead of at the end where a freshly-created row belongs.
  const nextSortOrderResult = await pool.query('SELECT COALESCE(MAX(sort_order), -1) + 1 as next FROM endpoints');
  const nextSortOrder = nextSortOrderResult.rows[0].next;

  const endpointResult = await pool.query(
    `INSERT INTO endpoints (folder_id, name, method, path_template, headers, body_template, body_type, tags, sort_order)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9) RETURNING *`,
    [
      folder_id,
      name || `${parsed.method} ${pathTemplate}`,
      parsed.method,
      pathTemplate,
      JSON.stringify(headers),
      JSON.stringify(parsed.body || {}),
      parsed.isMultipart ? 'form-data' : 'json',
      [],
      nextSortOrder,
    ]
  );
  const endpoint = endpointResult.rows[0];

  // Try hitting the real URL once to capture schema + suggest assertions.
  // Skipped for multipart (file upload) curls — the actual file isn't available
  // to replay, so a live hit would just fail with a misleading status.
  let suggestedAssertions = [
    { type: 'status_code', expected: 200 },
    { type: 'response_time', max_ms: 5000 },
  ];
  let capturedSchema = null;

  if (!parsed.isMultipart) {
    try {
      const liveResponse = await axios({
        method: parsed.method,
        url: parsed.url,
        headers,
        data: parsed.body,
        validateStatus: () => true,
        timeout: 10000,
      });

      // Only treat the live hit as informative if it actually succeeded —
      // an error response (4xx/5xx) is not a sensible "expected" status,
      // and its body isn't a real schema for this endpoint.
      if (liveResponse.status >= 200 && liveResponse.status < 300) {
        capturedSchema = generateSchema(liveResponse.data);
        suggestedAssertions[0].expected = liveResponse.status;

        if (capturedSchema.type === 'object') {
          for (const key of Object.keys(capturedSchema.properties)) {
            suggestedAssertions.push({ type: 'field_exists', path: key });
          }
        }

        await pool.query(
          `INSERT INTO endpoint_schemas (endpoint_id, schema, version) VALUES ($1,$2::jsonb,1)`,
          [endpoint.id, JSON.stringify(capturedSchema)]
        );
      }
    } catch (err) {
      // Live capture is best-effort; endpoint is still created without it
    }
  }

  res.status(201).json({
    endpoint,
    suggested_assertions: suggestedAssertions,
    captured_schema: capturedSchema,
  });
}));

// IMPORT from Postman Collection JSON -> creates one endpoint per request item,
// recreating the collection's folder structure as endpoint folders.
router.post('/import/postman-collection', catchAsync(async (req, res) => {
  const { collection } = req.body;
  if (!collection?.item) return res.status(400).json({ error: 'Format collection tidak valid (field "item" tidak ditemukan)' });

  const parsedItems = parseCollection(collection);
  const envResult = await pool.query('SELECT * FROM environments');
  const environments = envResult.rows;
  const defaults = await getDefaultHeaders();

  const folderCache = new Map(); // "Parent/Child" -> folder_id

  // Same reasoning as the cURL import above — explicit sort_order so each
  // imported endpoint appends after the current end of the list instead of
  // colliding with the column's DEFAULT 0.
  const nextSortOrderResult = await pool.query('SELECT COALESCE(MAX(sort_order), -1) + 1 as next FROM endpoints');
  let nextSortOrder = nextSortOrderResult.rows[0].next;

  async function ensureFolderPath(path) {
    if (path.length === 0) return null;
    const key = path.join('/');
    if (folderCache.has(key)) return folderCache.get(key);

    const parentId = await ensureFolderPath(path.slice(0, -1));
    const name = path[path.length - 1];

    const existing = await pool.query(
      `SELECT id FROM folders WHERE kind='endpoint' AND name=$1 AND parent_id IS NOT DISTINCT FROM $2`,
      [name, parentId]
    );
    let folderId;
    if (existing.rows[0]) {
      folderId = existing.rows[0].id;
    } else {
      const inserted = await pool.query(
        `INSERT INTO folders (kind, name, parent_id) VALUES ('endpoint',$1,$2) RETURNING id`,
        [name, parentId]
      );
      folderId = inserted.rows[0].id;
    }
    folderCache.set(key, folderId);
    return folderId;
  }

  const created = [];
  for (const item of parsedItems) {
    const folderId = await ensureFolderPath(item.folderPath);
    const pathTemplate = toPathTemplate(item.url, environments);
    const headers = mergeHeaders(item.headers, defaults);
    const result = await pool.query(
      `INSERT INTO endpoints (folder_id, name, method, path_template, headers, body_template, body_type, tags, sort_order)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9) RETURNING *`,
      [folderId, item.name, item.method, pathTemplate, JSON.stringify(headers), JSON.stringify(item.body || {}), item.bodyType || 'json', [], nextSortOrder++]
    );
    created.push(result.rows[0]);
  }

  res.status(201).json({ imported: created.length, endpoints: created });
}));

// UPDATE endpoint (including moving it between folders)
router.put('/:id', catchAsync(async (req, res) => {
  const { name, method, path_template, headers, body_template, body_type = 'json', body_text, tags, folder_id } = req.body;
  const result = await pool.query(
    `UPDATE endpoints SET name=$1, method=$2, path_template=$3, headers=$4::jsonb, body_template=$5::jsonb, body_type=$6, body_text=$7, tags=$8, folder_id=$9, updated_at=NOW()
     WHERE id=$10 RETURNING *`,
    [name, method, path_template, JSON.stringify(headers), JSON.stringify(body_template), body_type, body_type === 'json' ? (body_text ?? null) : null, tags, folder_id ?? null, req.params.id]
  );
  res.json(result.rows[0]);
}));

// DELETE endpoint
router.delete('/:id', catchAsync(async (req, res) => {
  await pool.query('DELETE FROM endpoints WHERE id=$1', [req.params.id]);
  res.status(204).send();
}));

// DUPLICATE endpoint: copies it (name suffixed " (Copy)") into the same
// folder, at the end of the list — speeds up building a variant of an
// existing endpoint instead of re-entering the whole request from scratch.
router.post('/:id/duplicate', catchAsync(async (req, res) => {
  const originalResult = await pool.query('SELECT * FROM endpoints WHERE id=$1', [req.params.id]);
  const original = originalResult.rows[0];
  if (!original) return res.status(404).json({ error: 'Endpoint not found' });

  const nextSortOrderResult = await pool.query('SELECT COALESCE(MAX(sort_order), -1) + 1 as next FROM endpoints');
  const nextSortOrder = nextSortOrderResult.rows[0].next;

  const result = await pool.query(
    `INSERT INTO endpoints (folder_id, name, method, path_template, headers, body_template, body_type, body_text, tags, sort_order)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10) RETURNING *`,
    [
      original.folder_id,
      `${original.name} (Copy)`,
      original.method,
      original.path_template,
      JSON.stringify(original.headers),
      JSON.stringify(original.body_template),
      original.body_type,
      original.body_text,
      original.tags,
      nextSortOrder,
    ]
  );
  res.status(201).json(result.rows[0]);
}));

module.exports = router;
