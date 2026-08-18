import React, { useEffect, useMemo, useState } from 'react';
import { computeJsonDiff, saveJsonDiff, getSavedJsonDiffs, getSavedJsonDiff, deleteSavedJsonDiff, renameSavedJsonDiff, sendDocumentToTelegram } from '../api/client';
import JsonDiffView from '../components/JsonDiffView.jsx';
import JsonPasteEditor from '../components/JsonPasteEditor.jsx';
import { computeLineDiff } from '../utils/jsonTextHighlight.js';
import { TrashIcon, EditIcon, DownloadIcon, SendIcon } from '../components/icons.jsx';
import { useConfirm } from '../components/ConfirmProvider.jsx';
import { useToast } from '../components/ToastProvider.jsx';
import { readJsonDiffDraft, writeJsonDiffDraft } from '../utils/jsonDiffDraft.js';
import { exportJsonDiffPdf, getJsonDiffPdfBase64 } from '../utils/exportJsonDiffPdf.js';

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

  const loadSavedList = () => getSavedJsonDiffs().then(setSavedList);
  useEffect(() => { loadSavedList(); }, []);

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
    setLoadedId(null);
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

  const handleUnlock = () => {
    setLocked(false);
    setDiffs(null);
    setError('');
    setLoadedId(null);
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

  const handleOpenSaved = async (id) => {
    const saved = await getSavedJsonDiff(id);
    setJsonAText(JSON.stringify(saved.json_a, null, 2));
    setJsonBText(JSON.stringify(saved.json_b, null, 2));
    setDiffs(saved.diffs);
    setError('');
    setLoadedId(id);
    setLocked(true);
  };

  const handleDeleteSaved = async (id) => {
    if (!(await confirm('Delete this saved comparison?'))) return;
    await deleteSavedJsonDiff(id);
    if (loadedId === id) setLoadedId(null);
    loadSavedList();
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
      </div>
      {error && <p className="hint" style={{ color: 'var(--fail)', fontSize: 12.5, marginTop: 8 }}>{error}</p>}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
        <div className="card">
          <span className="field-label">JSON A</span>
          <div style={{ marginTop: 8 }}>
            <JsonPasteEditor
              value={jsonAText}
              onChange={setJsonAText}
              diffLineSet={unmatchedA}
              missingLineSet={missingA}
              placeholder="Paste the first JSON here..."
              height={600}
              readOnly={locked}
            />
          </div>
        </div>
        <div className="card">
          <span className="field-label">JSON B</span>
          <div style={{ marginTop: 8 }}>
            <JsonPasteEditor
              value={jsonBText}
              onChange={setJsonBText}
              diffLineSet={unmatchedB}
              missingLineSet={missingB}
              placeholder="Paste the second JSON here..."
              height={600}
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
              <input
                placeholder="Name this comparison (optional)"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                style={{ width: 220 }}
              />
              <button className="btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
          <div style={{ marginTop: 10 }}>
            <JsonDiffView diffs={diffs} />
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <h4>Saved Comparisons</h4>
        {savedList.length === 0 && <p className="hint" style={{ fontSize: 12.5 }}>No saved comparisons yet.</p>}
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
                  style={{ flex: 1, fontSize: 13 }}
                />
              ) : (
                <span style={{ fontWeight: 600, fontSize: 13 }}>{s.name || `Comparison #${s.id}`}</span>
              )}
              <span className="hint" style={{ fontSize: 12 }}>{formatDateTime(s.created_at)}</span>
              <span className="badge neutral">{s.diffs.length} diff{s.diffs.length === 1 ? '' : 's'}</span>
              {renamingId === s.id ? (
                <div className="toolbar" style={{ marginLeft: 'auto' }} onClick={(e) => e.stopPropagation()}>
                  <button className="btn-primary" onClick={() => handleConfirmRename(s.id)} disabled={renaming}>
                    {renaming ? 'Saving...' : 'Save'}
                  </button>
                  <button className="btn-quiet" onClick={handleCancelRename}>Cancel</button>
                </div>
              ) : (
                <div className="toolbar" style={{ marginLeft: 'auto' }}>
                  <button
                    className="btn-quiet"
                    onClick={(e) => { e.stopPropagation(); handleExportSaved(s.id); }}
                    disabled={exportingId === s.id}
                    title="Export PDF"
                  >
                    <DownloadIcon />
                  </button>
                  <button
                    className="btn-quiet"
                    onClick={(e) => { e.stopPropagation(); handleShareToTelegram(s.id, s.name); }}
                    disabled={sharingIds.has(s.id)}
                    title="Share to Telegram"
                  >
                    <SendIcon />
                  </button>
                  <button
                    className="btn-quiet"
                    onClick={(e) => { e.stopPropagation(); handleStartRename(s); }}
                    title="Rename"
                  >
                    <EditIcon />
                  </button>
                  <button
                    className="btn-quiet"
                    onClick={(e) => { e.stopPropagation(); handleDeleteSaved(s.id); }}
                    title="Delete"
                  >
                    <TrashIcon />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
