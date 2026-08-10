import React, { useEffect, useState } from 'react';
import { getDefaultHeaders, createDefaultHeader, updateDefaultHeader, deleteDefaultHeader, reorderDefaultHeaders, getEnvironments } from '../api/client';
import { TrashIcon, EditIcon, GripIcon } from '../components/icons.jsx';
import { useConfirm } from '../components/ConfirmProvider.jsx';
import OptionsMenu from '../components/OptionsMenu.jsx';
import { useToast } from '../components/ToastProvider.jsx';

const emptyForm = { key: '', value: '', label: '', environment_id: '' };
const emptyValueForm = { value: '', label: '', environment_id: '' };

// Groups the flat (already sort_order-sorted) rows into one entry per key —
// each key gets one table row with all its values shown as chips, instead of
// a separate row per value.
function groupByKey(headers) {
  const groups = [];
  const indexByKey = new Map();
  for (const h of headers) {
    const lower = h.key.trim().toLowerCase();
    if (!indexByKey.has(lower)) {
      indexByKey.set(lower, groups.length);
      groups.push({ key: h.key, values: [h] });
    } else {
      groups[indexByKey.get(lower)].values.push(h);
    }
  }
  return groups;
}

export default function DefaultHeaders() {
  const confirm = useConfirm();
  const showToast = useToast();
  const [headers, setHeaders] = useState([]);
  const [environments, setEnvironments] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState('');
  const [draggedKey, setDraggedKey] = useState(null);
  const [dragOverKey, setDragOverKey] = useState(null);
  const [addingValueForKey, setAddingValueForKey] = useState(null);
  const [newValueForm, setNewValueForm] = useState(emptyValueForm);

  const load = () => getDefaultHeaders().then(setHeaders);
  useEffect(() => { load(); getEnvironments().then(setEnvironments); }, []);

  const startEdit = (h) => {
    setError('');
    setAddingValueForKey(null);
    setEditingId(h.id);
    setForm({ key: h.key, value: h.value, label: h.label || '', environment_id: h.environment_id || '' });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm(emptyForm);
  };

  const handleSubmit = async () => {
    setError('');
    try {
      if (editingId) await updateDefaultHeader(editingId, form);
      else {
        await createDefaultHeader(form);
        showToast(`Default header "${form.key}" added successfully.`);
      }
      setEditingId(null);
      setForm(emptyForm);
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const handleDelete = async (h) => {
    if (!(await confirm(`Delete "${h.value}" from "${h.key}"? Endpoints that already received this header will keep it.`))) return;
    setError('');
    try {
      await deleteDefaultHeader(h.id);
      if (editingId === h.id) cancelEdit();
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const groups = groupByKey(headers);

  // Reordering only happens at the key level — dragging a key's row moves
  // ALL of its values together as one block, keeping their own relative
  // order. Persists as the flattened id order, optimistic with reload-on-failure.
  const handleGroupDrop = async (targetKey) => {
    const fromKey = draggedKey;
    setDraggedKey(null);
    setDragOverKey(null);
    if (!fromKey || fromKey === targetKey) return;

    const fromIdx = groups.findIndex((g) => g.key === fromKey);
    const toIdx = groups.findIndex((g) => g.key === targetKey);
    if (fromIdx === -1 || toIdx === -1) return;

    const reorderedGroups = [...groups];
    const [moved] = reorderedGroups.splice(fromIdx, 1);
    reorderedGroups.splice(toIdx, 0, moved);
    const flatIds = reorderedGroups.flatMap((g) => g.values.map((v) => v.id));
    setHeaders(flatIds.map((id) => headers.find((h) => h.id === id)));

    try {
      await reorderDefaultHeaders(flatIds);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
      load();
    }
  };

  const startAddValue = (key) => {
    setError('');
    setEditingId(null);
    setAddingValueForKey(key);
    setNewValueForm(emptyValueForm);
  };
  const cancelAddValue = () => {
    setAddingValueForKey(null);
    setNewValueForm(emptyValueForm);
  };
  const confirmAddValue = async (key) => {
    if (!newValueForm.value.trim()) return;
    setError('');
    try {
      await createDefaultHeader({
        key,
        value: newValueForm.value.trim(),
        label: newValueForm.label.trim() || null,
        environment_id: newValueForm.environment_id || null,
      });
      setAddingValueForKey(null);
      setNewValueForm(emptyValueForm);
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  return (
    <div>
      <p className="subtitle" style={{ marginBottom: 12 }}>
        Headers automatically added to every endpoint (existing ones and new ones imported from cURL/Postman) —
        unless the endpoint already has a header with the same name, in which case the imported value always wins.
        Give a key multiple values with "+ Add value" below — all of them become that header's dropdown choices in
        the Flow step / Endpoint editors. Drag a key's row to reorder it relative to other keys. A value's Name/Env
        is optional — set it when a key (like X-Token) has one value per test account, so the dropdown shows which
        account/environment each value belongs to instead of just the raw string.
      </p>

      {error && <div className="card error-text">{error}</div>}

      <div className="card">
        <h4>{editingId ? 'Edit Default Header' : 'Add Default Header (new key)'}</h4>
        <div className="toolbar">
          <input placeholder="Key (e.g. X-Platform-Name)" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} />
          <input placeholder="Value (e.g. Web)" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} style={{ flex: 1 }} />
          <input placeholder="Name (optional, e.g. CHE7573)" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
          <select value={form.environment_id} onChange={(e) => setForm({ ...form, environment_id: e.target.value })}>
            <option value="">No Env</option>
            {environments.map((env) => <option key={env.id} value={env.id}>{env.name}</option>)}
          </select>
        </div>
        <div className="toolbar" style={{ marginTop: 12 }}>
          <button className="btn-primary" onClick={handleSubmit}>{editingId ? 'Save' : 'Add'}</button>
          {editingId && <button onClick={cancelEdit}>Cancel</button>}
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th style={{ width: 32 }}></th>
              <th style={{ width: 260 }}>Key</th>
              <th>Values</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <tr
                key={group.key}
                draggable
                onDragStart={() => setDraggedKey(group.key)}
                onDragOver={(e) => { e.preventDefault(); if (dragOverKey !== group.key) setDragOverKey(group.key); }}
                onDragLeave={() => setDragOverKey((k) => (k === group.key ? null : k))}
                onDrop={() => handleGroupDrop(group.key)}
                onDragEnd={() => { setDraggedKey(null); setDragOverKey(null); }}
                style={{
                  opacity: draggedKey === group.key ? 0.4 : 1,
                  borderTop: dragOverKey === group.key && draggedKey !== group.key ? '2px solid var(--accent)' : undefined,
                }}
              >
                <td className="hint" style={{ verticalAlign: 'top', paddingTop: 18, cursor: 'grab' }} title="Drag to reorder">
                  <GripIcon />
                </td>
                <td className="mono" style={{ verticalAlign: 'top', paddingTop: 14 }}>{group.key}</td>
                <td>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: '6px 0' }}>
                    {group.values.map((v) => (
                      <div
                        key={v.id}
                        className="value-chip"
                        style={{
                          display: 'flex', alignItems: 'center', gap: 4,
                          background: editingId === v.id ? 'var(--surface-2)' : 'var(--surface)',
                          border: '1px solid var(--border)',
                          borderRadius: 8, padding: '5px 4px 5px 8px',
                        }}
                      >
                        <span style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 6, maxWidth: 320 }}>
                          {v.label && (
                            <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                              {v.label}{v.environment_name ? ` (${v.environment_name})` : ''}
                            </span>
                          )}
                          <span
                            className="mono hint"
                            title={v.value}
                            style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          >
                            {v.value}
                          </span>
                        </span>
                        <span className="value-chip-options">
                          <OptionsMenu
                            items={[
                              { label: 'Edit', icon: <EditIcon />, onClick: () => startEdit(v) },
                              { label: 'Delete', icon: <TrashIcon />, onClick: () => handleDelete(v), danger: true },
                            ]}
                          />
                        </span>
                      </div>
                    ))}

                    {addingValueForKey === group.key ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <input
                          autoFocus
                          placeholder="New value"
                          value={newValueForm.value}
                          onChange={(e) => setNewValueForm({ ...newValueForm, value: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') confirmAddValue(group.key);
                            if (e.key === 'Escape') cancelAddValue();
                          }}
                          style={{ width: 160 }}
                        />
                        <input
                          placeholder="Name (optional)"
                          value={newValueForm.label}
                          onChange={(e) => setNewValueForm({ ...newValueForm, label: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') confirmAddValue(group.key);
                            if (e.key === 'Escape') cancelAddValue();
                          }}
                          style={{ width: 130 }}
                        />
                        <select
                          value={newValueForm.environment_id}
                          onChange={(e) => setNewValueForm({ ...newValueForm, environment_id: e.target.value })}
                        >
                          <option value="">No Env</option>
                          {environments.map((env) => <option key={env.id} value={env.id}>{env.name}</option>)}
                        </select>
                        <button className="btn-primary" onClick={() => confirmAddValue(group.key)}>Add</button>
                        <button onClick={cancelAddValue}>Cancel</button>
                      </div>
                    ) : (
                      <button className="btn-quiet" onClick={() => startAddValue(group.key)}>+ Add value</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {groups.length === 0 && <tr><td colSpan={3} className="empty-state">No default headers yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
