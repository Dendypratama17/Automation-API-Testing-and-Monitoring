import React, { useEffect, useState } from 'react';
import { getAuthCredentials, createAuthCredential, updateAuthCredential, deleteAuthCredential, reorderAuthCredentials, testAuthCredentialLogin, revealAuthCredentialPassword, getEnvironments } from '../api/client';
import { TrashIcon, EditIcon, GripIcon, EyeIcon, EyeOffIcon } from '../components/icons.jsx';
import { useConfirm } from '../components/ConfirmProvider.jsx';
import OptionsMenu from '../components/OptionsMenu.jsx';
import { useToast } from '../components/ToastProvider.jsx';
import { groupByEnv } from '../utils/envBadge.js';

const emptyForm = { name: '', type: 'basic', username: '', password: '', login_url: '', environment_id: '' };

export default function Authorization() {
  const confirm = useConfirm();
  const showToast = useToast();
  const [credentials, setCredentials] = useState([]);
  const [environments, setEnvironments] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState('');
  const [draggedId, setDraggedId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);
  const [testingId, setTestingId] = useState(null);
  // Password stays masked until its PIN is entered — see revealPassword.
  // Once revealed for a row, it stays visible (re-hide doesn't need the PIN
  // again) until the page is reloaded.
  const [pinPromptId, setPinPromptId] = useState(null);
  const [pinValue, setPinValue] = useState('');
  const [revealedPasswords, setRevealedPasswords] = useState({});

  const load = () => getAuthCredentials().then(setCredentials);
  useEffect(() => {
    load();
    getEnvironments().then(setEnvironments).catch(() => {});
  }, []);

  const startEdit = (cred) => {
    setError('');
    setEditingId(cred.id);
    setForm({
      name: cred.name,
      type: cred.type || 'basic',
      username: cred.username,
      // The server never sends the password back — left blank means "keep
      // the current one" (see handleSubmit / the PUT route).
      password: '',
      login_url: cred.login_url || '',
      environment_id: cred.environment_id || '',
    });
  };

  const handleTestLogin = async (cred) => {
    setTestingId(cred.id);
    setError('');
    try {
      const result = await testAuthCredentialLogin(cred.id);
      showToast(`Login OK — token retrieved (expires ${result.expires || 'unknown'}).`);
    } catch (err) {
      showToast(err.response?.data?.detail || err.response?.data?.error || err.message, 'error');
    } finally {
      setTestingId(null);
    }
  };

  const startPinPrompt = (credId) => {
    setPinPromptId(credId);
    setPinValue('');
  };
  const cancelPinPrompt = () => {
    setPinPromptId(null);
    setPinValue('');
  };
  const submitPin = async (cred) => {
    try {
      const { password } = await revealAuthCredentialPassword(cred.id, pinValue);
      setRevealedPasswords((prev) => ({ ...prev, [cred.id]: password }));
    } catch (err) {
      showToast(err.response?.data?.error || err.message, 'error');
    } finally {
      setPinPromptId(null);
      setPinValue('');
    }
  };
  const hidePassword = (credId) => {
    setRevealedPasswords((prev) => {
      const next = { ...prev };
      delete next[credId];
      return next;
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm(emptyForm);
  };

  const handleSubmit = async () => {
    setError('');
    try {
      const payload = { ...form, environment_id: form.environment_id ? Number(form.environment_id) : null };
      if (editingId) await updateAuthCredential(editingId, payload);
      else {
        await createAuthCredential(payload);
        showToast(`Credential "${form.name}" added successfully.`);
      }
      setEditingId(null);
      setForm(emptyForm);
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const handleDelete = async (cred) => {
    if (!(await confirm(`Delete credential "${cred.name}"? Flow steps using it will fall back to no auth.`))) return;
    setError('');
    try {
      await deleteAuthCredential(cred.id);
      if (editingId === cred.id) cancelEdit();
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

    const fromIdx = credentials.findIndex((c) => c.id === fromId);
    const toIdx = credentials.findIndex((c) => c.id === targetId);
    if (fromIdx === -1 || toIdx === -1) return;

    const reordered = [...credentials];
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);
    setCredentials(reordered);

    try {
      await reorderAuthCredentials(reordered.map((c) => c.id));
    } catch (err) {
      setError(err.response?.data?.error || err.message);
      load();
    }
  };

  return (
    <div>
      <p className="subtitle" style={{ marginBottom: 12 }}>
        Saved credentials — selectable from any step in the Flows editor. Basic Auth sends username/password as a
        Basic header; Web Login actually logs into a real site each run and sends back the fresh session token as a Bearer header.
      </p>

      {error && <div className="card error-text">{error}</div>}

      <div className="card">
        <h4>{editingId ? 'Edit Credential' : 'Add Credential'}</h4>
        <div className="toolbar">
          <input placeholder="Name (e.g. QA Basic Auth)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            <option value="basic">Basic Auth</option>
            <option value="web_login">Web Login</option>
          </select>
          {form.type === 'web_login' && (
            <input
              placeholder="Login URL (e.g. https://stg-oauth2.privypass.id/)"
              value={form.login_url}
              onChange={(e) => setForm({ ...form, login_url: e.target.value })}
              style={{ minWidth: 260 }}
            />
          )}
          <input
            placeholder={form.type === 'web_login' ? 'PrivyID' : 'Username'}
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
          />
          <input
            placeholder={editingId ? 'Leave blank to keep current password' : 'Password'}
            type="password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            style={editingId ? { minWidth: 220 } : undefined}
          />
          <select value={form.environment_id} onChange={(e) => setForm({ ...form, environment_id: e.target.value })}>
            <option value="">Select Env</option>
            {environments.map((env) => <option key={env.id} value={env.id}>{env.name}</option>)}
          </select>
          <button
            className="btn-primary"
            onClick={handleSubmit}
            disabled={!form.name || !form.username || (!editingId && !form.password) || (form.type === 'web_login' && !form.login_url) || !form.environment_id}
          >
            {editingId ? 'Save' : 'Add'}
          </button>
          {editingId && <button onClick={cancelEdit}>Cancel</button>}
        </div>
      </div>

      {/* overflow-x hidden — a revealed password or the PIN input can be
          marginally wider than its column; clip it instead of letting a
          horizontal scrollbar appear and shift the rest of the layout. */}
      <div className="card" style={{ padding: 0, overflowX: 'hidden' }}>
        <table>
          <thead>
            <tr>
              <th style={{ width: 32 }}></th>
              <th style={{ width: 180 }}>Name</th>
              <th style={{ width: 120 }}>Type</th>
              <th>Username</th>
              <th>Password</th>
              <th style={{ width: 170 }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {groupByEnv(credentials, (c) => c.environment_name).map((group) => (
              <React.Fragment key={group.key}>
                <tr>
                  <td colSpan={6} className="table-group-header">{group.key}</td>
                </tr>
                {group.items.map((cred) => (
                  <tr
                    key={cred.id}
                    draggable
                    onDragStart={() => setDraggedId(cred.id)}
                    onDragOver={(e) => { e.preventDefault(); if (dragOverId !== cred.id) setDragOverId(cred.id); }}
                    onDragLeave={() => setDragOverId((id) => (id === cred.id ? null : id))}
                    onDrop={() => handleDrop(cred.id)}
                    onDragEnd={() => { setDraggedId(null); setDragOverId(null); }}
                    style={{
                      background: editingId === cred.id ? 'var(--surface-2)' : undefined,
                      opacity: draggedId === cred.id ? 0.4 : 1,
                      borderTop: dragOverId === cred.id && draggedId !== cred.id ? '2px solid var(--accent)' : undefined,
                    }}
                  >
                    <td className="hint" style={{ cursor: 'grab' }} title="Drag to reorder">
                      <GripIcon />
                    </td>
                    <td>{cred.name}</td>
                    <td>
                      <span className="badge neutral">{cred.type === 'web_login' ? 'Web Login' : 'Basic Auth'}</span>
                    </td>
                    <td className="mono">{cred.username}</td>
                    <td className="mono">
                      {revealedPasswords[cred.id] !== undefined ? (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                          {/* draggable=false + stopping the row's dragstart — the row
                              itself is draggable (for reordering), which otherwise
                              hijacks a click-drag here into a row-drag instead of a
                              normal text selection, making the value uncopyable. */}
                          <span
                            title={revealedPasswords[cred.id]}
                            draggable={false}
                            onDragStart={(e) => e.preventDefault()}
                            onMouseDown={(e) => e.stopPropagation()}
                            style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, userSelect: 'text', cursor: 'text' }}
                          >
                            {revealedPasswords[cred.id]}
                          </span>
                          <button className="btn-icon" onClick={() => hidePassword(cred.id)} title="Hide password" aria-label="Hide password" style={{ flexShrink: 0 }}>
                            <EyeOffIcon />
                          </button>
                        </span>
                      ) : pinPromptId === cred.id ? (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }} onClick={(e) => e.stopPropagation()}>
                          {/* Padding trimmed to match the height of a .btn-icon button
                              (the default input padding is noticeably taller) — so this
                              row doesn't grow past its normal height and throw off the
                              border line / Action column alignment for just this row. */}
                          <input
                            type="password"
                            autoFocus
                            placeholder="PIN"
                            value={pinValue}
                            onChange={(e) => setPinValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') submitPin(cred);
                              if (e.key === 'Escape') cancelPinPrompt();
                            }}
                            style={{ width: 70, padding: '4px 8px' }}
                          />
                          <button className="btn-icon" onClick={() => submitPin(cred)} title="Confirm PIN" aria-label="Confirm PIN">
                            <EyeIcon />
                          </button>
                          <button className="btn-quiet" onClick={cancelPinPrompt}>✕</button>
                        </span>
                      ) : (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          ••••••••
                          <button className="btn-icon" onClick={() => startPinPrompt(cred.id)} title="View password (PIN required)" aria-label="View password">
                            <EyeIcon />
                          </button>
                        </span>
                      )}
                    </td>
                    <td className="row-actions">
                      <OptionsMenu
                        items={[
                          ...(cred.type === 'web_login'
                            ? [{ label: testingId === cred.id ? 'Testing...' : 'Test Login', onClick: () => handleTestLogin(cred), disabled: testingId === cred.id }]
                            : []),
                          { label: 'Edit', icon: <EditIcon />, onClick: () => startEdit(cred) },
                          { label: 'Delete', icon: <TrashIcon />, onClick: () => handleDelete(cred), danger: true },
                        ]}
                      />
                    </td>
                  </tr>
                ))}
              </React.Fragment>
            ))}
            {credentials.length === 0 && <tr><td colSpan={6} className="empty-state">No saved credentials yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
