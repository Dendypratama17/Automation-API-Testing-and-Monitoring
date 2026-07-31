import React from 'react';

const ASSERTION_TYPES = [
  { value: 'status_code', label: 'Status Code' },
  { value: 'response_time', label: 'Response Time' },
  { value: 'field_exists', label: 'Field Exists' },
  { value: 'field_not_null', label: 'Field Not Null' },
  { value: 'field_equals', label: 'Field Equals' },
  { value: 'field_contains', label: 'Field Contains' },
  { value: 'field_matches', label: 'Field Matches (Regex)' },
  { value: 'field_greater_than', label: 'Field Greater Than' },
  { value: 'field_less_than', label: 'Field Less Than' },
  { value: 'array_length', label: 'Array Length' },
  { value: 'array_find_equals', label: 'Array: Find Item & Check Field' },
  { value: 'array_none_equals', label: 'Array: No Item Equals' },
  { value: 'array_deep_none_equals', label: 'Array: No Nested Field Equals (Deep Scan)' },
  { value: 'header_exists', label: 'Header Exists' },
  { value: 'header_equals', label: 'Header Equals' },
];

const emptyAssertionRow = () => ({
  type: 'status_code', expected: '', max_ms: '', path: '', pattern: '', header: '',
  matchField: '', matchValue: '', checkField: '', subPath: '', key: '', enabled: true,
});

export function objectToAssertionRows(assertions) {
  if (!assertions || !assertions.length) return [];
  return assertions.map((a) => ({
    type: a.type || 'status_code',
    expected: a.expected !== undefined && a.expected !== null ? String(a.expected) : '',
    max_ms: a.max_ms !== undefined && a.max_ms !== null ? String(a.max_ms) : '',
    path: a.path || '',
    pattern: a.pattern || '',
    header: a.header || '',
    matchField: a.matchField || '',
    matchValue: a.matchValue !== undefined && a.matchValue !== null ? String(a.matchValue) : '',
    checkField: a.checkField || '',
    subPath: a.subPath || '',
    key: a.key || '',
    enabled: a.enabled !== false,
  }));
}

function coerceExpected(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value.trim() !== '' && !Number.isNaN(Number(value))) return Number(value);
  return value;
}

export function assertionRowsToArray(rows) {
  const out = [];
  for (const r of rows) {
    // Unchecked (disabled) rows are still persisted, just marked so the
    // runner skips evaluating them — otherwise unchecking one and saving
    // would silently delete it instead of just turning it off.
    const enabledFlag = r.enabled === false ? { enabled: false } : {};
    switch (r.type) {
      case 'status_code':
        if (r.expected.trim()) out.push({ type: 'status_code', expected: Number(r.expected), ...enabledFlag });
        break;
      case 'response_time':
        if (r.max_ms.trim()) out.push({ type: 'response_time', max_ms: Number(r.max_ms), ...enabledFlag });
        break;
      case 'field_exists':
        if (r.path.trim()) out.push({ type: 'field_exists', path: r.path.trim(), ...enabledFlag });
        break;
      case 'field_not_null':
        if (r.path.trim()) out.push({ type: 'field_not_null', path: r.path.trim(), ...enabledFlag });
        break;
      case 'field_equals':
        if (r.path.trim()) out.push({ type: 'field_equals', path: r.path.trim(), expected: coerceExpected(r.expected), ...enabledFlag });
        break;
      case 'field_contains':
        if (r.path.trim() && r.expected.trim()) out.push({ type: 'field_contains', path: r.path.trim(), expected: r.expected, ...enabledFlag });
        break;
      case 'field_matches':
        if (r.path.trim() && r.pattern.trim()) out.push({ type: 'field_matches', path: r.path.trim(), pattern: r.pattern.trim(), ...enabledFlag });
        break;
      case 'field_greater_than':
        if (r.path.trim() && r.expected.trim()) out.push({ type: 'field_greater_than', path: r.path.trim(), expected: Number(r.expected), ...enabledFlag });
        break;
      case 'field_less_than':
        if (r.path.trim() && r.expected.trim()) out.push({ type: 'field_less_than', path: r.path.trim(), expected: Number(r.expected), ...enabledFlag });
        break;
      case 'array_length':
        if (r.path.trim() && r.expected.trim()) out.push({ type: 'array_length', path: r.path.trim(), expected: Number(r.expected), ...enabledFlag });
        break;
      case 'array_find_equals':
        if (r.path.trim() && r.matchField.trim() && r.checkField.trim()) {
          out.push({
            type: 'array_find_equals',
            path: r.path.trim(),
            matchField: r.matchField.trim(),
            matchValue: coerceExpected(r.matchValue),
            checkField: r.checkField.trim(),
            expected: coerceExpected(r.expected),
            ...enabledFlag,
          });
        }
        break;
      case 'array_none_equals':
        if (r.path.trim() && r.checkField.trim()) {
          out.push({
            type: 'array_none_equals',
            path: r.path.trim(),
            checkField: r.checkField.trim(),
            expected: coerceExpected(r.expected),
            ...enabledFlag,
          });
        }
        break;
      case 'array_deep_none_equals':
        if (r.path.trim() && r.key.trim()) {
          out.push({
            type: 'array_deep_none_equals',
            path: r.path.trim(),
            ...(r.subPath.trim() ? { subPath: r.subPath.trim() } : {}),
            key: r.key.trim(),
            expected: coerceExpected(r.expected),
            ...enabledFlag,
          });
        }
        break;
      case 'header_exists':
        if (r.header.trim()) out.push({ type: 'header_exists', header: r.header.trim(), ...enabledFlag });
        break;
      case 'header_equals':
        if (r.header.trim() && r.expected.trim()) out.push({ type: 'header_equals', header: r.header.trim(), expected: r.expected, ...enabledFlag });
        break;
      default:
        break;
    }
  }
  return out;
}

export { emptyAssertionRow };

// Which input fields a given assertion type needs, and how to label them —
// keeps the render loop below a single data-driven block instead of one
// hand-written JSX branch per type.
const FIELD_CONFIG = {
  status_code: [{ key: 'expected', placeholder: 'Expected status (e.g. 200)', type: 'number' }],
  response_time: [{ key: 'max_ms', placeholder: 'Max ms (e.g. 5000)', type: 'number' }],
  field_exists: [{ key: 'path', placeholder: 'Field path (e.g. data.id)' }],
  field_not_null: [{ key: 'path', placeholder: 'Field path (e.g. data)' }],
  field_equals: [
    { key: 'path', placeholder: 'Field path (e.g. data.status)' },
    { key: 'expected', placeholder: 'Expected value' },
  ],
  field_contains: [
    { key: 'path', placeholder: 'Field path (e.g. data.message)' },
    { key: 'expected', placeholder: 'Substring to contain' },
  ],
  field_matches: [
    { key: 'path', placeholder: 'Field path (e.g. data.email)' },
    { key: 'pattern', placeholder: 'Regex pattern (e.g. ^[\\w.]+@)' },
  ],
  field_greater_than: [
    { key: 'path', placeholder: 'Field path (e.g. data.total)' },
    { key: 'expected', placeholder: 'Expected minimum', type: 'number' },
  ],
  field_less_than: [
    { key: 'path', placeholder: 'Field path (e.g. data.total)' },
    { key: 'expected', placeholder: 'Expected maximum', type: 'number' },
  ],
  array_length: [
    { key: 'path', placeholder: 'Field path (e.g. data.items)' },
    { key: 'expected', placeholder: 'Expected length', type: 'number' },
  ],
  array_find_equals: [
    { key: 'path', placeholder: 'Array path (e.g. data)' },
    { key: 'matchField', placeholder: 'Match field (e.g. participantRole)' },
    { key: 'matchValue', placeholder: 'Match value (e.g. SIGNER)' },
    { key: 'checkField', placeholder: 'Field to check (e.g. state)' },
    { key: 'expected', placeholder: 'Expected value (e.g. TO_SIGN)' },
  ],
  array_none_equals: [
    { key: 'path', placeholder: 'Array path (e.g. result.signatures)' },
    { key: 'checkField', placeholder: 'Field to check (e.g. certificateInfo.trustedStatus)' },
    { key: 'expected', placeholder: 'Forbidden value (e.g. UNTRUSTED)' },
  ],
  array_deep_none_equals: [
    { key: 'path', placeholder: 'Array path (e.g. result.signatures)' },
    { key: 'subPath', placeholder: 'Scope to sub-field (optional, e.g. certificateInfo)' },
    { key: 'key', placeholder: 'Field name to find at any depth (e.g. trustedStatus)' },
    { key: 'expected', placeholder: 'Forbidden value (e.g. UNTRUSTED)' },
  ],
  header_exists: [{ key: 'header', placeholder: 'Header name (e.g. Content-Type)' }],
  header_equals: [
    { key: 'header', placeholder: 'Header name (e.g. Content-Type)' },
    { key: 'expected', placeholder: 'Expected value' },
  ],
};

export default function AssertionsEditor({ rows, onChange }) {
  const update = (idx, field, value) => {
    const next = [...rows];
    next[idx] = { ...next[idx], [field]: value };
    onChange(next);
  };
  const addRow = () => onChange([...rows, emptyAssertionRow()]);
  const removeRow = (idx) => onChange(rows.filter((_, i) => i !== idx));

  return (
    <div className="stack" style={{ gap: 6 }}>
      {rows.map((row, idx) => (
        <div key={idx} className="toolbar" style={{ opacity: row.enabled === false ? 0.5 : 1 }}>
          <input
            type="checkbox"
            checked={row.enabled !== false}
            onChange={(e) => update(idx, 'enabled', e.target.checked)}
            title={row.enabled === false ? 'Enable this assertion' : 'Disable this assertion'}
          />
          <select value={row.type} onChange={(e) => update(idx, 'type', e.target.value)} style={{ flexShrink: 0 }}>
            {ASSERTION_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>

          {(FIELD_CONFIG[row.type] || []).map((f) => (
            <input
              key={f.key}
              type={f.type || 'text'}
              placeholder={f.placeholder}
              value={row[f.key] ?? ''}
              onChange={(e) => update(idx, f.key, e.target.value)}
              style={{ flex: 1, minWidth: 0 }}
            />
          ))}

          <button className="btn-quiet" onClick={() => removeRow(idx)}>✕</button>
        </div>
      ))}
      <button onClick={addRow} style={{ alignSelf: 'flex-start' }}>+ Add Assertion</button>
    </div>
  );
}
