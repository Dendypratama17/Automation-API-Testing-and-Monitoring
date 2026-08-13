// Walks two JSON values in parallel and collects every leaf-level
// difference as { path, old_value, new_value } — added/removed keys show up
// the same way, just with one side as `undefined`. A path (or any path
// nested under it, e.g. ignoring "data.document" also skips
// "data.document.id") listed in `ignorePaths` is skipped entirely, so
// fields that are expected to differ on every run (ids, tokens, timestamps)
// don't drown out the differences that actually matter.
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIgnored(path, ignorePaths) {
  return ignorePaths.some((ignored) => path === ignored || path.startsWith(`${ignored}.`) || path.startsWith(`${ignored}[`));
}

function diffValues(oldValue, newValue, ignorePaths = [], path = '') {
  if (isIgnored(path, ignorePaths)) return [];

  const bothArrays = Array.isArray(oldValue) && Array.isArray(newValue);
  const bothObjects = !bothArrays && isPlainObject(oldValue) && isPlainObject(newValue);

  if (bothArrays) {
    const diffs = [];
    const maxLen = Math.max(oldValue.length, newValue.length);
    for (let i = 0; i < maxLen; i++) {
      diffs.push(...diffValues(oldValue[i], newValue[i], ignorePaths, `${path}[${i}]`));
    }
    return diffs;
  }

  if (bothObjects) {
    const diffs = [];
    const keys = [...new Set([...Object.keys(oldValue), ...Object.keys(newValue)])];
    for (const key of keys) {
      const childPath = path ? `${path}.${key}` : key;
      diffs.push(...diffValues(oldValue[key], newValue[key], ignorePaths, childPath));
    }
    return diffs;
  }

  // Leaf (or type mismatch, e.g. object vs array, string vs number) — compare
  // by value. JSON.stringify sidesteps NaN/undefined-in-array edge cases
  // that plain !== can get wrong for nested structures reaching here.
  const equal = JSON.stringify(oldValue) === JSON.stringify(newValue);
  return equal ? [] : [{ path, old_value: oldValue, new_value: newValue }];
}

module.exports = { diffValues };
