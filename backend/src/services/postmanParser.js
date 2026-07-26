/**
 * Flatten a Postman Collection v2.x JSON into a flat list of request items,
 * keeping track of the folder path (nested "item" groups) each one lived in
 * so the caller can recreate the same folder structure for endpoints.
 */
function extractUrl(urlField) {
  if (typeof urlField === 'string') return urlField;
  if (urlField?.raw) return urlField.raw;
  return '';
}

function extractHeaders(headerField) {
  const headers = {};
  for (const h of headerField || []) {
    if (!h.disabled) headers[h.key] = h.value;
  }
  return headers;
}

function extractBody(bodyField) {
  if (!bodyField) return { body: null, bodyType: 'json' };
  if (bodyField.mode === 'raw') {
    try { return { body: JSON.parse(bodyField.raw), bodyType: 'json' }; }
    catch { return { body: bodyField.raw, bodyType: 'json' }; }
  }
  if (bodyField.mode === 'urlencoded' || bodyField.mode === 'formdata') {
    const obj = {};
    for (const kv of bodyField[bodyField.mode] || []) {
      if (!kv.disabled) obj[kv.key] = kv.value;
    }
    return { body: obj, bodyType: 'form-data' };
  }
  return { body: null, bodyType: 'json' };
}

function walkItems(items, folderPath, out) {
  for (const item of items || []) {
    if (item.item) {
      walkItems(item.item, [...folderPath, item.name], out);
    } else if (item.request) {
      const req = item.request;
      const { body, bodyType } = extractBody(req.body);
      out.push({
        folderPath,
        name: item.name,
        method: (req.method || 'GET').toUpperCase(),
        url: extractUrl(req.url),
        headers: extractHeaders(req.header),
        body,
        bodyType,
      });
    }
  }
}

/**
 * @param {object} collection - parsed Postman Collection JSON (must have .item)
 * @returns {Array<{folderPath: string[], name: string, method: string, url: string, headers: object, body: any, bodyType: string}>}
 */
function parseCollection(collection) {
  const out = [];
  walkItems(collection.item, [], out);
  return out;
}

module.exports = { parseCollection };
