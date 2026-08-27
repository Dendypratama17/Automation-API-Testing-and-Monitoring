import React, { useEffect, useState } from 'react';
import { getTestFiles, getTestFile, createTestFile, updateTestFile, deleteTestFile, reorderTestFiles } from '../api/client';
import { TrashIcon, GripIcon, EditIcon, EyeIcon } from '../components/icons.jsx';
import { useConfirm } from '../components/ConfirmProvider.jsx';
import FilePicker from '../components/FilePicker.jsx';
import OptionsMenu from '../components/OptionsMenu.jsx';
import { useToast } from '../components/ToastProvider.jsx';

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function TestFiles() {
  const confirm = useConfirm();
  const showToast = useToast();
  const [files, setFiles] = useState([]);
  const [name, setName] = useState('');
  const [picked, setPicked] = useState(null); // { file, data }
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [draggedId, setDraggedId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');

  const load = () => getTestFiles().then(setFiles);
  useEffect(() => { load(); }, []);

  const handlePick = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setError('');
    const data = await readFileAsBase64(file);
    setPicked({ file, data });
    setName(file.name);
  };

  const handleCancelPick = () => {
    setPicked(null);
    setName('');
  };

  const handleSave = async () => {
    setError('');
    if (!name.trim() || !picked) return;
    setSaving(true);
    try {
      await createTestFile({
        name: name.trim(),
        // Persist whatever the user renamed it to in the Name field above —
        // file_name is what's actually shown/used everywhere else (Flow
        // editor's file picker, saved step data), so a rename here needs to
        // stick, not just live in the otherwise-unused `name` column.
        file_name: name.trim(),
        mime_type: picked.file.type || 'application/octet-stream',
        data: picked.data,
      });
      setName('');
      setPicked(null);
      load();
      showToast(`Test file "${name.trim()}" added successfully.`);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  };

  const startRename = (f) => {
    setError('');
    setRenamingId(f.id);
    setRenameValue(f.file_name);
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameValue('');
  };

  const submitRename = async (f) => {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === f.file_name) {
      cancelRename();
      return;
    }
    setError('');
    try {
      await updateTestFile(f.id, { file_name: trimmed });
      cancelRename();
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const [previewingId, setPreviewingId] = useState(null);

  const handlePreview = async (f) => {
    // Open the tab synchronously (before the await below) so it's still
    // tied to this click's user gesture — opening it only after the fetch
    // resolves gets silently blocked as a popup by most browsers.
    const win = window.open('', '_blank');
    setPreviewingId(f.id);
    setError('');
    try {
      const full = await getTestFile(f.id);
      const byteChars = atob(full.data);
      const bytes = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
      const blob = new Blob([bytes], { type: full.mime_type || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      if (win) {
        win.location.href = url;
      } else {
        showToast('Preview tab was blocked by the browser — allow pop-ups for this site and try again.', 'error');
      }
      // Revoked well after the new tab has had time to load the blob — the
      // URL only needs to live long enough for that one navigation.
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      if (win) win.close();
      setError(err.response?.data?.error || err.message);
    } finally {
      setPreviewingId(null);
    }
  };

  const handleDelete = async (f) => {
    if (!(await confirm(`Delete test file "${f.file_name}"? Steps that already picked it keep their own copy of the data.`))) return;
    setError('');
    try {
      await deleteTestFile(f.id);
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const handleDrop = async (targetId) => {
    const fromId = draggedId;
    setDraggedId(null);
    setDragOverId(null);
    if (!fromId || fromId === targetId) return;

    const fromIdx = files.findIndex((f) => f.id === fromId);
    const toIdx = files.findIndex((f) => f.id === targetId);
    if (fromIdx === -1 || toIdx === -1) return;

    const reordered = [...files];
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);
    setFiles(reordered);

    try {
      await reorderTestFiles(reordered.map((f) => f.id));
    } catch (err) {
      setError(err.response?.data?.error || err.message);
      load();
    }
  };

  return (
    <div>
      <p className="subtitle" style={{ marginBottom: 12 }}>
        Reusable files for a Flow step's form-data "File" fields — save a normal sample once, plus edge cases like a
        wrong-format or oversized file, then pick any of them from the step editor instead of using the file picker
        every time. Picking one copies its data into that step; editing/deleting a library entry later doesn't affect
        steps that already picked it.
      </p>

      {error && <div className="card error-text">{error}</div>}

      <div className="card">
        <h4>Add Test File</h4>
        {picked ? (
          <>
            <div className="toolbar">
              <input
                placeholder="Name (e.g. Normal PDF, Corrupt File)"
                value={name}
                onChange={(e) => setName(e.target.value)}
                style={{ flex: 1 }}
              />
              <FilePicker label="Choose File" fileName={picked.file.name} onFileSelect={handlePick} hideFileName />
            </div>
            <p className="hint" style={{ marginTop: 8, fontSize: 12.5 }}>
              {picked.file.name} · {formatBytes(Math.round((picked.data.length * 3) / 4))}
            </p>
            <div className="toolbar" style={{ marginTop: 12 }}>
              <button className="btn-primary" onClick={handleSave} disabled={!name.trim() || saving}>
                {saving ? 'Saving...' : 'Add'}
              </button>
              <button onClick={handleCancelPick} disabled={saving}>Cancel</button>
            </div>
          </>
        ) : (
          <div className="toolbar" style={{ justifyContent: 'center' }}>
            <FilePicker label="Choose File" onFileSelect={handlePick} hideFileName />
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table style={{ tableLayout: 'fixed' }}>
          <thead>
            <tr>
              <th style={{ width: 32 }}></th>
              <th style={{ width: 360 }}>File</th>
              <th style={{ width: 120, textAlign: 'center' }}>Size</th>
              <th></th>
              <th style={{ width: 80 }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr
                key={f.id}
                draggable={renamingId !== f.id}
                onDragStart={() => setDraggedId(f.id)}
                onDragOver={(e) => { e.preventDefault(); if (dragOverId !== f.id) setDragOverId(f.id); }}
                onDragLeave={() => setDragOverId((id) => (id === f.id ? null : id))}
                onDrop={() => handleDrop(f.id)}
                onDragEnd={() => { setDraggedId(null); setDragOverId(null); }}
                style={{
                  opacity: draggedId === f.id ? 0.4 : 1,
                  borderTop: dragOverId === f.id && draggedId !== f.id ? '2px solid var(--accent)' : undefined,
                }}
              >
                <td className="hint" style={{ cursor: 'grab' }} title="Drag to reorder">
                  <GripIcon />
                </td>
                <td className="mono" style={{ fontSize: 12.5 }}>
                  {renamingId === f.id ? (
                    <div className="toolbar" style={{ flexWrap: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') submitRename(f);
                          if (e.key === 'Escape') cancelRename();
                        }}
                        style={{ flex: 1, minWidth: 0 }}
                      />
                      <button className="btn-quiet" onClick={() => submitRename(f)} disabled={!renameValue.trim()}>✓</button>
                      <button className="btn-quiet" onClick={cancelRename}>✕</button>
                    </div>
                  ) : (
                    <span
                      className="truncate"
                      style={{ maxWidth: '100%', cursor: 'pointer' }}
                      title={`${f.file_name} — click to preview`}
                      onClick={() => handlePreview(f)}
                    >
                      {f.file_name}
                    </span>
                  )}
                </td>
                <td className="hint" style={{ textAlign: 'center' }}>{formatBytes(Number(f.approx_bytes))}</td>
                <td></td>
                <td className="row-actions">
                  <span className="row-actions-inner">
                    <OptionsMenu
                      items={[
                        { label: previewingId === f.id ? 'Opening...' : 'Preview', icon: <EyeIcon />, onClick: () => handlePreview(f), disabled: previewingId === f.id },
                        { label: 'Edit', icon: <EditIcon />, onClick: () => startRename(f) },
                        { label: 'Delete', icon: <TrashIcon />, onClick: () => handleDelete(f), danger: true },
                      ]}
                    />
                  </span>
                </td>
              </tr>
            ))}
            {files.length === 0 && <tr><td colSpan={5} className="empty-state">No test files yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
