import React, { useEffect, useState } from 'react';
import FilePicker from './FilePicker.jsx';
import { getTestFiles, getTestFile } from '../api/client';

const emptyFormRow = () => ({ key: '', type: 'text', value: '', enabled: true, fileMeta: null });

// A "@file:/some/path" string is a dead placeholder left over from importing
// a cURL command's `-F key=@/path/to/file` flag — the path only ever existed
// on whichever machine ran that curl, so there's no real file data behind
// it. Treat it as a file field that needs re-attaching, not a real value.
const FILE_PLACEHOLDER_RE = /^@file:(.*)$/;

export function objectToFormRows(obj) {
  // A plain string (e.g. a body that failed to parse into fields) is
  // iterable by Object.entries just like a real object — one entry per
  // character, keyed "0", "1", "2"... — so it must be rejected here rather
  // than falling through and rendering as a wall of single-character rows.
  const entries = obj && typeof obj === 'object' ? Object.entries(obj) : [];
  if (!entries.length) return [emptyFormRow()];
  return entries.map(([key, value]) => {
    if (value && typeof value === 'object' && value.__file_url__) {
      return { key, type: 'file', value: '', enabled: true, fileMeta: { __url__: true, url: value.url || '' } };
    }
    if (value && typeof value === 'object' && value.__file__) {
      return { key, type: 'file', value: '', enabled: true, fileMeta: { name: value.name, mimeType: value.mimeType, data: value.data } };
    }
    if (typeof value === 'string' && FILE_PLACEHOLDER_RE.test(value)) {
      return { key, type: 'file', value: '', enabled: true, fileMeta: null };
    }
    // A plain nested object/array (not a file marker) only shows up here
    // after editing the JSON preview, which unwraps a field's JSON-encoded
    // string into real nested structure for readability — re-stringify it
    // back into text instead of letting `String(value)` produce the useless
    // "[object Object]", since a multipart field can only be a flat string.
    if (value && typeof value === 'object') {
      return { key, type: 'text', value: JSON.stringify(value), enabled: true, fileMeta: null };
    }
    return { key, type: 'text', value: value == null ? '' : String(value), enabled: true, fileMeta: null };
  });
}

export function formRowsToObject(rows) {
  const obj = {};
  for (const row of rows) {
    if (row.enabled === false || !row.key.trim()) continue;
    if (row.type === 'file' && row.fileMeta?.__url__) {
      obj[row.key.trim()] = { __file_url__: true, url: row.fileMeta.url, name: row.key.trim() };
    } else if (row.type === 'file' && row.fileMeta) {
      obj[row.key.trim()] = { __file__: true, name: row.fileMeta.name, mimeType: row.fileMeta.mimeType, data: row.fileMeta.data };
    } else {
      obj[row.key.trim()] = row.value;
    }
  }
  return obj;
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export { emptyFormRow };

export default function FormDataEditor({ rows, onChange }) {
  // Saved test files (Config > Test Files) offered as a "pick from library"
  // shortcut next to the native file picker for any "File" field row.
  const [testFiles, setTestFiles] = useState([]);
  useEffect(() => { getTestFiles().then(setTestFiles).catch(() => {}); }, []);

  const update = (idx, field, value) => {
    const next = [...rows];
    next[idx] = { ...next[idx], [field]: value };
    onChange(next);
  };
  const addRow = () => onChange([...rows, emptyFormRow()]);
  const removeRow = (idx) => onChange(rows.length > 1 ? rows.filter((_, i) => i !== idx) : [emptyFormRow()]);

  const handleLibraryPick = async (idx, testFileId) => {
    if (!testFileId) return;
    const tf = await getTestFile(testFileId);
    update(idx, 'fileMeta', { name: tf.file_name, mimeType: tf.mime_type, data: tf.data });
  };

  // A "File" field with nothing attached yet defaults to the first Test File
  // in the library (same one Config > Test Files shows at the top) instead
  // of sitting blank — covers both switching a row's type to File and rows
  // that already came in as type "file" with no data (e.g. a dead cURL
  // import placeholder) once the library finishes loading.
  useEffect(() => {
    if (testFiles.length === 0) return;
    const missingIdx = rows.findIndex((r) => r.type === 'file' && !r.fileMeta);
    if (missingIdx === -1) return;
    handleLibraryPick(missingIdx, testFiles[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testFiles, rows]);

  const handleTypeChange = (idx, type) => {
    const next = [...rows];
    next[idx] = { ...next[idx], type, value: '', fileMeta: null };
    onChange(next);
  };

  const handleFilePick = async (idx, file) => {
    if (!file) return;
    const data = await readFileAsBase64(file);
    update(idx, 'fileMeta', { name: file.name, mimeType: file.type || 'application/octet-stream', data });
  };

  return (
    <div className="stack" style={{ gap: 6 }}>
      {rows.map((row, idx) => (
        <div key={idx} className="form-data-row">
          <input
            type="checkbox"
            checked={row.enabled !== false}
            onChange={(e) => update(idx, 'enabled', e.target.checked)}
            title={row.enabled === false ? 'Enable this row' : 'Disable this row'}
          />
          <input
            placeholder="Key"
            value={row.key}
            onChange={(e) => update(idx, 'key', e.target.value)}
            style={{ minWidth: 0, opacity: row.enabled === false ? 0.5 : 1 }}
          />
          <select value={row.type} onChange={(e) => handleTypeChange(idx, e.target.value)} style={{ opacity: row.enabled === false ? 0.5 : 1 }}>
            <option value="text">Text</option>
            <option value="file">File</option>
          </select>

          {row.type === 'file' ? (
            <div style={{ minWidth: 0, opacity: row.enabled === false ? 0.5 : 1, display: 'flex', alignItems: 'center', gap: 6 }}>
              {row.fileMeta?.__url__ ? (
                <>
                  <input
                    placeholder="https://... or {{variable}}"
                    value={row.fileMeta.url}
                    onChange={(e) => update(idx, 'fileMeta', { __url__: true, url: e.target.value })}
                    style={{ minWidth: 0, flex: 1 }}
                  />
                  <button
                    type="button"
                    className="btn-quiet"
                    title="Switch back to upload/library file"
                    onClick={() => update(idx, 'fileMeta', null)}
                  >
                    Use file instead
                  </button>
                </>
              ) : (
                <FilePicker
                  label="Attach File"
                  fileName={row.fileMeta?.name}
                  onFileSelect={(e) => handleFilePick(idx, e.target.files[0])}
                  libraryOptions={testFiles}
                  onLibrarySelect={(testFileId) => handleLibraryPick(idx, testFileId)}
                  onUseUrl={() => update(idx, 'fileMeta', { __url__: true, url: '' })}
                />
              )}
            </div>
          ) : (
            <input
              placeholder="Value"
              value={row.value}
              onChange={(e) => update(idx, 'value', e.target.value)}
              style={{ minWidth: 0, opacity: row.enabled === false ? 0.5 : 1 }}
            />
          )}

          <button className="btn-quiet" onClick={() => removeRow(idx)}>✕</button>
        </div>
      ))}
      <button onClick={addRow} style={{ alignSelf: 'flex-start' }}>+ Add</button>
    </div>
  );
}
