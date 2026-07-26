import React from 'react';

const emptyExtractRow = () => ({ variable: '', path: '' });

export function arrayToExtractRows(extract) {
  if (!extract || !extract.length) return [];
  return extract.map((e) => ({ variable: e.variable || '', path: e.path || '' }));
}

export function extractRowsToArray(rows) {
  const out = [];
  for (const { variable, path } of rows) {
    if (variable.trim() && path.trim()) out.push({ variable: variable.trim(), path: path.trim() });
  }
  return out;
}

export { emptyExtractRow };

export default function ExtractVariableEditor({ rows, onChange }) {
  const update = (idx, field, value) => {
    const next = [...rows];
    next[idx] = { ...next[idx], [field]: value };
    onChange(next);
  };
  const addRow = () => onChange([...rows, emptyExtractRow()]);
  const removeRow = (idx) => onChange(rows.filter((_, i) => i !== idx));

  return (
    <div className="stack" style={{ gap: 6 }}>
      {rows.map((row, idx) => (
        <div key={idx} className="extract-row">
          <input
            placeholder="Variable name (e.g. id)"
            value={row.variable}
            onChange={(e) => update(idx, 'variable', e.target.value)}
            className="mono"
            style={{ minWidth: 0 }}
          />
          <input
            placeholder="Field path in response (e.g. data.document.id)"
            value={row.path}
            onChange={(e) => update(idx, 'path', e.target.value)}
            className="mono"
            style={{ minWidth: 0 }}
          />
          <button className="btn-quiet" onClick={() => removeRow(idx)}>✕</button>
        </div>
      ))}
      <button onClick={addRow} style={{ alignSelf: 'flex-start' }}>+ Add Variable</button>
    </div>
  );
}
