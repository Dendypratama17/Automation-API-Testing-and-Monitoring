import React, { useEffect, useRef, useState } from 'react';
import {
  getFolders, createFolder, updateFolder, deleteFolder,
  getEndpoints, updateEndpoint, deleteEndpoint, duplicateEndpoint, reorderEndpoints,
  getEnvironments, getAuthCredentials, runStressTest,
} from '../api/client';
import KeyValueEditor, { objectToRows, rowsToObject } from '../components/KeyValueEditor.jsx';
import FormDataEditor, { objectToFormRows, formRowsToObject } from '../components/FormDataEditor.jsx';
import Environments from './Environments.jsx';
import Authorization from './Authorization.jsx';
import DefaultHeaders from './DefaultHeaders.jsx';
import TestFiles from './TestFiles.jsx';
import Notifications from './Notifications.jsx';
import FolderTree from '../components/FolderTree.jsx';
import JsonBlock from '../components/JsonBlock.jsx';
import JsonPasteEditor from '../components/JsonPasteEditor.jsx';

// Same idea as the Dashboard's Resource column: show just the path, not the
// {{base_url}} placeholder, so it stays compact and reads the same way.
function resourcePath(template) {
  return template.replace(/^\{\{base_url\}\}/, '') || '/';
}
import { TrashIcon, EditIcon, GripIcon, FolderIcon, CopyIcon, ZapIcon } from '../components/icons.jsx';
import OptionsMenu from '../components/OptionsMenu.jsx';
import { flattenFolders, folderOptionLabel } from '../utils/folderTree.js';
import { groupByEnv } from '../utils/envBadge.js';
import { useConfirm } from '../components/ConfirmProvider.jsx';
import { useToast } from '../components/ToastProvider.jsx';
import { loadSelectedFolder, saveSelectedFolder, hasStoredFolder } from '../utils/persistedFolder.js';

const STRESS_MAX_TOTAL_REQUESTS = 500;
const STRESS_MAX_CONCURRENCY = 50;

function endpointToForm(ep) {
  return {
    id: ep.id,
    name: ep.name,
    method: ep.method,
    path_template: ep.path_template,
    folder_id: ep.folder_id,
    headersRows: objectToRows(ep.headers),
    bodyType: ep.body_type || 'json',
    bodyText: JSON.stringify(ep.body_template || {}, null, 2),
    bodyRows: objectToFormRows(ep.body_template),
    tags: ep.tags || [],
  };
}

export default function Endpoints() {
  const confirm = useConfirm();
  const showToast = useToast();
  const [tab, setTab] = useState('endpoints'); // 'endpoints' | 'environments' | 'authorization' | 'default-headers' | 'test-files' | 'notifications'
  const [folders, setFolders] = useState([]);
  const [selectedFolderId, setSelectedFolderId] = useState(() => loadSelectedFolder('qa-tool:config-selected-folder')); // 'all' | 'null' | number
  const [endpoints, setEndpoints] = useState([]);
  const [editing, setEditing] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [error, setError] = useState('');
  const [draggedId, setDraggedId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);

  // Stress Test panel — a separate concern from the edit/view panels above,
  // so it can stay open independently of them.
  const [environments, setEnvironments] = useState([]);
  const [authCredentials, setAuthCredentials] = useState([]);
  const [stressTarget, setStressTarget] = useState(null); // the endpoint being tested
  const [stressForm, setStressForm] = useState({ environment_id: '', auth_credential_id: '', total_requests: 20, concurrency: 5 });
  const [stressRunning, setStressRunning] = useState(false);
  const [stressResult, setStressResult] = useState(null);
  const [stressError, setStressError] = useState('');

  const loadFolders = () => getFolders('endpoint').then(setFolders);
  // Guards against out-of-order responses — React.StrictMode double-invokes
  // effects on mount (so two requests can be in flight at once), and rapidly
  // switching folders fires a new request before the previous one resolves.
  // Whichever response arrives last otherwise wins even if it's the stale
  // one, so only apply a response if nothing newer has been requested since.
  const loadEndpointsRequestId = useRef(0);
  const loadEndpoints = (folderId) => {
    const params = {};
    if (folderId === 'null') params.folder_id = 'null';
    else if (typeof folderId === 'number') params.folder_id = folderId;
    const requestId = ++loadEndpointsRequestId.current;
    getEndpoints(params).then((data) => {
      if (requestId === loadEndpointsRequestId.current) setEndpoints(data);
    });
  };

  useEffect(() => {
    loadFolders();
    getEnvironments().then(setEnvironments);
    getAuthCredentials().then(setAuthCredentials);
  }, []);

  const openStressTest = (ep) => {
    setViewing(null);
    setEditing(null);
    setStressTarget(ep);
    setStressResult(null);
    setStressError('');
  };

  const handleRunStressTest = async (confirmProd = false) => {
    setStressError('');
    const total = Number(stressForm.total_requests);
    const conc = Number(stressForm.concurrency);
    if (!stressForm.environment_id) { setStressError('Pick an environment first.'); return; }
    if (!Number.isInteger(total) || total < 1 || total > STRESS_MAX_TOTAL_REQUESTS) {
      setStressError(`Total requests must be a whole number between 1 and ${STRESS_MAX_TOTAL_REQUESTS}.`);
      return;
    }
    if (!Number.isInteger(conc) || conc < 1 || conc > STRESS_MAX_CONCURRENCY) {
      setStressError(`Concurrency must be a whole number between 1 and ${STRESS_MAX_CONCURRENCY}.`);
      return;
    }
    if (conc > total) { setStressError('Concurrency cannot exceed total requests.'); return; }

    setStressRunning(true);
    setStressResult(null);
    try {
      const result = await runStressTest({
        endpoint_id: stressTarget.id,
        environment_id: Number(stressForm.environment_id),
        auth_credential_id: stressForm.auth_credential_id ? Number(stressForm.auth_credential_id) : null,
        total_requests: total,
        concurrency: conc,
        confirm_prod: confirmProd,
      });
      setStressResult(result);
    } catch (err) {
      if (err.response?.status === 412) {
        if (await confirm(err.response.data.message + ' Continue?')) {
          await handleRunStressTest(true);
          return;
        }
      } else {
        setStressError(err.response?.data?.error || err.message);
      }
    } finally {
      setStressRunning(false);
    }
  };

  // Default to the oldest top-level folder (the very first one ever
  // created) instead of "All Endpoints" — only for a first-ever visit (no
  // folder choice persisted yet), so it never overrides a previously
  // restored or user-picked folder on later mounts (e.g. after switching menus).
  const didAutoSelectFolder = useRef(false);
  useEffect(() => {
    if (didAutoSelectFolder.current || folders.length === 0) return;
    didAutoSelectFolder.current = true;
    if (hasStoredFolder('qa-tool:config-selected-folder')) return;
    const rootFolders = folders.filter((f) => (f.parent_id ?? null) === null);
    if (rootFolders.length === 0) return;
    const oldest = rootFolders.reduce((a, b) => (a.id < b.id ? a : b));
    setSelectedFolderId(oldest.id);
    saveSelectedFolder('qa-tool:config-selected-folder', oldest.id);
  }, [folders]);

  useEffect(() => {
    loadEndpoints(selectedFolderId === 'all' ? undefined : selectedFolderId);
  }, [selectedFolderId]);

  const refreshList = () => loadEndpoints(selectedFolderId === 'all' ? undefined : selectedFolderId);

  const handleCreateFolder = async (name, parentId) => {
    await createFolder({ kind: 'endpoint', name, parent_id: parentId });
    loadFolders();
  };

  const handleRenameFolder = async (id, name) => {
    const folder = folders.find((f) => f.id === id);
    await updateFolder(id, { name, parent_id: folder?.parent_id ?? null });
    loadFolders();
  };

  const handleDeleteFolder = async (id) => {
    if (await confirm('Delete this folder? Any subfolders inside it are deleted too, and endpoints inside become uncategorized.')) {
      await deleteFolder(id);
      loadFolders();
      if (selectedFolderId === id) {
        setSelectedFolderId('all');
        saveSelectedFolder('qa-tool:config-selected-folder', 'all');
      }
    }
  };

  const openEndpoint = (ep) => {
    setError('');
    setViewing(null);
    setEditing(endpointToForm(ep));
  };

  // Read-only detail view — clicking a row shows this (nothing editable);
  // the Edit button on the row opens the actual editable form above.
  const openEndpointDetail = (ep) => {
    setError('');
    setEditing(null);
    setViewing(ep);
  };

  const handleSave = async () => {
    setError('');
    try {
      const headers = rowsToObject(editing.headersRows);
      let body_template;
      if (editing.bodyType === 'form-data') {
        body_template = formRowsToObject(editing.bodyRows);
      } else {
        body_template = editing.bodyText.trim() ? JSON.parse(editing.bodyText) : {};
      }
      await updateEndpoint(editing.id, {
        name: editing.name,
        method: editing.method,
        path_template: editing.path_template,
        folder_id: editing.folder_id,
        headers,
        body_template,
        body_type: editing.bodyType,
        tags: editing.tags || [],
      });
      setEditing(null);
      refreshList();
    } catch (err) {
      setError(err.message.includes('JSON') ? 'Body JSON is invalid' : (err.response?.data?.error || err.message));
    }
  };

  const handleDelete = async (id) => {
    if (await confirm('Delete this endpoint? Flow steps using it will lose their reference.')) {
      await deleteEndpoint(id);
      if (editing?.id === id) setEditing(null);
      if (viewing?.id === id) setViewing(null);
      refreshList();
    }
  };

  const handleDuplicate = async (id) => {
    await duplicateEndpoint(id);
    refreshList();
  };

  // Moves an endpoint into a different folder from the list's Options menu —
  // reuses the row's already-loaded fields (GET /endpoints returns everything
  // PUT needs) so this doesn't require a separate fetch first.
  const handleMoveEndpoint = async (ep, folderId) => {
    await updateEndpoint(ep.id, {
      name: ep.name,
      method: ep.method,
      path_template: ep.path_template,
      headers: ep.headers,
      body_template: ep.body_template,
      body_type: ep.body_type,
      tags: ep.tags || [],
      folder_id: folderId,
    });
    refreshList();
  };

  // Reorders the currently-displayed list optimistically, then persists —
  // reload on failure so the UI doesn't drift from what's actually saved.
  const handleDrop = async (targetId) => {
    const fromId = draggedId;
    setDraggedId(null);
    setDragOverId(null);
    if (!fromId || fromId === targetId) return;

    const fromIdx = endpoints.findIndex((e) => e.id === fromId);
    const toIdx = endpoints.findIndex((e) => e.id === targetId);
    if (fromIdx === -1 || toIdx === -1) return;

    const reordered = [...endpoints];
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);
    setEndpoints(reordered);

    try {
      await reorderEndpoints(reordered.map((e) => e.id));
    } catch (err) {
      setError(err.response?.data?.error || err.message);
      refreshList();
    }
  };

  return (
    <div>
      <div className="page-header">
        <h3>Config</h3>
        <p>Endpoints used as Flow steps, the environments they run against, and saved auth credentials.</p>
      </div>

      <div className="toolbar" style={{ marginBottom: 16 }}>
        <button className={tab === 'endpoints' ? 'btn-primary' : ''} onClick={() => setTab('endpoints')}>Endpoints</button>
        <button className={tab === 'environments' ? 'btn-primary' : ''} onClick={() => setTab('environments')}>Environments</button>
        <button className={tab === 'authorization' ? 'btn-primary' : ''} onClick={() => setTab('authorization')}>Authorization</button>
        <button className={tab === 'default-headers' ? 'btn-primary' : ''} onClick={() => setTab('default-headers')}>Default Headers</button>
        <button className={tab === 'test-files' ? 'btn-primary' : ''} onClick={() => setTab('test-files')}>Test Files</button>
        <button className={tab === 'notifications' ? 'btn-primary' : ''} onClick={() => setTab('notifications')}>Notifications</button>
      </div>

      {tab === 'environments' ? (
        <Environments />
      ) : tab === 'authorization' ? (
        <Authorization />
      ) : tab === 'default-headers' ? (
        <DefaultHeaders />
      ) : tab === 'test-files' ? (
        <TestFiles />
      ) : tab === 'notifications' ? (
        <Notifications />
      ) : (
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <div className="card" style={{ width: 240, flexShrink: 0 }}>
          <h4>Folder</h4>
          <FolderTree
            folders={folders}
            selectedFolderId={selectedFolderId}
            onSelect={(folderId) => { setSelectedFolderId(folderId); saveSelectedFolder('qa-tool:config-selected-folder', folderId); setViewing(null); }}
            onCreateFolder={handleCreateFolder}
            onDeleteFolder={handleDeleteFolder}
            onRenameFolder={handleRenameFolder}
            allLabel="All Endpoints"
          />
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="card" style={{ padding: 0 }}>
            <div className="table-scroll-x">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 32 }}></th>
                  <th style={{ width: 220 }}>Name</th>
                  <th style={{ width: 80 }}>Method</th>
                  <th style={{ width: 220 }}>Resource</th>
                  <th style={{ width: 60 }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {endpoints.map((ep) => (
                  <tr
                    key={ep.id}
                    onClick={() => openEndpointDetail(ep)}
                    style={{
                      cursor: 'pointer',
                      opacity: draggedId === ep.id ? 0.4 : 1,
                      borderTop: dragOverId === ep.id && draggedId !== ep.id ? '2px solid var(--accent)' : undefined,
                    }}
                    title="Click to view detail"
                    draggable
                    onDragStart={() => setDraggedId(ep.id)}
                    onDragOver={(e) => { e.preventDefault(); if (dragOverId !== ep.id) setDragOverId(ep.id); }}
                    onDragLeave={() => setDragOverId((id) => (id === ep.id ? null : id))}
                    onDrop={() => handleDrop(ep.id)}
                    onDragEnd={() => { setDraggedId(null); setDragOverId(null); }}
                  >
                    <td className="hint" style={{ cursor: 'grab' }} onClick={(e) => e.stopPropagation()} title="Drag to reorder">
                      <GripIcon />
                    </td>
                    <td title={ep.name}><span className="truncate" style={{ maxWidth: '100%' }}>{ep.name}</span></td>
                    <td className="mono">{ep.method}</td>
                    <td className="mono" style={{ fontSize: 12 }} title={ep.path_template}>
                      <span className="truncate" style={{ maxWidth: '100%' }}>{resourcePath(ep.path_template)}</span>
                    </td>
                    <td className="row-actions" onClick={(e) => e.stopPropagation()}>
                      <span className="row-actions-inner">
                        <OptionsMenu
                          items={[
                            { label: 'Edit', icon: <EditIcon />, onClick: () => openEndpoint(ep) },
                            { label: 'Duplicate', icon: <CopyIcon />, onClick: () => handleDuplicate(ep.id) },
                            { label: 'Stress Test', icon: <ZapIcon />, onClick: () => openStressTest(ep) },
                            {
                              label: 'Move to Folder',
                              icon: <FolderIcon />,
                              submenu: [
                                { label: 'No Folder', onClick: () => handleMoveEndpoint(ep, null) },
                                ...flattenFolders(folders).map((f) => ({
                                  label: folderOptionLabel(f),
                                  onClick: () => handleMoveEndpoint(ep, f.id),
                                })),
                              ],
                            },
                            { label: 'Delete', icon: <TrashIcon />, onClick: () => handleDelete(ep.id), danger: true, divider: true },
                          ]}
                        />
                      </span>
                    </td>
                  </tr>
                ))}
                {endpoints.length === 0 && (
                  <tr><td colSpan={5} className="empty-state">No endpoints yet. Import from the "Import" menu.</td></tr>
                )}
              </tbody>
            </table>
            </div>
          </div>

          {error && <div className="card error-text">{error}</div>}

          {viewing && (
            <div className="card">
              <div className="card-row">
                <h4 style={{ margin: 0 }}>{viewing.method} {viewing.name}</h4>
                <button className="btn-quiet" onClick={() => setViewing(null)}>✕ Close</button>
              </div>
              <div className="mono hint" style={{ fontSize: 12, marginTop: 8 }}>{viewing.path_template}</div>

              <div style={{ marginTop: 16 }}>
                <span className="field-label">Headers</span>
                <JsonBlock value={viewing.headers} />
              </div>

              {viewing.body_template != null && Object.keys(viewing.body_template).length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <span className="field-label">Body ({viewing.body_type || 'json'})</span>
                  <JsonBlock value={viewing.body_template} />
                </div>
              )}
            </div>
          )}

          {stressTarget && (
            <div className="card">
              <div className="card-row">
                <h4 style={{ margin: 0 }}>Stress Test: {stressTarget.method} {stressTarget.name}</h4>
                <button className="btn-quiet" onClick={() => setStressTarget(null)}>✕ Close</button>
              </div>
              <p className="hint" style={{ marginTop: 4, fontSize: 12.5 }}>
                Fires real requests at this endpoint — {STRESS_MAX_TOTAL_REQUESTS} requests / {STRESS_MAX_CONCURRENCY} concurrency max.
              </p>

              <div className="toolbar" style={{ marginTop: 12, flexWrap: 'wrap' }}>
                <select
                  value={stressForm.environment_id}
                  onChange={(e) => setStressForm({ ...stressForm, environment_id: e.target.value })}
                  disabled={stressRunning}
                >
                  <option value="">Select environment</option>
                  {environments.map((env) => <option key={env.id} value={env.id}>{env.name}</option>)}
                </select>
                <select
                  value={stressForm.auth_credential_id}
                  onChange={(e) => setStressForm({ ...stressForm, auth_credential_id: e.target.value })}
                  disabled={stressRunning}
                  title="Optional — every request authenticates as this credential."
                >
                  <option value="">No Authorization</option>
                  {groupByEnv(authCredentials, (c) => c.environment_name).map((group) => (
                    <optgroup key={group.key} label={group.key}>
                      {group.items.map((c) => (
                        <option key={c.id} value={c.id}>{c.name} ({c.type === 'web_login' ? 'Web Login' : 'Basic Auth'})</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  Total requests
                  <input
                    type="number"
                    min={1}
                    max={STRESS_MAX_TOTAL_REQUESTS}
                    value={stressForm.total_requests}
                    onChange={(e) => setStressForm({ ...stressForm, total_requests: e.target.value })}
                    disabled={stressRunning}
                    style={{ width: 80 }}
                  />
                </label>
                <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  Concurrency
                  <input
                    type="number"
                    min={1}
                    max={STRESS_MAX_CONCURRENCY}
                    value={stressForm.concurrency}
                    onChange={(e) => setStressForm({ ...stressForm, concurrency: e.target.value })}
                    disabled={stressRunning}
                    style={{ width: 70 }}
                  />
                </label>
                <button className="btn-primary" onClick={() => handleRunStressTest()} disabled={stressRunning}>
                  {stressRunning ? 'Running...' : 'Run Stress Test'}
                </button>
              </div>

              {stressError && <div className="error-text" style={{ marginTop: 12 }}>{stressError}</div>}

              {stressResult && (
                <div style={{ marginTop: 16 }}>
                  <div className="toolbar" style={{ flexWrap: 'wrap', gap: 20 }}>
                    <span>
                      <span className={`badge ${stressResult.fail_count === 0 ? 'pass' : 'fail'}`}>
                        {stressResult.pass_count}/{stressResult.total_requests} passed
                      </span>
                    </span>
                    <span className="hint">Avg: <b style={{ color: 'var(--text)' }}>{stressResult.avg_ms}ms</b></span>
                    <span className="hint">Min: <b style={{ color: 'var(--text)' }}>{stressResult.min_ms}ms</b></span>
                    <span className="hint">Max: <b style={{ color: 'var(--text)' }}>{stressResult.max_ms}ms</b></span>
                    <span className="hint">p95: <b style={{ color: 'var(--text)' }}>{stressResult.p95_ms}ms</b></span>
                    <span className="hint">Throughput: <b style={{ color: 'var(--text)' }}>{stressResult.requests_per_sec} req/s</b></span>
                  </div>

                  <div style={{ marginTop: 12 }}>
                    <span className="field-label">Status Codes</span>
                    <div className="toolbar" style={{ gap: 8, marginTop: 4 }}>
                      {Object.entries(stressResult.status_counts).map(([status, count]) => (
                        <span key={status} className={`badge ${status === 'ERROR' || Number(status) >= 400 ? 'fail' : 'pass'}`}>
                          {status}: {count}
                        </span>
                      ))}
                    </div>
                  </div>

                  {stressResult.error_samples.length > 0 && (
                    <div style={{ marginTop: 12 }}>
                      <span className="field-label">Sample Errors</span>
                      <div className="stack" style={{ gap: 4, marginTop: 4 }}>
                        {stressResult.error_samples.map((msg, i) => (
                          <div key={i} className="error-text" style={{ fontSize: 12.5 }}>{msg}</div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {editing && (
            <div className="card">
              <h4>Edit Endpoint</h4>
              <div className="toolbar" style={{ marginBottom: 8 }}>
                <input
                  placeholder="Name"
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  style={{ flex: 1 }}
                />
                <select value={editing.method} onChange={(e) => setEditing({ ...editing, method: e.target.value })}>
                  {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <input
                placeholder="Path template, e.g. {{base_url}}/users/1"
                value={editing.path_template}
                onChange={(e) => setEditing({ ...editing, path_template: e.target.value })}
                className="mono"
                style={{ width: '100%', marginBottom: 8 }}
              />
              <select
                value={editing.folder_id ?? ''}
                onChange={(e) => setEditing({ ...editing, folder_id: e.target.value ? Number(e.target.value) : null })}
                style={{ marginBottom: 16 }}
              >
                <option value="">No Folder</option>
                {flattenFolders(folders).map((f) => <option key={f.id} value={f.id}>{folderOptionLabel(f)}</option>)}
              </select>

              <span className="field-label">Headers</span>
              <KeyValueEditor
                rows={editing.headersRows}
                onChange={(rows) => setEditing({ ...editing, headersRows: rows })}
              />

              <div className="card-row" style={{ marginTop: 16 }}>
                <span className="field-label" style={{ margin: 0 }}>Body</span>
                <div className="toolbar">
                  <button
                    className={editing.bodyType === 'json' ? 'btn-primary' : ''}
                    onClick={() => setEditing({ ...editing, bodyType: 'json' })}
                  >
                    JSON
                  </button>
                  <button
                    className={editing.bodyType === 'form-data' ? 'btn-primary' : ''}
                    onClick={() => setEditing({ ...editing, bodyType: 'form-data' })}
                  >
                    Form Data
                  </button>
                </div>
              </div>

              {editing.bodyType === 'form-data' ? (
                <FormDataEditor
                  rows={editing.bodyRows}
                  onChange={(rows) => setEditing({ ...editing, bodyRows: rows })}
                />
              ) : (
                <JsonPasteEditor
                  value={editing.bodyText}
                  onChange={(text) => setEditing({ ...editing, bodyText: text })}
                  height={360}
                />
              )}

              <div className="toolbar" style={{ marginTop: 16 }}>
                <button className="btn-primary" onClick={handleSave}>Save</button>
                <button onClick={() => setEditing(null)}>Close</button>
              </div>
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}
