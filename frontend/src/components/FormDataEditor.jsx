import React, { useEffect, useRef, useState } from 'react';
import FilePicker from './FilePicker.jsx';
import { GripIcon } from './icons.jsx';
import { getTestFiles, getTestFile } from '../api/client';

// Id lokal-saja (tidak pernah disimpan) supaya tiap baris punya identitas
// yang stabil terlepas dari posisinya di array — dibutuhkan karena
// pengambilan file dari library (handleLibraryPick) berjalan async, dan
// kalau baris dicari ulang berdasarkan INDEX setelah drag-reorder terjadi
// di tengah proses fetch, update-nya bisa nimpa baris yang salah.
let formRowIdSeq = 0;
const nextFormRowId = () => `row-${++formRowIdSeq}-${Math.random().toString(36).slice(2, 8)}`;

const emptyFormRow = () => ({ _id: nextFormRowId(), key: '', type: 'text', value: '', enabled: true, fileMeta: null });

// A "@file:/some/path" string is a dead placeholder left over from importing
// a cURL command's `-F key=@/path/to/file` flag — the path only ever existed
// on whichever machine ran that curl, so there's no real file data behind
// it. Treat it as a file field that needs re-attaching, not a real value.
const FILE_PLACEHOLDER_RE = /^@file:(.*)$/;

export function objectToFormRows(body) {
  // Two shapes reach here: the current array of [key, value] tuples (what
  // gets saved now — see formRowsToBody — and what the curl importer
  // produces for a multipart body), and the legacy flat {key: value} object
  // every body_template saved before duplicate field names were supported
  // still has. A plain STRING (e.g. a body that failed to parse into
  // fields) is iterable by Object.entries just like a real object — one
  // entry per character, keyed "0", "1", "2"... — so it must be rejected
  // here rather than falling through and rendering as a wall of
  // single-character rows.
  const entries = Array.isArray(body) ? body : (body && typeof body === 'object' ? Object.entries(body) : []);
  if (!entries.length) return [emptyFormRow()];
  return entries.map(([key, rawValue]) => {
    // A row unchecked in the editor is saved as { __disabled__: true, value }
    // instead of being dropped (see formRowsToBody below) so it survives a
    // save/reload as a disabled row instead of disappearing outright.
    const disabled = rawValue && typeof rawValue === 'object' && rawValue.__disabled__;
    const value = disabled ? rawValue.value : rawValue;
    const enabled = !disabled;
    if (value && typeof value === 'object' && value.__file_url__) {
      return { _id: nextFormRowId(), key, type: 'file', value: '', enabled, fileMeta: { __url__: true, url: value.url || '' } };
    }
    if (value && typeof value === 'object' && value.__file__) {
      return { _id: nextFormRowId(), key, type: 'file', value: '', enabled, fileMeta: { name: value.name, mimeType: value.mimeType, data: value.data } };
    }
    if (typeof value === 'string' && FILE_PLACEHOLDER_RE.test(value)) {
      return { _id: nextFormRowId(), key, type: 'file', value: '', enabled, fileMeta: null };
    }
    // A plain nested object/array (not a file marker) only shows up here
    // after editing the JSON preview, which unwraps a field's JSON-encoded
    // string into real nested structure for readability — re-stringify it
    // back into text instead of letting `String(value)` produce the useless
    // "[object Object]", since a multipart field can only be a flat string.
    if (value && typeof value === 'object') {
      return { _id: nextFormRowId(), key, type: 'text', value: JSON.stringify(value), enabled, fileMeta: null };
    }
    return { _id: nextFormRowId(), key, type: 'text', value: value == null ? '' : String(value), enabled, fileMeta: null };
  });
}

// Used only for read-only JSON previews (the JSON tab, curl-export text) —
// collapsing two rows that share a key into one object slot is an
// acceptable simplification there, since JSON itself can't represent
// duplicate keys either. The actual saved/sent body must go through
// formRowsToBody below instead, which doesn't lose that second row.
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

// The shape that actually gets saved as body_template: an array of
// [key, value] tuples instead of a {key: value} object, so two rows
// sharing the same key (e.g. two "documents" file parts in one multi-file
// upload) both survive instead of the second silently overwriting the
// first in an object slot.
//
// A row unchecked in the editor is still saved — as [key, { __disabled__:
// true, value }] instead of being left out of the array entirely — so it
// comes back as a disabled row on reload instead of vanishing outright (see
// objectToFormRows above, and KeyValueEditor.jsx's rowsToObject for the same
// pattern already used for headers). The backend (flowExecutor.js's
// buildRequestBody) strips these before anything is actually sent.
export function formRowsToBody(rows) {
  const entries = [];
  for (const row of rows) {
    if (!row.key.trim()) continue;
    const key = row.key.trim();
    let value;
    if (row.type === 'file' && row.fileMeta?.__url__) {
      value = { __file_url__: true, url: row.fileMeta.url, name: key };
    } else if (row.type === 'file' && row.fileMeta) {
      value = { __file__: true, name: row.fileMeta.name, mimeType: row.fileMeta.mimeType, data: row.fileMeta.data };
    } else {
      value = row.value;
    }
    if (row.enabled === false) {
      entries.push([key, { __disabled__: true, value }]);
    } else {
      entries.push([key, value]);
    }
  }
  return entries;
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

  // handleLibraryPick/handleFilePick are async (they await a fetch/file
  // read) — if a drag-reorder (or any other edit) happens while one is
  // still in flight, its continuation must apply to the CURRENT rows, not
  // whichever `rows` was in scope back when it started. A ref kept in sync
  // every render always has the latest value, unlike the `rows` prop a
  // stale closure would otherwise see.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  // Reorder is purely local — same client-only model as the Flow editor's
  // step list (see Flows.jsx's handleDropStep): splice the dragged row out
  // and back in at the drop target, then hand the whole array to onChange.
  // Whatever eventually persists this (saving the endpoint/step) writes the
  // rows in whatever order they're in by then.
  const [draggedId, setDraggedId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);

  const handleDropRow = (targetId) => {
    const fromId = draggedId;
    setDraggedId(null);
    setDragOverId(null);
    if (fromId == null || fromId === targetId) return;
    const current = rowsRef.current;
    const fromIdx = current.findIndex((r) => r._id === fromId);
    const targetIdx = current.findIndex((r) => r._id === targetId);
    if (fromIdx === -1 || targetIdx === -1) return;
    const next = [...current];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(targetIdx, 0, moved);
    onChange(next);
  };

  // Addressed by the row's stable _id, not its array index — an async
  // continuation (see above) that resolves after a reorder must still land
  // on the SAME row it started with, not whatever row now happens to sit
  // at the original index.
  const update = (id, field, value) => {
    onChange(rowsRef.current.map((r) => (r._id === id ? { ...r, [field]: value } : r)));
  };
  const addRow = () => onChange([...rows, emptyFormRow()]);
  const removeRow = (id) => {
    const current = rowsRef.current;
    const next = current.filter((r) => r._id !== id);
    onChange(next.length ? next : [emptyFormRow()]);
  };

  const handleLibraryPick = async (id, testFileId) => {
    if (!testFileId) return;
    const tf = await getTestFile(testFileId);
    update(id, 'fileMeta', { name: tf.file_name, mimeType: tf.mime_type, data: tf.data });
  };

  // A "File" field with nothing attached yet defaults to the first Test File
  // in the library (same one Config > Test Files shows at the top) instead
  // of sitting blank — covers both switching a row's type to File and rows
  // that already came in as type "file" with no data (e.g. a dead cURL
  // import placeholder) once the library finishes loading.
  useEffect(() => {
    if (testFiles.length === 0) return;
    const missing = rows.find((r) => r.type === 'file' && !r.fileMeta);
    if (!missing) return;
    handleLibraryPick(missing._id, testFiles[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testFiles, rows]);

  const handleTypeChange = (id, type) => {
    onChange(rowsRef.current.map((r) => (r._id === id ? { ...r, type, value: '', fileMeta: null } : r)));
  };

  const handleFilePick = async (id, file) => {
    if (!file) return;
    const data = await readFileAsBase64(file);
    update(id, 'fileMeta', { name: file.name, mimeType: file.type || 'application/octet-stream', data });
  };

  return (
    <div className="stack" style={{ gap: 6 }}>
      {rows.map((row) => (
        <div
          key={row._id}
          className="form-data-row"
          onDragOver={(e) => { e.preventDefault(); if (dragOverId !== row._id) setDragOverId(row._id); }}
          onDragLeave={() => setDragOverId((id) => (id === row._id ? null : id))}
          onDrop={() => handleDropRow(row._id)}
          style={{
            opacity: draggedId === row._id ? 0.4 : 1,
            borderTop: dragOverId === row._id && draggedId !== row._id ? '2px solid var(--accent)' : undefined,
          }}
        >
          <span
            className="hint"
            style={{ cursor: 'grab' }}
            draggable
            onDragStart={(e) => { e.stopPropagation(); setDraggedId(row._id); }}
            onDragEnd={() => { setDraggedId(null); setDragOverId(null); }}
            title="Drag to reorder"
          >
            <GripIcon />
          </span>
          <input
            type="checkbox"
            checked={row.enabled !== false}
            onChange={(e) => update(row._id, 'enabled', e.target.checked)}
            title={row.enabled === false ? 'Enable this row' : 'Disable this row'}
          />
          <input
            placeholder="Key"
            value={row.key}
            onChange={(e) => update(row._id, 'key', e.target.value)}
            style={{ minWidth: 0, opacity: row.enabled === false ? 0.5 : 1 }}
          />
          <select value={row.type} onChange={(e) => handleTypeChange(row._id, e.target.value)} style={{ opacity: row.enabled === false ? 0.5 : 1 }}>
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
                    onChange={(e) => update(row._id, 'fileMeta', { __url__: true, url: e.target.value })}
                    style={{ minWidth: 0, flex: 1 }}
                  />
                  <button
                    type="button"
                    className="btn-quiet"
                    title="Switch back to upload/library file"
                    onClick={() => update(row._id, 'fileMeta', null)}
                  >
                    Use file instead
                  </button>
                </>
              ) : (
                <FilePicker
                  label="Attach File"
                  fileName={row.fileMeta?.name}
                  onFileSelect={(e) => handleFilePick(row._id, e.target.files[0])}
                  libraryOptions={testFiles}
                  onLibrarySelect={(testFileId) => handleLibraryPick(row._id, testFileId)}
                  onUseUrl={() => update(row._id, 'fileMeta', { __url__: true, url: '' })}
                />
              )}
            </div>
          ) : (
            <input
              placeholder="Value"
              value={row.value}
              onChange={(e) => update(row._id, 'value', e.target.value)}
              style={{ minWidth: 0, opacity: row.enabled === false ? 0.5 : 1 }}
            />
          )}

          <button className="btn-quiet" onClick={() => removeRow(row._id)}>✕</button>
        </div>
      ))}
      <button onClick={addRow} style={{ alignSelf: 'flex-start' }}>+ Add</button>
    </div>
  );
}
