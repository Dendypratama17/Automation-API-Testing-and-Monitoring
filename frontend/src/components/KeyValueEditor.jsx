import React, { useEffect, useState } from 'react';
import { getDefaultHeaders } from '../api/client';
import HeaderValueSelect from './HeaderValueSelect.jsx';

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
  // Any header key that has values configured under Config > Default
  // Headers gets those offered as a dropdown of quick picks — e.g.
  // X-Platform-Name offering Web/Android/iOS, or X-Token offering one entry
  // per test account. The value field itself is always a real text input
  // (see HeaderValueSelect) — picking a suggestion just fills it in, typing
  // a brand-new value (nothing saved for it yet) always works too.
  const [valueOptionsByKey, setValueOptionsByKey] = useState({});
  useEffect(() => {
    getDefaultHeaders().then((headers) => {
      const grouped = {};
      for (const h of headers) {
        const lower = h.key.trim().toLowerCase();
        if (!grouped[lower]) grouped[lower] = [];
        if (!grouped[lower].some((o) => o.value === h.value)) {
          grouped[lower].push({ value: h.value, label: h.label || null, environment_name: h.environment_name || null });
        }
      }
      setValueOptionsByKey(grouped);
    }).catch(() => {});
  }, []);

  const valueOptionsFor = (key) => valueOptionsByKey[key.trim().toLowerCase()] || [];

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
        const valueOptions = valueOptionsFor(row.key);
        return (
          <div key={idx} className="kv-row" style={{ opacity: row.enabled === false ? 0.5 : 1 }}>
            <input
              type="checkbox"
              checked={row.enabled !== false}
              onChange={(e) => update(idx, 'enabled', e.target.checked)}
              title={row.enabled === false ? 'Enable this row' : 'Disable this row'}
            />
            <input placeholder={keyPlaceholder} value={row.key} onChange={(e) => update(idx, 'key', e.target.value)} style={{ minWidth: 0 }} />
            <HeaderValueSelect
              options={valueOptions}
              value={row.value}
              onChange={(v) => update(idx, 'value', v)}
              placeholder={valuePlaceholder}
            />
            <button className="btn-quiet" onClick={() => removeRow(idx)}>✕</button>
          </div>
        );
      })}
      <button onClick={addRow} style={{ alignSelf: 'flex-start' }}>+ Add</button>
    </div>
  );
}
