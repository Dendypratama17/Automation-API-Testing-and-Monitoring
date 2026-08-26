import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  computeJsonDiff, saveJsonDiff, updateSavedJsonDiff, getSavedJsonDiffs, getSavedJsonDiff, deleteSavedJsonDiff,
  renameSavedJsonDiff, moveSavedJsonDiff, sendDocumentToTelegram, getFolders, createFolder, updateFolder, deleteFolder,
} from '../api/client';
import JsonDiffView from '../components/JsonDiffView.jsx';
import JsonPasteEditor from '../components/JsonPasteEditor.jsx';
import FolderTree from '../components/FolderTree.jsx';
import OptionsMenu from '../components/OptionsMenu.jsx';
import { computeLineDiff } from '../utils/jsonTextHighlight.js';
import { TrashIcon, EditIcon, DownloadIcon, SendIcon, ChevronIcon, FolderIcon } from '../components/icons.jsx';
import { useConfirm } from '../components/ConfirmProvider.jsx';
import { useToast } from '../components/ToastProvider.jsx';
import { readJsonDiffDraft, writeJsonDiffDraft } from '../utils/jsonDiffDraft.js';
import { exportJsonDiffPdf, getJsonDiffPdfBase64 } from '../utils/exportJsonDiffPdf.js';
import { flattenFolders, folderOptionLabel } from '../utils/folderTree.js';
import { loadSelectedFolder, saveSelectedFolder } from '../utils/persistedFolder.js';

// A styled portal dropdown for "Load from saved" — one row per saved
// comparison, with its "A" and "B" picks as two side-by-side buttons (a
// native <select>'s <option>s can only ever stack vertically, which is why
// this isn't just a <select>).
function SavedJsonPicker({ savedList, onPick }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const wrapRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e) => {
      if (
        wrapRef.current && !wrapRef.current.contains(e.target)
        && listRef.current && !listRef.current.contains(e.target)
      ) setOpen(false);
    };
    const handleScroll = (e) => {
      if (listRef.current && listRef.current.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleScroll);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleScroll);
    };
  }, [open]);

  const openList = () => {
    if (!wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const width = Math.max(rect.width, 280);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 12));
    setPos({ top: rect.bottom + 4, left, width });
    setOpen(true);
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        className="btn-quiet"
        style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 4 }}
        onClick={() => (open ? setOpen(false) : openList())}
      >
        Load from saved
        <ChevronIcon style={{ transform: 'rotate(90deg)', width: 12, height: 12 }} />
      </button>
      {open && pos && createPortal(
        <div ref={listRef} className="cred-select-list" style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width }}>
          {savedList.length === 0 && <div className="hint" style={{ padding: '8px 10px', fontSize: 12.5 }}>Nothing saved yet.</div>}
          {savedList.map((s) => (
            <div key={s.id} className="cred-select-item" style={{ cursor: 'default' }}>
              <span
                className="cred-select-item-label"
                title={s.name || `Comparison #${s.id}`}
                style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {s.name || `Comparison #${s.id}`}
              </span>
              <button
                type="button"
                className="btn-quiet"
                style={{ flexShrink: 0, border: '1px solid var(--border)', borderRadius: 6, padding: '3px 9px' }}
                onClick={() => { setOpen(false); onPick(s.id, 'A'); }}
              >
                A
              </button>
              <button
                type="button"
                className="btn-quiet"
                style={{ flexShrink: 0, border: '1px solid var(--border)', borderRadius: 6, padding: '3px 9px' }}
                onClick={() => { setOpen(false); onPick(s.id, 'B'); }}
              >
                B
              </button>
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}

function formatDateTime(dateStr) {
  const d = new Date(dateStr);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `${day}/${month}/${d.getFullYear()}, ${time}`;
}

export default function JsonDiff() {
  const confirm = useConfirm();
  const showToast = useToast();
  const draft = readJsonDiffDraft();

  const [jsonAText, setJsonAText] = useState(draft.jsonAText || '');
  const [jsonBText, setJsonBText] = useState(draft.jsonBText || '');
  const [error, setError] = useState('');
  const [diffs, setDiffs] = useState(draft.diffs ?? null);
  const [comparing, setComparing] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saving, setSaving] = useState(false);

  const [savedList, setSavedList] = useState([]);
  const [loadedId, setLoadedId] = useState(draft.loadedId ?? null);
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [locked, setLocked] = useState(draft.locked || false);
  const [exportingId, setExportingId] = useState(null);
  // A Set (not a single id) — sharing comparison #1 shouldn't have its
  // in-flight state clobbered/cleared by a second, overlapping share of #2.
  const [sharingIds, setSharingIds] = useState(() => new Set());

  const [folders, setFolders] = useState([]);
  const [selectedFolderId, setSelectedFolderId] = useState(() => loadSelectedFolder('qa-tool:json-diff-selected-folder')); // 'all' | 'null' | number
  const loadFolders = () => getFolders('json_diff').then(setFolders);
  useEffect(() => { loadFolders(); }, []);

  const loadSavedList = () => {
    const params = {};
    if (selectedFolderId === 'null') params.folder_id = 'null';
    else if (typeof selectedFolderId === 'number') params.folder_id = selectedFolderId;
    getSavedJsonDiffs(params).then(setSavedList);
  };
  useEffect(() => { loadSavedList(); }, [selectedFolderId]);

  useEffect(() => {
    writeJsonDiffDraft({ jsonAText, jsonBText, diffs, locked, loadedId });
  }, [jsonAText, jsonBText, diffs, locked, loadedId]);

  // Quick raw-line highlight inside the paste boxes themselves — live as you
  // type/paste, independent of the structural (ignore-paths-aware) diff
  // below.
  const { unmatchedA, unmatchedB, missingA, missingB } = useMemo(
    () => computeLineDiff(jsonAText.split('\n'), jsonBText.split('\n')),
    [jsonAText, jsonBText]
  );

  // Recomputes the structural diff automatically a moment after typing
  // stops — no explicit "Compare" click needed. Only while editable: once
  // locked the text can't change, so there's nothing new to react to until
  // Edit is clicked. A parse failure mid-edit (e.g. an unclosed brace) is
  // expected and silently skipped rather than surfaced as an error — only
  // the manual Lock action reports a parse error, since that's an explicit
  // "I'm done" action.
  useEffect(() => {
    if (locked) return;
    if (!jsonAText.trim() || !jsonBText.trim()) {
      setDiffs(null);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      let jsonA;
      let jsonB;
      try {
        jsonA = JSON.parse(jsonAText);
        jsonB = JSON.parse(jsonBText);
      } catch {
        return;
      }
      setComparing(true);
      try {
        const result = await computeJsonDiff({ json_a: jsonA, json_b: jsonB, ignore_paths: [] });
        if (!cancelled) setDiffs(result.diffs);
      } catch {
        // transient/network error on a background auto-compare — ignored,
        // the next keystroke (or the manual Lock click) will retry.
      } finally {
        if (!cancelled) setComparing(false);
      }
    }, 450);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [jsonAText, jsonBText, locked]);

  const handleLock = async () => {
    setError('');
    // loadedId is intentionally left alone here — re-locking after editing a
    // loaded saved comparison should still let "Update" target that same
    // record, not silently forget which one was open.
    let jsonA;
    let jsonB;
    try {
      jsonA = JSON.parse(jsonAText);
    } catch {
      setError('JSON A is not valid JSON.');
      return;
    }
    try {
      jsonB = JSON.parse(jsonBText);
    } catch {
      setError('JSON B is not valid JSON.');
      return;
    }
    setComparing(true);
    try {
      const result = await computeJsonDiff({ json_a: jsonA, json_b: jsonB, ignore_paths: [] });
      setDiffs(result.diffs);
      setLocked(true);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setComparing(false);
    }
  };

  // Blanks both panes to start a fresh comparison — otherwise, once a saved
  // comparison is loaded (or its content edited), there's no quick way back
  // to two empty boxes short of manually selecting-and-deleting each one.
  const handleClear = async () => {
    if ((jsonAText.trim() || jsonBText.trim()) && !(await confirm('Clear both JSON A and B? Anything not saved will be lost.'))) return;
    setJsonAText('');
    setJsonBText('');
    setDiffs(null);
    setError('');
    setLoadedId(null);
    setSaveName('');
    setLocked(false);
  };

  const handleUnlock = () => {
    setLocked(false);
    setDiffs(null);
    setError('');
    // loadedId kept — this is "edit the comparison I just opened", not
    // "start a brand new one". Explicitly cleared elsewhere (picking from
    // the "Load from saved" pickers mixes sides, so it's no longer "the"
    // saved pair) when that distinction actually matters.
  };

  // Overwrites the saved comparison currently open (loadedId) with whatever
  // JSON A/B now contain — the counterpart to handleSave below, which
  // always creates a separate new row instead.
  const handleUpdateSaved = async () => {
    if (!loadedId) return;
    setSaving(true);
    try {
      await updateSavedJsonDiff(loadedId, {
        name: saveName.trim() || null,
        json_a: JSON.parse(jsonAText),
        json_b: JSON.parse(jsonBText),
        ignore_paths: [],
        diffs,
      });
      showToast('Comparison updated.');
      loadSavedList();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveJsonDiff({
        name: saveName.trim() || null,
        json_a: JSON.parse(jsonAText),
        json_b: JSON.parse(jsonBText),
        ignore_paths: [],
        diffs,
        // Defaults into whichever folder is currently selected in the
        // sidebar — "All"/"No Folder" both mean uncategorized here.
        folder_id: typeof selectedFolderId === 'number' ? selectedFolderId : null,
      });
      showToast('Comparison saved.');
      setSaveName('');
      loadSavedList();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleExportSaved = async (id) => {
    setExportingId(id);
    try {
      const full = await getSavedJsonDiff(id);
      exportJsonDiffPdf(full);
    } catch (err) {
      showToast(err.response?.data?.error || err.message, 'error');
    } finally {
      setExportingId(null);
    }
  };

  const handleShareToTelegram = async (id, name) => {
    setSharingIds((prev) => new Set(prev).add(id));
    try {
      const full = await getSavedJsonDiff(id);
      const { base64, filename } = getJsonDiffPdfBase64(full);
      await sendDocumentToTelegram({
        filename,
        caption: `JSON Diff: ${name || `Comparison #${id}`}`,
        fileBase64: base64,
      });
      showToast('Sent to Telegram.');
    } catch (err) {
      showToast(err.response?.data?.error || err.message, 'error');
    } finally {
      setSharingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  // Loads just ONE side (A or B) of a saved comparison into a chosen pane —
  // unlike handleOpenSaved (which loads a saved pair together, locked), this
  // lets JSON A and JSON B each be picked from a different saved comparison
  // (or the same one, either side), so e.g. "Comparison #3's JSON A" can be
  // compared against "Comparison #7's JSON B". Not "the saved pair" anymore
  // once mixed this way, so it clears loadedId rather than pretending this
  // is still that saved comparison.
  const handleLoadFromSaved = async (pane, value) => {
    if (!value) return;
    const [idStr, side] = value.split(':');
    try {
      const saved = await getSavedJsonDiff(Number(idStr));
      const text = JSON.stringify(side === 'A' ? saved.json_a : saved.json_b, null, 2);
      if (pane === 'A') setJsonAText(text);
      else setJsonBText(text);
      setLoadedId(null);
      setError('');
    } catch (err) {
      showToast(err.response?.data?.error || err.message, 'error');
    }
  };

  const handleOpenSaved = async (id) => {
    const saved = await getSavedJsonDiff(id);
    setJsonAText(JSON.stringify(saved.json_a, null, 2));
    setJsonBText(JSON.stringify(saved.json_b, null, 2));
    setDiffs(saved.diffs);
    setError('');
    setLoadedId(id);
    setLocked(true);
    // Prefilled (not left blank) so "Update" re-sends the same name by
    // default unless the user actually edits this field — leaving it blank
    // would otherwise wipe the existing name the moment Update is clicked.
    setSaveName(saved.name || '');
  };

  const handleDeleteSaved = async (id) => {
    if (!(await confirm('Delete this saved comparison?'))) return;
    await deleteSavedJsonDiff(id);
    if (loadedId === id) setLoadedId(null);
    loadSavedList();
  };

  const handleCreateFolder = async (name, parentId) => {
    await createFolder({ kind: 'json_diff', name, parent_id: parentId });
    loadFolders();
  };

  const handleRenameFolder = async (id, name) => {
    const folder = folders.find((f) => f.id === id);
    await updateFolder(id, { name, parent_id: folder?.parent_id ?? null });
    loadFolders();
  };

  const handleDeleteFolder = async (id) => {
    if (await confirm('Delete this folder? Any subfolders inside it are deleted too, and comparisons inside become uncategorized.')) {
      await deleteFolder(id);
      loadFolders();
      if (selectedFolderId === id) {
        setSelectedFolderId('all');
        saveSelectedFolder('qa-tool:json-diff-selected-folder', 'all');
      }
    }
  };

  const handleMoveSaved = async (id, folderId) => {
    try {
      await moveSavedJsonDiff(id, folderId);
      loadSavedList();
    } catch (err) {
      showToast(err.response?.data?.error || err.message, 'error');
    }
  };

  const handleStartRename = (s) => {
    setRenamingId(s.id);
    setRenameValue(s.name || '');
  };

  const handleCancelRename = () => {
    setRenamingId(null);
    setRenameValue('');
  };

  const handleConfirmRename = async (id) => {
    setRenaming(true);
    try {
      await renameSavedJsonDiff(id, renameValue.trim());
      setRenamingId(null);
      setRenameValue('');
      await loadSavedList();
    } catch (err) {
      showToast(err.response?.data?.error || err.message, 'error');
    } finally {
      setRenaming(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <h3>JSON Diff</h3>
        <p>Paste any two JSON payloads to compare them — not tied to a saved Endpoint. Save a comparison to look at it again later.</p>
      </div>

      <div className="toolbar">
        {locked ? (
          <button onClick={handleUnlock}>Edit</button>
        ) : (
          <>
            <button className="btn-primary" onClick={handleLock} disabled={!jsonAText.trim() || !jsonBText.trim()}>
              Lock
            </button>
            {comparing && <span className="hint" style={{ fontSize: 12.5 }}>Comparing...</span>}
          </>
        )}
        {(jsonAText.trim() || jsonBText.trim()) && (
          <button className="btn-quiet" onClick={handleClear} title="Clear both JSON A and B to start a new comparison">
            Clear
          </button>
        )}
      </div>
      {error && <p className="hint" style={{ color: 'var(--fail)', fontSize: 12.5, marginTop: 8 }}>{error}</p>}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
        <div className="card">
          <div className="card-row" style={{ marginBottom: 0 }}>
            <span className="field-label" style={{ margin: 0 }}>JSON A</span>
            {!locked && savedList.length > 0 && (
              <SavedJsonPicker savedList={savedList} onPick={(id, side) => handleLoadFromSaved('A', `${id}:${side}`)} />
            )}
          </div>
          <div style={{ marginTop: 8 }}>
            <JsonPasteEditor
              value={jsonAText}
              onChange={setJsonAText}
              diffLineSet={unmatchedA}
              missingLineSet={missingA}
              placeholder="Paste the first JSON here..."
              height={560}
              readOnly={locked}
            />
          </div>
        </div>
        <div className="card">
          <div className="card-row" style={{ marginBottom: 0 }}>
            <span className="field-label" style={{ margin: 0 }}>JSON B</span>
            {!locked && savedList.length > 0 && (
              <SavedJsonPicker savedList={savedList} onPick={(id, side) => handleLoadFromSaved('B', `${id}:${side}`)} />
            )}
          </div>
          <div style={{ marginTop: 8 }}>
            <JsonPasteEditor
              value={jsonBText}
              onChange={setJsonBText}
              diffLineSet={unmatchedB}
              missingLineSet={missingB}
              placeholder="Paste the second JSON here..."
              height={560}
              readOnly={locked}
            />
          </div>
        </div>
      </div>

      {diffs && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-row">
            <span className="field-label" style={{ margin: 0 }}>
              {diffs.length === 0 ? 'No differences' : `${diffs.length} difference${diffs.length === 1 ? '' : 's'}`}
            </span>
            {/* Shown regardless of whether any differences were found — a
                confirmed "these two are identical" is still worth saving,
                not just an actual diff. */}
            <div className="toolbar">
              {loadedId && (
                <button className="btn-primary" onClick={handleUpdateSaved} disabled={saving} title="Overwrite the saved comparison this JSON came from">
                  {saving ? 'Saving...' : 'Update'}
                </button>
              )}
              <input
                placeholder="Name this comparison (optional)"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                style={{ width: 220 }}
              />
              <button className={loadedId ? undefined : 'btn-primary'} onClick={handleSave} disabled={saving} title={loadedId ? 'Save as a separate new comparison' : undefined}>
                {saving ? 'Saving...' : loadedId ? 'Save as New' : 'Save'}
              </button>
            </div>
          </div>
          <div style={{ marginTop: 10 }}>
            <JsonDiffView diffs={diffs} />
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', marginTop: 16 }}>
        <div className="card" style={{ width: 240, flexShrink: 0 }}>
          <h4>Folder</h4>
          <FolderTree
            folders={folders}
            selectedFolderId={selectedFolderId}
            onSelect={(folderId) => {
              setSelectedFolderId(folderId);
              saveSelectedFolder('qa-tool:json-diff-selected-folder', folderId);
            }}
            onCreateFolder={handleCreateFolder}
            onDeleteFolder={handleDeleteFolder}
            onRenameFolder={handleRenameFolder}
            allLabel="All Comparisons"
          />
        </div>

        <div className="card" style={{ flex: 1, minWidth: 0 }}>
          <h4>Saved Comparisons</h4>
          {savedList.length === 0 && <p className="hint" style={{ fontSize: 12.5 }}>No saved comparisons here yet.</p>}
          <div className="stack" style={{ gap: 0 }}>
            {savedList.map((s, i) => (
              <div
                key={s.id}
                className="toolbar"
                style={{
                  cursor: renamingId === s.id ? 'default' : 'pointer',
                  padding: '10px',
                  borderRadius: 8,
                  borderTop: i > 0 ? '1px solid var(--border)' : undefined,
                  background: loadedId === s.id ? 'var(--surface-2)' : undefined,
                }}
                onClick={() => { if (renamingId !== s.id) handleOpenSaved(s.id); }}
              >
                {renamingId === s.id ? (
                  // Padding trimmed to match the height of the row's normal
                  // .btn-quiet icon buttons (the default input padding is
                  // noticeably taller) — otherwise a row being renamed grows
                  // past its normal height and throws off the border-line
                  // alignment against its neighbors, same class of bug as
                  // Authorization's PIN input had.
                  <input
                    autoFocus
                    className="mono"
                    value={renameValue}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleConfirmRename(s.id);
                      if (e.key === 'Escape') handleCancelRename();
                    }}
                    placeholder={`Comparison #${s.id}`}
                    style={{ flex: 1, fontSize: 13, padding: '4px 8px' }}
                  />
                ) : (
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{s.name || `Comparison #${s.id}`}</span>
                )}
                <span className="hint" style={{ fontSize: 12 }}>{formatDateTime(s.created_at)}</span>
                <span className="badge neutral">{s.diffs.length} diff{s.diffs.length === 1 ? '' : 's'}</span>
                {renamingId === s.id ? (
                  <div className="toolbar" style={{ marginLeft: 'auto' }} onClick={(e) => e.stopPropagation()}>
                    <button className="btn-primary" style={{ padding: '4px 10px' }} onClick={() => handleConfirmRename(s.id)} disabled={renaming}>
                      {renaming ? 'Saving...' : 'Save'}
                    </button>
                    <button className="btn-quiet" onClick={handleCancelRename}>Cancel</button>
                  </div>
                ) : (
                  <div className="toolbar" style={{ marginLeft: 'auto' }} onClick={(e) => e.stopPropagation()}>
                    <button
                      className="btn-quiet"
                      onClick={() => handleExportSaved(s.id)}
                      disabled={exportingId === s.id}
                      title="Export PDF"
                    >
                      <DownloadIcon />
                    </button>
                    <button
                      className="btn-quiet"
                      onClick={() => handleShareToTelegram(s.id, s.name)}
                      disabled={sharingIds.has(s.id)}
                      title="Share to Telegram"
                    >
                      <SendIcon />
                    </button>
                    <OptionsMenu
                      items={[
                        { label: 'Rename', icon: <EditIcon />, onClick: () => handleStartRename(s) },
                        {
                          label: 'Move to Folder',
                          icon: <FolderIcon />,
                          submenu: [
                            { label: 'No Folder', onClick: () => handleMoveSaved(s.id, null) },
                            ...flattenFolders(folders).map((f) => ({
                              label: folderOptionLabel(f),
                              onClick: () => handleMoveSaved(s.id, f.id),
                            })),
                          ],
                        },
                        { label: 'Delete', icon: <TrashIcon />, onClick: () => handleDeleteSaved(s.id), danger: true, divider: true },
                      ]}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
