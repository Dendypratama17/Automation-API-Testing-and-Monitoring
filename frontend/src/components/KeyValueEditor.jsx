import React, { useEffect, useState } from 'react';
import { getDefaultHeaders } from '../api/client';

// A disabled row is still saved (wrapped, so it round-trips through the
// plain {key: value} JSONB column) instead of being silently dropped —
// otherwise unchecking a header and saving would make it vanish for good.
function isDisabledWrapper(value) {
  return value && typeof value === 'object' && value.__disabled__ === true;
}

export function objectToRows(obj) {
  const entries = Object.entries(obj || {});
  return entries.length
    ? entries.map(([key, value]) => (
      isDisabledWrapper(value)
        ? { key, value: String(value.value ?? ''), enabled: false }
        : { key, value: String(value), enabled: true }
    ))
    : [{ key: '', value: '', enabled: true }];
}

export function rowsToObject(rows) {
  const obj = {};
  for (const { key, value, enabled } of rows) {
    if (!key.trim()) continue;
    obj[key.trim()] = enabled === false ? { __disabled__: true, value } : value;
  }
  return obj;
}

export default function KeyValueEditor({ rows, onChange, keyPlaceholder = 'Key', valuePlaceholder = 'Value' }) {
  // Any header key that has 2+ values configured under Config > Default
  // Headers gets a dropdown of those values here instead of a free-text
  // input — e.g. X-Platform-Name offering Web/Android/iOS. A key with only
  // one configured value stays a plain input (nothing to pick between).
  const [valueOptionsByKey, setValueOptionsByKey] = useState({});
  useEffect(() => {
    getDefaultHeaders().then((headers) => {
      const grouped = {};
      for (const h of headers) {
        const lower = h.key.trim().toLowerCase();
        if (!grouped[lower]) grouped[lower] = [];
        if (!grouped[lower].includes(h.value)) grouped[lower].push(h.value);
      }
      setValueOptionsByKey(grouped);
    }).catch(() => {});
  }, []);

  const valueOptionsFor = (key, currentValue) => {
    const options = valueOptionsByKey[key.trim().toLowerCase()];
    if (!options || options.length < 2) return null;
    // Keep whatever's already stored selectable even if it's not one of the
    // known picks (e.g. an older/custom value, or even an empty string) —
    // filtering out a falsy-but-real current value here would leave no <option>
    // matching the <select>'s value, so the browser silently falls back to
    // displaying the first option instead, even though nothing was actually
    // selected/saved.
    return options.includes(currentValue) ? options : [currentValue, ...options];
  };

  const update = (idx, field, value) => {
    const next = [...rows];
    next[idx] = { ...next[idx], [field]: value };
    onChange(next);
  };
  const addRow = () => onChange([...rows, { key: '', value: '', enabled: true }]);
  const removeRow = (idx) => onChange(rows.length > 1 ? rows.filter((_, i) => i !== idx) : [{ key: '', value: '', enabled: true }]);

  return (
    <div className="stack" style={{ gap: 6 }}>
      {rows.map((row, idx) => {
        const valueOptions = valueOptionsFor(row.key, row.value);
        return (
          <div key={idx} className="kv-row" style={{ opacity: row.enabled === false ? 0.5 : 1 }}>
            <input
              type="checkbox"
              checked={row.enabled !== false}
              onChange={(e) => update(idx, 'enabled', e.target.checked)}
              title={row.enabled === false ? 'Enable this row' : 'Disable this row'}
            />
            <input placeholder={keyPlaceholder} value={row.key} onChange={(e) => update(idx, 'key', e.target.value)} style={{ minWidth: 0 }} />
            {valueOptions ? (
              <select value={row.value} onChange={(e) => update(idx, 'value', e.target.value)} style={{ minWidth: 0 }}>
                {valueOptions.map((opt) => <option key={opt} value={opt}>{opt || '(empty)'}</option>)}
              </select>
            ) : (
              <input placeholder={valuePlaceholder} value={row.value} onChange={(e) => update(idx, 'value', e.target.value)} style={{ minWidth: 0 }} />
            )}
            <button className="btn-quiet" onClick={() => removeRow(idx)}>✕</button>
          </div>
        );
      })}
      <button onClick={addRow} style={{ alignSelf: 'flex-start' }}>+ Add</button>
    </div>
  );
}
