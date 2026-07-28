import React, { useEffect, useState } from 'react';
import { getEnvironments, createEnvironment, updateEnvironment, deleteEnvironment, reorderEnvironments } from '../api/client';
import { TrashIcon, EditIcon, GripIcon } from '../components/icons.jsx';
import { useConfirm } from '../components/ConfirmProvider.jsx';
import OptionsMenu from '../components/OptionsMenu.jsx';
import { useToast } from '../components/ToastProvider.jsx';

const emptyForm = { name: '', base_url: '', is_protected: false, variables: {} };

export default function Environments() {
  const confirm = useConfirm();
  const showToast = useToast();
  const [environments, setEnvironments] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState('');
  const [draggedId, setDraggedId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);

  const load = () => getEnvironments().then(setEnvironments);
  useEffect(() => { load(); }, []);

  const startEdit = (env) => {
    setError('');
    setEditingId(env.id);
    setForm({ name: env.name, base_url: env.base_url, is_protected: env.is_protected, variables: env.variables || {} });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm(emptyForm);
  };

  const handleSubmit = async () => {
    setError('');
    try {
      if (editingId) await updateEnvironment(editingId, form);
      else {
        await createEnvironment(form);
        showToast(`Environment "${form.name}" added successfully.`);
      }
      setEditingId(null);
      setForm(emptyForm);
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const handleDelete = async (env) => {
    const warning = env.is_protected
      ? `"${env.name}" is marked protected. Delete it?`
      : `Delete environment "${env.name}"?`;
    if (!(await confirm(warning))) return;

    setError('');
    try {
      await deleteEnvironment(env.id);
      if (editingId === env.id) cancelEdit();
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  // Reorders the list optimistically (so the drag feels instant), then
  // persists the new order — reload on failure so the UI doesn't drift from
  // what's actually saved.
  const handleDrop = async (targetId) => {
    const fromId = draggedId;
    setDraggedId(null);
    setDragOverId(null);
    if (!fromId || fromId === targetId) return;

    const fromIdx = environments.findIndex((e) => e.id === fromId);
    const toIdx = environments.findIndex((e) => e.id === targetId);
    if (fromIdx === -1 || toIdx === -1) return;

    const reordered = [...environments];
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);
    setEnvironments(reordered);

    try {
      await reorderEnvironments(reordered.map((e) => e.id));
    } catch (err) {
      setError(err.response?.data?.error || err.message);
      load();
    }
  };

  return (
    <div>
      <p className="subtitle" style={{ marginBottom: 12 }}>To import an Environment from Postman (.json) or a .env file, use the "Import" menu.</p>

      {error && <div className="card error-text">{error}</div>}

      <div className="card">
        <h4>{editingId ? 'Edit Environment' : 'Add Environment Manually'}</h4>
        <div className="toolbar">
          <input placeholder="Name (DEV/STG/PROD)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input placeholder="Base URL" value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} style={{ width: 320 }} />
          <label>
            <input type="checkbox" checked={form.is_protected} onChange={(e) => setForm({ ...form, is_protected: e.target.checked })} /> Protected
          </label>
          <button className="btn-primary" onClick={handleSubmit} disabled={!form.name || !form.base_url}>
            {editingId ? 'Save' : 'Add'}
          </button>
          {editingId && <button onClick={cancelEdit}>Cancel</button>}
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th style={{ width: 32 }}></th>
              <th style={{ width: 160 }}>Name</th>
              <th>Base URL</th>
              <th style={{ width: 100 }}>Protected</th>
              <th style={{ width: 170 }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {environments.map((env) => (
              <tr
                key={env.id}
                draggable
                onDragStart={() => setDraggedId(env.id)}
                onDragOver={(e) => { e.preventDefault(); if (dragOverId !== env.id) setDragOverId(env.id); }}
                onDragLeave={() => setDragOverId((id) => (id === env.id ? null : id))}
                onDrop={() => handleDrop(env.id)}
                onDragEnd={() => { setDraggedId(null); setDragOverId(null); }}
                style={{
                  background: editingId === env.id ? 'var(--surface-2)' : undefined,
                  opacity: draggedId === env.id ? 0.4 : 1,
                  borderTop: dragOverId === env.id && draggedId !== env.id ? '2px solid var(--accent)' : undefined,
                }}
              >
                <td className="hint" style={{ cursor: 'grab' }} title="Drag to reorder">
                  <GripIcon />
                </td>
                <td>{env.name}</td>
                <td className="mono" title={env.base_url}>
                  <span className="truncate" style={{ maxWidth: '100%' }}>{env.base_url}</span>
                </td>
                <td>{env.is_protected ? <span className="badge drift">Protected</span> : <span className="hint">No</span>}</td>
                <td className="row-actions">
                  <OptionsMenu
                    items={[
                      { label: 'Edit', icon: <EditIcon />, onClick: () => startEdit(env) },
                      { label: 'Delete', icon: <TrashIcon />, onClick: () => handleDelete(env), danger: true },
                    ]}
                  />
                </td>
              </tr>
            ))}
            {environments.length === 0 && <tr><td colSpan={5} className="empty-state">No environments yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
