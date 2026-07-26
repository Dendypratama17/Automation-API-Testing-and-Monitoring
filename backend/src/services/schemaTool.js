/**
 * Generate a lightweight JSON schema from a sample response body.
 * Not a full JSON-Schema implementation — just enough to track field
 * names/types and detect drift between runs.
 */
function generateSchema(value) {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    return {
      type: 'array',
      items: value.length > 0 ? generateSchema(value[0]) : { type: 'unknown' },
    };
  }
  if (typeof value === 'object') {
    const properties = {};
    for (const key of Object.keys(value)) {
      properties[key] = generateSchema(value[key]);
    }
    return { type: 'object', properties };
  }
  return { type: typeof value }; // string, number, boolean
}

/**
 * Compare two generated schemas and return a list of differences.
 * Used to flag SCHEMA_DRIFT between test runs.
 */
function diffSchema(oldSchema, newSchema, path = '') {
  const diffs = [];

  if (!oldSchema || !newSchema) return diffs;

  if (oldSchema.type !== newSchema.type) {
    diffs.push({ path: path || '(root)', change: 'type_changed', from: oldSchema.type, to: newSchema.type });
    return diffs;
  }

  if (oldSchema.type === 'object') {
    const oldKeys = Object.keys(oldSchema.properties || {});
    const newKeys = Object.keys(newSchema.properties || {});

    for (const key of oldKeys) {
      const childPath = path ? `${path}.${key}` : key;
      if (!newKeys.includes(key)) {
        diffs.push({ path: childPath, change: 'field_removed' });
      } else {
        diffs.push(...diffSchema(oldSchema.properties[key], newSchema.properties[key], childPath));
      }
    }
    for (const key of newKeys) {
      if (!oldKeys.includes(key)) {
        const childPath = path ? `${path}.${key}` : key;
        diffs.push({ path: childPath, change: 'field_added' });
      }
    }
  }

  if (oldSchema.type === 'array') {
    diffs.push(...diffSchema(oldSchema.items, newSchema.items, `${path}[]`));
  }

  return diffs;
}

module.exports = { generateSchema, diffSchema };
