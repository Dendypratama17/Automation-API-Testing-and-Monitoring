import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  getFolders, createFolder, updateFolder, deleteFolder,
  getFlows, getFlow, createFlow, updateFlow, deleteFlow, duplicateFlow, reorderFlows,
  runFlow, cancelFlowRun, getRunProgress, batchRunFlows, runFlowStep, updateFlowStep, updateAllFlowSteps, getEndpoints, getEnvironments, getAuthCredentials, getDefaultHeaders,
  parseCurlForStep, sendDocumentToTelegram,
} from '../api/client';
import JsonBlock from '../components/JsonBlock.jsx';
import JsonPasteEditor from '../components/JsonPasteEditor.jsx';
import KeyValueEditor, { objectToRows, rowsToObject } from '../components/KeyValueEditor.jsx';
import FormDataEditor, { objectToFormRows, formRowsToObject, formRowsToBody, emptyFormRow } from '../components/FormDataEditor.jsx';
import { TrashIcon, EditIcon, PlayIcon, ChevronIcon, CopyIcon, GripIcon, FolderIcon, XIcon, CheckIcon, DownloadIcon, SendIcon, ZapIcon } from '../components/icons.jsx';
import FolderTree from '../components/FolderTree.jsx';
import FolderPillPicker from '../components/FolderPillPicker.jsx';
import AssertionsEditor, { objectToAssertionRows, assertionRowsToArray, emptyAssertionRow } from '../components/AssertionsEditor.jsx';
import ExtractVariableEditor, { arrayToExtractRows, extractRowsToArray } from '../components/ExtractVariableEditor.jsx';
import { useConfirm } from '../components/ConfirmProvider.jsx';
import { useToast } from '../components/ToastProvider.jsx';
import OptionsMenu from '../components/OptionsMenu.jsx';
import AuthorizationField from '../components/AuthorizationField.jsx';
import { describeAssertionParts } from '../utils/assertionDescriptions.js';
import AssertionStatusIcon from '../components/AssertionStatusIcon.jsx';
import { flattenFolders, folderOptionLabel } from '../utils/folderTree.js';
import { stripJsonComments } from '../utils/jsonComments.js';
import { exportRunResultToPdf, getRunResultPdfBase64, exportBatchRunResultToPdf, getBatchRunResultPdfBase64 } from '../utils/exportRunResultPdf.js';
import { exportRepeatCombinedToPdf, getRepeatCombinedPdfBase64 } from '../utils/exportRepeatSummaryPdf.js';
import { unwrapJsonStrings } from '../utils/unwrapJsonStrings.js';
import { loadSelectedFolder, saveSelectedFolder, hasStoredFolder } from '../utils/persistedFolder.js';
import ScrollToTopButton from '../components/ScrollToTopButton.jsx';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const BODY_METHODS = ['POST', 'PUT'];

// DD/MM/YYYY instead of the browser-locale-dependent default (often M/D/YYYY).
function formatDateTime(dateStr) {
  const d = new Date(dateStr);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `${day}/${month}/${d.getFullYear()}, ${time}`;
}

// { [flowId]: environmentId } — each flow remembers its own last-run
// environment across reloads, so running several flows against different
// environments doesn't mean re-picking one every time.
const FLOW_ENV_STORAGE_KEY = 'qa-tool:flow-env-by-id';
function loadFlowEnvMap() {
  try {
    return JSON.parse(localStorage.getItem(FLOW_ENV_STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

// Short synthesized chime when a run result comes back — no audio asset
// needed. An ascending two-note tone for PASS, a lower descending tone for
// FAIL/ERROR/SCHEMA_DRIFT.
function playRunResultSound(status) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const isPass = status === 'PASS';
    const notes = isPass ? [660, 880] : [440, 220];

    notes.forEach((freq, i) => {
      const start = ctx.currentTime + i * 0.12;
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = freq;
      gain.gain.setValueAtTime(0.001, start);
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.22);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.24);
    });

    setTimeout(() => ctx.close(), (notes.length * 0.12 + 0.3) * 1000);
  } catch {
    // audio isn't critical — never let it break the run flow
  }
}

// delay_ms is stored/sent in milliseconds, but the UI works in seconds —
// strips floating-point noise (e.g. 1500/1000 → "1.5", not "1.4999999...").
function formatDelaySeconds(ms) {
  return parseFloat((Number(ms) / 1000).toFixed(2));
}

// A base64 file blob would dump megabytes of text into the JSON textarea —
// same idea as the backend's sanitizeBodyForStorage, just for the live
// preview shown when switching from Form Data to the JSON tab.
function sanitizeBodyForPreview(body) {
  if (Array.isArray(body)) return body.map(sanitizeBodyForPreview);
  if (body && typeof body === 'object') {
    if (body.__file__) {
      const bytes = body.data ? Math.round((body.data.length * 3) / 4) : 0;
      return { __file__: true, name: body.name, mimeType: body.mimeType, data: `<${bytes} bytes omitted>` };
    }
    const out = {};
    for (const [k, v] of Object.entries(body)) out[k] = sanitizeBodyForPreview(v);
    return out;
  }
  return unwrapJsonStrings(body);
}

const ASSERTION_FAILURE_LABELS = {
  status_code: (a) => `Expected status ${a.expected}`,
  response_time: (a) => `Expected response time ≤ ${a.max_ms}ms`,
  field_exists: (a) => `Expected field "${a.path}" to exist`,
  field_not_null: (a) => `Expected field "${a.path}" to not be null`,
  field_equals: (a) => `Expected "${a.path}" to equal ${JSON.stringify(a.expected)}`,
  field_contains: (a) => `Expected "${a.path}" to contain "${a.expected}"`,
  field_matches: (a) => `Expected "${a.path}" to match /${a.pattern}/`,
  field_greater_than: (a) => `Expected "${a.path}" > ${a.expected}`,
  field_less_than: (a) => `Expected "${a.path}" < ${a.expected}`,
  array_length: (a) => `Expected "${a.path}" to have length ${a.expected}`,
  array_find_equals: (a) => `Expected "${a.path}" item where "${a.matchField}"=${JSON.stringify(a.matchValue)} to have "${a.checkField}"=${JSON.stringify(a.expected)}`,
  header_exists: (a) => `Expected header "${a.header}" to exist`,
  header_equals: (a) => `Expected header "${a.header}" to equal "${a.expected}"`,
  http_status: (a) => `Expected status ${a.expected}, got ${a.actual}`,
};

// error_message is either a JSON array of failed-assertion objects (see
// backend flowExecutor.checkAssertions) or a plain exception message string
// for ERROR steps — translate the former into plain English instead of
// dumping raw JSON in the UI.
function formatFailureReasons(errorMessage) {
  if (!errorMessage) return [];
  try {
    const parsed = JSON.parse(errorMessage);
    if (Array.isArray(parsed)) {
      return parsed.map((a) => (ASSERTION_FAILURE_LABELS[a.type] ? ASSERTION_FAILURE_LABELS[a.type](a) : JSON.stringify(a)));
    }
  } catch {
    // not JSON — fall through to plain text below
  }
  return [String(errorMessage)];
}

// Shared per-step result renderer — used by both the single-flow Run Result
// panel and the multi-flow Batch Run Result panel, so the two don't drift.
function StepResultRow({ step, isLast }) {
  const failureReasons = formatFailureReasons(step.error_message);
  const hasAssertionResults = Array.isArray(step.assertion_results) && step.assertion_results.length > 0;

  return (
    <div style={!isLast ? { borderBottom: '1px solid var(--border-soft)', paddingBottom: 20 } : undefined}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span className="step-number-badge">{step.step_order + 1}</span>
        <b>{step.name}</b>
        <span className={`badge ${step.status.toLowerCase()}`}>{step.status}</span>
      </div>
      <div className="mono hint" style={{ fontSize: 12, marginTop: 6 }}>
        {step.request_method} {step.request_url}
      </div>
      <div className="hint" style={{ display: 'flex', gap: 16, fontSize: 12.5, marginTop: 6, flexWrap: 'wrap' }}>
        <span>Status: {step.response_status_code ?? '-'}</span>
        <span>Duration: {step.response_time_ms}ms</span>
        {step.request_id && <span className="mono">Request ID: {step.request_id}</span>}
      </div>

      {hasAssertionResults ? (
        <div style={{ marginTop: 10 }}>
          <span className="field-label">Assertions</span>
          <div className="stack" style={{ gap: 4, marginTop: 4 }}>
            {step.assertion_results.map((a, i) => {
              const parts = describeAssertionParts(a);
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                  <AssertionStatusIcon passed={a.passed} />
                  <span>{parts.label}</span>
                  {parts.value !== '' && (
                    <span className="mono" style={{ color: 'var(--text-dim)', overflowWrap: 'anywhere' }}>{parts.value}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : failureReasons.length > 0 && (
        <div
          style={{
            marginTop: 10, padding: '8px 12px', borderRadius: 8,
            fontSize: 12.5,
            // A skip isn't a failure — the message just explains why this
            // step's request was never sent, so it gets the same neutral
            // styling as the SKIPPED badge instead of reading as an error.
            ...(step.status === 'SKIPPED'
              ? { background: 'var(--surface-2)', color: 'var(--text-muted)' }
              : { background: 'var(--fail-bg)', color: 'var(--fail)' }),
          }}
        >
          {failureReasons.map((reason, i) => <div key={i}>{reason}</div>)}
        </div>
      )}

      {Object.keys(step.extracted_variables || {}).length > 0 && (
        <div style={{ marginTop: 10 }}>
          <span className="field-label">Extracted Variables</span>
          <div className="stack" style={{ gap: 4, marginTop: 4 }}>
            {Object.entries(step.extracted_variables).map(([key, value]) => (
              <div key={key} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12.5 }}>
                <span className="mono badge neutral" style={{ flexShrink: 0 }}>{key}</span>
                <span className="mono" style={{ color: 'var(--text-dim)', overflowWrap: 'anywhere' }}>{String(value)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {step.request_headers != null && (
        <details style={{ marginTop: 10 }}>
          <summary className="field-label"><ChevronIcon className="chevron" />Headers</summary>
          <div style={{ marginTop: 8 }}>
            <JsonBlock value={step.request_headers} />
          </div>
        </details>
      )}

      {(step.request_body != null || step.response_body != null) && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 14 }}>
          <div style={{ minWidth: 0 }}>
            {step.request_body != null && (
              <>
                <span className="field-label">Request Body</span>
                <JsonBlock value={unwrapJsonStrings(step.request_body)} formData />
              </>
            )}
          </div>
          <div style={{ minWidth: 0 }}>
            {step.response_body != null && (
              <>
                <span className="field-label">Response Body</span>
                <JsonBlock value={unwrapJsonStrings(step.response_body)} />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// The per-flow-result list inside a Batch Run Result — factored out so the
// same rendering can also appear (once per pass) inside a repeated batch
// run's per-repeat expandable sections, without duplicating this mapping.
function BatchResultsList({ results }) {
  return (
    <div className="stack" style={{ gap: 24 }}>
      {results.map((r, fIdx) => (
        <div
          key={r.flow_id}
          style={fIdx < results.length - 1 ? { borderBottom: '2px solid var(--border)', paddingBottom: 24 } : undefined}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <b style={{ fontSize: 14.5 }}>{r.flow_name || `Flow #${r.flow_id}`}</b>
            {r.flow_run && <span className={`badge ${r.flow_run.status.toLowerCase()}`}>{r.flow_run.status}</span>}
            {r.error && <span className="badge fail">ERROR</span>}
          </div>
          {r.error && <div className="error-text" style={{ marginTop: 8, fontSize: 13 }}>{r.error}</div>}
          {r.steps && (
            <div className="stack" style={{ marginTop: 14, gap: 20 }}>
              {r.steps.map((s, idx) => (
                <StepResultRow key={s.step_order} step={s} isLast={idx === r.steps.length - 1} />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// Whether every flow in one batch-run pass actually passed — used to badge
// a repeat's own header PASS/FAIL without needing to expand it.
function batchPassAllFlows(result) {
  return !!result && result.results.every((r) => !r.error && r.flow_run?.status === 'PASS');
}

// Drops disabled header rows (stored as { __disabled__: true, value }, see
// KeyValueEditor.jsx) entirely from the read-only View Flow display — a
// header that won't actually be sent has no business appearing next to the
// ones that will.
function headersForDisplay(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (value && typeof value === 'object' && value.__disabled__) continue;
    out[key] = value;
  }
  return out;
}

// Reads/writes the step's raw "Authorization" header row directly — lets
// AuthorizationField's manual-input side live in the same headersRows/
// KeyValueEditor storage as every other header, instead of a separate field
// that Headers and Assertions would then need to know to also look at.
function getAuthHeaderValue(headersRows) {
  const row = headersRows.find((r) => r.key.trim().toLowerCase() === 'authorization');
  return row ? row.value : '';
}
function setAuthHeaderValue(headersRows, value) {
  const idx = headersRows.findIndex((r) => r.key.trim().toLowerCase() === 'authorization');
  if (idx === -1) {
    if (!value) return headersRows;
    return [...headersRows, { key: 'Authorization', value, enabled: true }];
  }
  const next = [...headersRows];
  next[idx] = { ...next[idx], value, enabled: true };
  return next;
}

// `defaultHeaders` comes from Config > Default Headers (see getDefaultHeaders)
// so a brand-new step always starts with whatever's configured there, instead
// of a hardcoded list that could silently drift out of sync with it. A key
// can have several rows there (its dropdown choices) — only seed one row per
// key here (the first/default value), since KeyValueEditor itself is what
// turns that single row into a dropdown of all the key's configured values.
const emptyStep = (defaultHeaders = []) => {
  const seenKeys = new Set();
  const headersRows = [];
  for (const h of defaultHeaders) {
    const lower = h.key.trim().toLowerCase();
    if (seenKeys.has(lower)) continue;
    seenKeys.add(lower);
    headersRows.push({ key: h.key, value: h.value, enabled: true });
  }
  return {
    name: '', endpoint_id: '', method: '', url_template: '', authCredentialId: '',
    headersRows,
    bodyType: 'json', bodyText: '', bodyRows: [emptyFormRow()],
    responseType: 'auto',
    extractRows: [], assertionsRows: [], enabled: true, delayMs: '',
    parallelWithPrevious: false,
    runConditionStatusCode: '',
  };
};

function stepToPayload(step, endpoints) {
  if (!step.endpoint_id && !step.url_template) {
    throw new Error(`Step "${step.name || '(unnamed)'}" hasn't selected an endpoint or pasted a curl command`);
  }
  const endpoint = step.endpoint_id ? endpoints.find((e) => e.id === Number(step.endpoint_id)) : null;
  const name = step.name.trim() || endpoint?.name || 'Untitled step';
  const headers = rowsToObject(step.headersRows);
  let body_template = null;
  if (BODY_METHODS.includes(step.method)) {
    if (step.bodyType === 'form-data') {
      body_template = formRowsToBody(step.bodyRows);
    } else {
      try { body_template = step.bodyText.trim() ? JSON.parse(stripJsonComments(step.bodyText)) : null; }
      catch { throw new Error(`Body in step "${step.name}" is not valid JSON`); }
    }
  }
  const extract = extractRowsToArray(step.extractRows);
  const assertions = assertionRowsToArray(step.assertionsRows);

  return {
    endpoint_id: step.endpoint_id ? Number(step.endpoint_id) : null,
    auth_credential_id: step.authCredentialId ? Number(step.authCredentialId) : null,
    name,
    method: step.method,
    url_template: step.url_template,
    headers,
    body_template,
    body_type: step.bodyType,
    // The raw editor text (// comments and all) — kept alongside the clean
    // parsed body_template purely so a commented-out line survives a
    // save/reload as disabled instead of being gone for good (see
    // jsonComments.js and stepFromApi below).
    body_text: step.bodyType === 'json' ? step.bodyText : null,
    response_type: step.responseType === 'base64' ? 'base64' : 'auto',
    extract,
    assertions,
    enabled: step.enabled !== false,
    delay_ms: step.delayMs ? Number(step.delayMs) : 0,
    parallel_with_previous: step.parallelWithPrevious === true,
    run_condition_status_code: step.runConditionStatusCode !== '' && step.runConditionStatusCode != null
      ? Number(step.runConditionStatusCode)
      : null,
  };
}

// Known environments sort first (in this fixed, meaningful order); anything
// else (a group key groupBy didn't recognize) is appended alphabetically
// after, rather than in whatever order it happened to appear in the list.
const ENV_GROUP_ORDER = ['DEV', 'STG', 'RC', 'PROD'];
function sortGroupKeys(keys) {
  return [...keys].sort((a, b) => {
    const ai = ENV_GROUP_ORDER.indexOf(a.toUpperCase());
    const bi = ENV_GROUP_ORDER.indexOf(b.toUpperCase());
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

// A styled, portal-based dropdown for one-off bulk-apply pickers (e.g. "Set
// X-Token" below) — matches the app's existing cred-select-list/-item look
// (see AuthorizationField/HeaderValueSelect) instead of a native <select>.
// Unlike those two, there's no text-input side: nothing here is ever typed,
// it's purely "pick one of these to apply to every step." An optional
// `groupBy` splits the list into labelled sections (e.g. one per
// environment) instead of one long mixed list — see "Select account" below.
function BulkSelectDropdown({ placeholder, options, onPick, renderOption, title, groupBy, extraTopAction }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  // Which environment tab is active — grouping is now a horizontal tab row
  // (see the groupBy branch below) instead of one long list with a plain
  // label per section, but the items under the active tab still stack
  // vertically same as before.
  const [activeGroup, setActiveGroup] = useState(null);
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
    // Closes on a page/ancestor scroll (the portal's position was computed
    // for where the trigger was at open-time, so it'd otherwise drift out of
    // place) — but NOT on scrolling inside the list itself, which is just
    // the user paging through a long option list and shouldn't dismiss it.
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
    const width = Math.max(rect.width, 320);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 12));
    // Selalu pilih sisi (atas/bawah) yang ruangnya lebih besar, bukan cuma
    // membuka ke atas kalau ruang bawah "kritis" sempit — supaya dropdown
    // selalu memakai ruang yang paling luas yang tersedia.
    const spaceBelow = window.innerHeight - rect.bottom - 12;
    const spaceAbove = rect.top - 12;
    const openUpward = spaceAbove > spaceBelow;
    const maxHeight = Math.max(160, Math.min(320, openUpward ? spaceAbove : spaceBelow));
    setPos(openUpward
      ? { bottom: window.innerHeight - rect.top + 4, left, width, maxHeight }
      : { top: rect.bottom + 4, left, width, maxHeight });
    setActiveGroup(null); // jatuh balik ke tab pertama tiap dibuka
    setOpen(true);
  };

  return (
    <div ref={wrapRef} className="cred-select-combo" style={{ position: 'relative', flex: 1, minWidth: 0 }}>
      <button
        type="button"
        className="cred-select-combo-input"
        style={{
          textAlign: 'left', width: '100%', cursor: 'pointer', color: 'var(--text-muted)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
        }}
        onClick={() => (open ? setOpen(false) : openList())}
        title={title}
      >
        <span>{placeholder}</span>
        <ChevronIcon style={{ transform: 'rotate(90deg)', flexShrink: 0, color: 'var(--text-dim)' }} />
      </button>
      {open && pos && createPortal(
        <div
          ref={listRef}
          className="cred-select-list"
          style={{
            position: 'fixed', top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width,
            maxHeight: pos.maxHeight, overflow: 'hidden',
          }}
        >
          {(() => {
            const groups = new Map();
            if (groupBy) {
              for (const opt of options) {
                const key = groupBy(opt) || 'Other';
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(opt);
              }
            }
            const keys = groupBy ? sortGroupKeys([...groups.keys()]) : [];
            const currentKey = activeGroup != null && groups.has(activeGroup) ? activeGroup : keys[0];
            const items = groupBy ? (groups.get(currentKey) || []) : options;
            return (
              <>
                {/* Search box (kalau ada) dan tab environment TIDAK ikut
                    scroll — cuma daftar item di bawahnya yang scroll. */}
                <div style={{ flexShrink: 0 }}>
                  {extraTopAction && (
                    <button
                      type="button"
                      className="cred-select-item"
                      style={{ borderBottom: '1px solid var(--border)', marginBottom: 4, paddingBottom: 10 }}
                      onClick={() => { setOpen(false); extraTopAction.onClick(); }}
                    >
                      <span className="cred-select-check"><CheckIcon style={{ visibility: 'hidden' }} /></span>
                      {extraTopAction.label}
                    </button>
                  )}
                  {groupBy && keys.length > 0 && (
                    <div className="folder-pill-tabs">
                      {keys.map((key) => (
                        <button
                          type="button"
                          key={key}
                          className={`folder-tab${key === currentKey ? ' active' : ''}`}
                          onClick={() => setActiveGroup(key)}
                        >
                          {key}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div style={{ overflowY: 'auto', flex: 1, overscrollBehavior: 'contain' }}>
                  {options.length === 0 && <div className="hint" style={{ padding: '8px 10px', fontSize: 12.5 }}>Nothing configured yet.</div>}
                  {items.map((opt, i) => (
                    <button type="button" key={i} className="cred-select-item" onClick={() => { setOpen(false); onPick(opt); }}>
                      <span className="cred-select-check"><CheckIcon style={{ visibility: 'hidden' }} /></span>
                      {renderOption(opt)}
                    </button>
                  ))}
                </div>
              </>
            );
          })()}
        </div>,
        document.body
      )}
    </div>
  );
}

function stepFromApi(s) {
  return {
    name: s.name,
    endpoint_id: s.endpoint_id || '',
    authCredentialId: s.auth_credential_id || '',
    method: s.method,
    url_template: s.url_template,
    headersRows: objectToRows(s.headers),
    bodyType: s.body_type || 'json',
    // Prefer the raw saved editor text (keeps any // commented-out lines
    // intact) — only fall back to reconstructing from body_template for a
    // step saved before body_text existed, or one that's never had a
    // comment toggled.
    bodyText: s.body_text != null ? s.body_text : (s.body_template ? JSON.stringify(s.body_template, null, 2) : ''),
    bodyRows: objectToFormRows(s.body_template),
    responseType: s.response_type === 'base64' ? 'base64' : 'auto',
    extractRows: arrayToExtractRows(s.extract),
    assertionsRows: objectToAssertionRows(s.assertions),
    enabled: s.enabled !== false,
    delayMs: s.delay_ms ? String(s.delay_ms) : '',
    parallelWithPrevious: s.parallel_with_previous === true,
    runConditionStatusCode: s.run_condition_status_code != null ? String(s.run_condition_status_code) : '',
  };
}

export default function Flows() {
  const confirm = useConfirm();
  const showToast = useToast();
  const [folders, setFolders] = useState([]);
  const [selectedFolderId, setSelectedFolderId] = useState(() => loadSelectedFolder('qa-tool:flows-selected-folder')); // 'all' | 'null' | number
  const [flows, setFlows] = useState([]);
  const [endpoints, setEndpoints] = useState([]);
  const [endpointFolders, setEndpointFolders] = useState([]);
  const [environments, setEnvironments] = useState([]);
  // Per-flow environment choice (Play button on a Flow List row, running a
  // single step from the View Flow panel, and Batch Run — which reuses each
  // selected flow's own row environment rather than a separate picker, so
  // they all have to agree) — persisted so each flow keeps running against
  // whichever environment it was last set to, even across a reload.
  const [flowEnvIds, setFlowEnvIds] = useState(loadFlowEnvMap);
  const setFlowEnv = (flowId, envId) => {
    setFlowEnvIds((prev) => {
      const next = { ...prev, [flowId]: envId };
      localStorage.setItem(FLOW_ENV_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  };
  const [authCredentials, setAuthCredentials] = useState([]);
  const [defaultHeaders, setDefaultHeaders] = useState([]);
  // Config > Default Headers entries for the "X-Token" key — offered in the
  // "Select x-token" bulk picker below so switching every step to a different
  // test account doesn't mean hand-editing each step's headers individually.
  const xTokenOptions = defaultHeaders.filter((h) => h.key.trim().toLowerCase() === 'x-token');

  // A credential picked from "Select account", awaiting the user's choice of
  // fill mode (empty steps only, or override every step) before it's
  // actually applied — see handleApplyAuthCredential below.
  const [pendingAuthCredential, setPendingAuthCredential] = useState(null);
  // Same idea as pendingAuthCredential, for a value picked from "Select x-token"
  // — see handleApplyXToken below.
  const [pendingXToken, setPendingXToken] = useState(null);
  const [editingFlow, setEditingFlow] = useState(null);
  // Cleared whenever the panel closes or switches to a different flow —
  // there are many close/switch call sites, so this catches all of them
  // uniformly instead of resetting it at each one individually.
  useEffect(() => { setPendingAuthCredential(null); setPendingXToken(null); }, [editingFlow?.id]);
  const [viewingFlow, setViewingFlow] = useState(null);
  const [expandedStep, setExpandedStep] = useState(0);
  const [stepErrors, setStepErrors] = useState({});
  const [curlPasteIdx, setCurlPasteIdx] = useState(null);
  const [curlPasteText, setCurlPasteText] = useState('');
  const [curlPasteError, setCurlPasteError] = useState('');
  const [curlPasteLoading, setCurlPasteLoading] = useState(false);
  const [error, setError] = useState('');
  const [runResult, setRunResult] = useState(null);
  const [sharingRunResult, setSharingRunResult] = useState(false);
  const [sharingBatchRunResult, setSharingBatchRunResult] = useState(false);
  const [sharingRepeatResults, setSharingRepeatResults] = useState(false);
  const [running, setRunning] = useState(false);
  const [runningFlowId, setRunningFlowId] = useState(null);
  const [runningToken, setRunningToken] = useState(null);
  // Batch Run shares runningToken with every flow in the batch — for
  // live-progress polling, and (see handleCancelRun) cancellation too. This
  // just distinguishes the "Running…" label/steps grouping from a single run.
  const [runningIsBatch, setRunningIsBatch] = useState(false);
  // Snapshotted at run-start (not read live off runParallel) so the Cancel
  // tooltip and any other in-progress messaging stay accurate even if the
  // toggle above gets flipped while this run is still going.
  const [runningParallel, setRunningParallel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [runningStepId, setRunningStepId] = useState(null);
  const [selectedFlowIds, setSelectedFlowIds] = useState(new Set());
  // Serial (default) chains each flow's extracted variables into the next —
  // parallel drops that chaining (there's no "previous flow" once they're
  // all in flight together) in exchange for wall-clock speed, so it's only
  // safe for a selection of flows that don't depend on each other's output.
  const [runParallel, setRunParallel] = useState(false);
  const [batchRunResult, setBatchRunResult] = useState(null);
  // How many times to run the whole selected batch back to back — editable
  // only while nothing is running. > 1 switches the result panel from a
  // single Batch Run Result to a per-repeat list (see repeatResults below);
  // left at the default 1, everything behaves exactly as before this
  // existed.
  const [repeatCount, setRepeatCount] = useState(1);
  // Snapshotted at run-start, same reasoning as runningParallel above — the
  // input is disabled while running anyway, but this keeps the "Repeat X of
  // N" progress label and the eventual result panel's title consistent even
  // if that couldn't happen today.
  const [runningRepeatCount, setRunningRepeatCount] = useState(1);
  const [repeatIndex, setRepeatIndex] = useState(0);
  // null while repeatCount was 1 for the run in progress/last finished —
  // an array of { result, error } (one per completed repeat) once it's > 1.
  const [repeatResults, setRepeatResults] = useState(null);
  const [expandedRepeatIdx, setExpandedRepeatIdx] = useState(null);
  // Cancel needs to stop the WHOLE repeat run, not just whichever single
  // iteration happens to be in flight — a ref (not state) because it's read
  // synchronously inside the run loop between iterations, not rendered.
  const repeatCancelledRef = useRef(false);
  const [draggedFlowId, setDraggedFlowId] = useState(null);
  const [dragOverFlowId, setDragOverFlowId] = useState(null);
  const [draggedStepIdx, setDraggedStepIdx] = useState(null);
  const [dragOverStepIdx, setDragOverStepIdx] = useState(null);
  const [draggedViewStepIdx, setDraggedViewStepIdx] = useState(null);
  const [dragOverViewStepIdx, setDragOverViewStepIdx] = useState(null);
  const [reorderingViewSteps, setReorderingViewSteps] = useState(false);
  // One DOM ref per step panel — lets Save Flow scroll straight to whichever
  // step failed validation instead of leaving the user to hunt for it.
  const stepRefs = useRef([]);

  const loadFolders = () => getFolders('flow').then(setFolders);
  // Guards against out-of-order responses — React.StrictMode double-invokes
  // effects on mount (so two requests can be in flight at once), and rapidly
  // switching folders fires a new request before the previous one resolves.
  // Whichever response arrives last otherwise wins even if it's the stale
  // one, so only apply a response if nothing newer has been requested since.
  const loadFlowsRequestId = useRef(0);
  const loadFlows = (folderId) => {
    const params = {};
    if (folderId === 'null') params.folder_id = 'null';
    else if (typeof folderId === 'number') params.folder_id = folderId;
    const requestId = ++loadFlowsRequestId.current;
    getFlows(params).then((data) => {
      if (requestId === loadFlowsRequestId.current) setFlows(data);
    });
  };

  // Default to the oldest top-level folder (the very first one ever
  // created) instead of "All Flows" — only for a first-ever visit (no folder
  // choice persisted yet), so it never overrides a previously restored or
  // user-picked folder on later mounts (e.g. after switching menus).
  const didAutoSelectFolder = useRef(false);
  useEffect(() => {
    if (didAutoSelectFolder.current || folders.length === 0) return;
    didAutoSelectFolder.current = true;
    if (hasStoredFolder('qa-tool:flows-selected-folder')) return;
    const rootFolders = folders.filter((f) => (f.parent_id ?? null) === null);
    if (rootFolders.length === 0) return;
    const oldest = rootFolders.reduce((a, b) => (a.id < b.id ? a : b));
    setSelectedFolderId(oldest.id);
    saveSelectedFolder('qa-tool:flows-selected-folder', oldest.id);
  }, [folders]);

  useEffect(() => {
    if (runResult) playRunResultSound(runResult.flow_run.status);
  }, [runResult]);

  useEffect(() => {
    if (!batchRunResult) return;
    const allPassed = batchRunResult.results.every((r) => !r.error && r.flow_run?.status === 'PASS');
    playRunResultSound(allPassed ? 'PASS' : 'FAIL');
  }, [batchRunResult]);

  useEffect(() => {
    loadFolders();
    getEndpoints().then(setEndpoints);
    getFolders('endpoint').then(setEndpointFolders);
    getEnvironments().then(setEnvironments);
    getAuthCredentials().then(setAuthCredentials);
    getDefaultHeaders().then(setDefaultHeaders);
  }, []);

  useEffect(() => {
    loadFlows(selectedFolderId === 'all' ? undefined : selectedFolderId);
  }, [selectedFolderId]);

  const handleCreateFolder = async (name, parentId) => {
    await createFolder({ kind: 'flow', name, parent_id: parentId });
    loadFolders();
  };

  const handleRenameFolder = async (id, name) => {
    const folder = folders.find((f) => f.id === id);
    await updateFolder(id, { name, parent_id: folder?.parent_id ?? null });
    loadFolders();
  };

  const handleDeleteFolder = async (id) => {
    if (await confirm('Delete this folder? Any subfolders inside it are deleted too, and flows inside become uncategorized.')) {
      await deleteFolder(id);
      loadFolders();
      if (selectedFolderId === id) {
        setSelectedFolderId('all');
        saveSelectedFolder('qa-tool:flows-selected-folder', 'all');
      }
    }
  };

  const openNewFlow = () => {
    setRunResult(null);
    setError('');
    setExpandedStep(0);
    setStepErrors({});
    setViewingFlow(null);
    setEditingFlow({
      name: '', description: '',
      folder_id: typeof selectedFolderId === 'number' ? selectedFolderId : null,
      stop_on_failure: true,
      steps: [emptyStep(defaultHeaders)],
    });
  };

  const openFlow = async (id) => {
    setRunResult(null);
    setError('');
    setExpandedStep(null);
    setStepErrors({});
    setViewingFlow(null);
    const flow = await getFlow(id);
    setEditingFlow({ ...flow, steps: flow.steps.map(stepFromApi) });
  };

  // Read-only step detail (raw step config, no editing) — for a quick look
  // without opening the full editable form.
  const openFlowDetail = async (id) => {
    setEditingFlow(null);
    setViewingFlow(await getFlow(id));
  };

  // Reordering steps from the read-only View Flow panel — the raw step rows
  // returned by getFlow() already carry every field replaceSteps() needs
  // (endpoint_id, auth_credential_id, name, method, url_template, headers,
  // body_template, body_type, extract, assertions), so the reordered list can
  // be PUT straight back without reshaping it, same as the editor form does.
  const handleDropViewStep = async (targetIdx) => {
    const fromIdx = draggedViewStepIdx;
    setDraggedViewStepIdx(null);
    setDragOverViewStepIdx(null);
    if (fromIdx == null || fromIdx === targetIdx) return;

    const steps = [...viewingFlow.steps];
    const [moved] = steps.splice(fromIdx, 1);
    steps.splice(targetIdx, 0, moved);
    setViewingFlow({ ...viewingFlow, steps });

    setReorderingViewSteps(true);
    try {
      await updateFlow(viewingFlow.id, {
        name: viewingFlow.name,
        description: viewingFlow.description,
        folder_id: viewingFlow.folder_id,
        stop_on_failure: viewingFlow.stop_on_failure,
        steps,
      });
    } catch (err) {
      setError(err.response?.data?.error || err.message);
      setViewingFlow(await getFlow(viewingFlow.id));
    } finally {
      setReorderingViewSteps(false);
    }
  };

  const handleAddStep = () => {
    setEditingFlow({ ...editingFlow, steps: [...editingFlow.steps, emptyStep(defaultHeaders)] });
    setExpandedStep(editingFlow.steps.length);
  };
  const handleRemoveStep = async (idx) => {
    if (!(await confirm('Delete this step?'))) return;
    setEditingFlow({ ...editingFlow, steps: editingFlow.steps.filter((_, i) => i !== idx) });
    setExpandedStep((prev) => {
      if (prev === idx) return null;
      if (prev != null && prev > idx) return prev - 1;
      return prev;
    });
  };
  const handleDuplicateStep = (idx) => {
    const steps = [...editingFlow.steps];
    const copy = { ...steps[idx], name: `${steps[idx].name} (Copy)` };
    steps.splice(idx + 1, 0, copy);
    setEditingFlow({ ...editingFlow, steps });
    setExpandedStep(idx + 1);
  };
  // Steps have no server-side sort_order — order is implicit array index,
  // persisted as step_order the next time the flow is saved (replaceSteps()
  // in routes/flows.js deletes+reinserts every step keyed by its position in
  // the array) — so reordering here is purely a local array splice.
  const handleDropStep = (targetIdx) => {
    const fromIdx = draggedStepIdx;
    setDraggedStepIdx(null);
    setDragOverStepIdx(null);
    if (fromIdx == null || fromIdx === targetIdx) return;

    const steps = [...editingFlow.steps];
    const [moved] = steps.splice(fromIdx, 1);
    steps.splice(targetIdx, 0, moved);
    setEditingFlow({ ...editingFlow, steps });

    setExpandedStep((prev) => {
      if (prev === fromIdx) return targetIdx;
      if (prev == null) return prev;
      if (fromIdx < prev && targetIdx >= prev) return prev - 1;
      if (fromIdx > prev && targetIdx <= prev) return prev + 1;
      return prev;
    });
  };

  const handleStepChange = (idx, field, value) => {
    const steps = [...editingFlow.steps];
    steps[idx] = { ...steps[idx], [field]: value };
    setEditingFlow({ ...editingFlow, steps });
  };

  // One button instead of clicking every step's checkbox individually —
  // toggles based on the CURRENT overall state (all already checked ->
  // uncheck everything; anything unchecked -> check everything), same
  // "Select All / Unselect All" pattern as the View Flow panel's own
  // handleToggleAllSteps below (this one only touches the in-progress edit
  // form's local state — nothing is persisted until Save Flow).
  const allStepsEnabled = editingFlow?.steps.every((s) => s.enabled !== false);
  const handleToggleAllStepsEnabled = () => {
    const nextEnabled = !allStepsEnabled;
    setEditingFlow({ ...editingFlow, steps: editingFlow.steps.map((s) => ({ ...s, enabled: nextEnabled })) });
  };

  // A run condition needs the previous step's REAL, already-finished result
  // to decide anything — incompatible with running at the same time as it
  // (see groupIntoBatches on the backend, which forces its own batch either
  // way), so setting one here also turns that checkbox off instead of
  // leaving it checked-but-silently-ignored.
  const handleRunConditionChange = (idx, value) => {
    const steps = [...editingFlow.steps];
    steps[idx] = { ...steps[idx], runConditionStatusCode: value, parallelWithPrevious: value ? false : steps[idx].parallelWithPrevious };
    setEditingFlow({ ...editingFlow, steps });
  };

  // AuthorizationField's credentialId and rawValue changes must land in one
  // update — two separate handleStepChange calls in the same tick would both
  // read the same not-yet-re-rendered `editingFlow`, so the second call's
  // result would overwrite the first's instead of combining with it.
  const handleAuthorizationFieldChange = (idx, patch) => {
    const steps = [...editingFlow.steps];
    const step = steps[idx];
    const next = { ...step };
    if ('credentialId' in patch) next.authCredentialId = patch.credentialId;
    if ('rawValue' in patch) next.headersRows = setAuthHeaderValue(step.headersRows, patch.rawValue);
    steps[idx] = next;
    setEditingFlow({ ...editingFlow, steps });
  };

  // bodyText (JSON) and bodyRows (Form Data) are two independent copies of
  // the same body, only ever synced once when an endpoint is first selected
  // — so anything that changes bodyRows afterward (e.g. FormDataEditor's
  // auto-fill-from-Test-File-library) never reaches bodyText, leaving the
  // JSON tab showing a stale snapshot. Regenerate whichever side is about to
  // be shown from the side that's actually been kept live.
  const handleBodyTypeChange = (idx, type) => {
    const steps = [...editingFlow.steps];
    const step = steps[idx];
    if (type === step.bodyType) return;

    if (type === 'json') {
      const obj = sanitizeBodyForPreview(formRowsToObject(step.bodyRows));
      steps[idx] = { ...step, bodyType: type, bodyText: Object.keys(obj).length ? JSON.stringify(obj, null, 2) : '' };
    } else {
      let parsed;
      try { parsed = step.bodyText.trim() ? JSON.parse(stripJsonComments(step.bodyText)) : {}; } catch { parsed = undefined; }
      if (parsed === undefined) {
        steps[idx] = { ...step, bodyType: type };
      } else {
        // A file row's real fileMeta must never be replaced by the "<N bytes
        // omitted>" placeholder that JSON.parse would otherwise hand back —
        // keep whatever real data bodyRows already had for that key.
        // objectToFormRows always returns a truthy fileMeta for a __file__
        // object (even a sanitized preview one, whose `data` IS that literal
        // placeholder string) — so `!r.fileMeta` alone never actually caught
        // this, silently swapping a real file's bytes for the placeholder
        // text the moment the JSON preview was ever viewed and switched back.
        const isPlaceholderFileData = (data) => typeof data === 'string' && /^<\d+ bytes omitted>$/.test(data);
        const existingFileMetaByKey = Object.fromEntries(
          step.bodyRows.filter((r) => r.type === 'file' && r.fileMeta).map((r) => [r.key, r.fileMeta])
        );
        const newRows = objectToFormRows(parsed).map((r) => (
          r.type === 'file' && (!r.fileMeta || isPlaceholderFileData(r.fileMeta.data)) && existingFileMetaByKey[r.key]
            ? { ...r, fileMeta: existingFileMetaByKey[r.key] }
            : r
        ));
        steps[idx] = { ...step, bodyType: type, bodyRows: newRows };
      }
    }
    setEditingFlow({ ...editingFlow, steps });
  };

  const handleSelectEndpoint = (idx, endpointIdStr) => {
    const endpointId = endpointIdStr ? Number(endpointIdStr) : '';
    const ep = endpoints.find((e) => e.id === endpointId);
    if (endpointId && stepErrors[idx]?.endpoint) {
      setStepErrors((prev) => ({ ...prev, [idx]: { ...prev[idx], endpoint: false } }));
    }
    const steps = [...editingFlow.steps];
    const method = ep ? ep.method : steps[idx].method;
    // Seed a default "expected status" assertion so a fresh step already has
    // a sane pass/fail check — accepting either 200 (a plain read, or a
    // POST-shaped RPC/aggregator call that only queries data) or 201 (POST
    // creating a resource) covers both without needing to guess from the
    // method or special-case aggregator endpoints. Only added when the step
    // doesn't already have a status assertion, so it never overwrites
    // something the user already set up.
    const hasStatusCodeAssertion = steps[idx].assertionsRows.some((r) => r.type === 'status_code' || r.type === 'status_code_in');
    const assertionsRows = ep && !hasStatusCodeAssertion
      ? [{ ...emptyAssertionRow(), type: 'status_code_in', expected: '200,201' }, ...steps[idx].assertionsRows]
      : steps[idx].assertionsRows;
    steps[idx] = {
      ...steps[idx],
      endpoint_id: endpointId,
      url_template: ep ? ep.path_template : '',
      method,
      headersRows: ep ? objectToRows(ep.headers) : steps[idx].headersRows,
      bodyType: ep ? (ep.body_type || 'json') : steps[idx].bodyType,
      bodyText: ep
        ? (ep.body_text != null
          ? ep.body_text
          : (ep.body_template && Object.keys(ep.body_template).length ? JSON.stringify(ep.body_template, null, 2) : ''))
        : '',
      bodyRows: ep ? objectToFormRows(ep.body_template) : steps[idx].bodyRows,
      assertionsRows,
    };
    setEditingFlow({ ...editingFlow, steps });
    if (endpointId) {
      // Picking an endpoint reveals a bunch of new fields below (body,
      // assertions, ...) — wait for that taller layout to actually finish
      // rendering/painting before scrolling, so the distance below is
      // measured against the step's new (taller) bottom edge, not its old
      // one. A single scrollBy computed from the element's own position
      // (rather than scrollIntoView) — issuing two separate smooth-scroll
      // calls back to back has the second one cut the first's animation
      // short, landing well short of the target.
      setTimeout(() => {
        const el = stepRefs.current[idx];
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const extraPeek = 100; // scroll a bit past the step's own bottom edge
        window.scrollBy({ top: rect.bottom - window.innerHeight + extraPeek, behavior: 'smooth' });
      }, 100);
    }
  };

  const startCurlPaste = (idx) => {
    setCurlPasteIdx(idx);
    setCurlPasteText('');
    setCurlPasteError('');
  };
  const cancelCurlPaste = () => {
    setCurlPasteIdx(null);
    setCurlPasteText('');
    setCurlPasteError('');
  };

  // Fills a step directly from a pasted curl command instead of picking a
  // saved Endpoint — for a one-off request that doesn't need its own
  // reusable Endpoint template. Mirrors handleSelectEndpoint's auto-fill
  // (default status assertion), except when the curl itself already carries
  // a real Authorization header — that was deliberately captured for this
  // exact request, so any credential the step already had is cleared, or
  // the header we just pasted would be silently ignored in favor of it.
  const handleParseCurlForStep = async (idx) => {
    if (!curlPasteText.trim()) return;
    setCurlPasteError('');
    setCurlPasteLoading(true);
    try {
      const parsed = await parseCurlForStep(curlPasteText);
      const authHeaderKey = Object.keys(parsed.headers || {}).find((k) => k.toLowerCase() === 'authorization');
      const hasAuthHeader = authHeaderKey && String(parsed.headers[authHeaderKey] || '').trim();
      const bodyIsObject = parsed.body && typeof parsed.body === 'object';

      // Functional update — reads the LATEST editingFlow at apply-time, not
      // whatever was captured in this closure when the parse started. Without
      // this, any edit made elsewhere in the form while the parse request was
      // in flight (rename a step, add/delete one, toggle stop_on_failure)
      // gets silently reverted the moment this resolves.
      setEditingFlow((prev) => {
        const steps = [...prev.steps];
        const hasStatusCodeAssertion = steps[idx].assertionsRows.some((r) => r.type === 'status_code' || r.type === 'status_code_in');
        const assertionsRows = !hasStatusCodeAssertion
          ? [{ ...emptyAssertionRow(), type: 'status_code_in', expected: '200,201' }, ...steps[idx].assertionsRows]
          : steps[idx].assertionsRows;
        const authCredentialId = hasAuthHeader ? '' : steps[idx].authCredentialId;
        steps[idx] = {
          ...steps[idx],
          endpoint_id: '',
          method: parsed.method,
          url_template: parsed.url_template,
          headersRows: objectToRows(parsed.headers),
          bodyType: parsed.is_multipart ? 'form-data' : 'json',
          bodyText: parsed.is_multipart ? '' : (bodyIsObject ? JSON.stringify(parsed.body, null, 2) : (parsed.body || '')),
          bodyRows: parsed.is_multipart ? objectToFormRows(parsed.body) : [emptyFormRow()],
          assertionsRows,
          authCredentialId,
        };
        return { ...prev, steps };
      });
      setCurlPasteIdx(null);
      setCurlPasteText('');
    } catch (err) {
      setCurlPasteError(err.response?.data?.error || err.message);
    } finally {
      setCurlPasteLoading(false);
    }
  };

  // Basic Auth (and any other non-Bearer scheme someone typed by hand) is
  // deliberately off-limits for this bulk action — it's meant for swapping
  // which Web Login account a flow's steps run as, not for clobbering a step
  // that was intentionally set up to authenticate a different way.
  const stepUsesNonBearerAuth = (step) => {
    if (step.authCredentialId) {
      const cred = authCredentials.find((c) => String(c.id) === String(step.authCredentialId));
      return cred ? cred.type !== 'web_login' : false;
    }
    const raw = getAuthHeaderValue(step.headersRows).trim();
    if (!raw) return false;
    // A bare token with no scheme word at all (e.g. a JWT pasted straight
    // from a curl capture, missing its "Bearer " prefix) isn't "using a
    // non-Bearer scheme" — it's just missing the label. runStep on the
    // backend already treats this the same way (auto-prepending "Bearer "
    // whenever there's no scheme prefix at all — see flowExecutor.js) —
    // this must match that leniency, or a step like that silently gets
    // excluded from BOTH "Fill empty" and "Override all" forever, with no
    // error to explain why. Only an EXPLICIT non-Bearer scheme word (Basic,
    // Digest, ...) is actually off-limits.
    const hasSchemeWord = /^[a-z]+\s/i.test(raw);
    return hasSchemeWord && !/^bearer\s/i.test(raw);
  };

  // "Fill empty" only ever touches steps with no Authorization yet — always
  // safe, no confirm needed. "Override" replaces EVERY (Bearer-eligible)
  // step's Authorization, including ones already set to something else — a
  // confirm here since that's a real, hard-to-notice-until-too-late data
  // loss otherwise.
  const handleApplyAuthCredential = async (cred, overrideExisting) => {
    const eligibleSteps = editingFlow.steps.filter((s) => !stepUsesNonBearerAuth(s));
    const protectedCount = editingFlow.steps.length - eligibleSteps.length;
    const protectedNote = protectedCount > 0
      ? ` ${protectedCount} step${protectedCount === 1 ? '' : 's'} using Basic Auth (or a non-Bearer value) will be left untouched.`
      : '';
    const emptyCount = eligibleSteps.filter((s) => !s.authCredentialId).length;
    const filledCount = eligibleSteps.length - emptyCount;
    if (overrideExisting) {
      if (filledCount === 0) {
        showToast(`No eligible step has its own Authorization set yet — nothing to override.${protectedNote}`);
        setPendingAuthCredential(null);
        return;
      }
      const ok = await confirm(
        `Override Authorization on ${filledCount} step${filledCount === 1 ? '' : 's'} that already ${filledCount === 1 ? 'has' : 'have'} one set, replacing it with "${cred.name}"?${protectedNote} This can't be undone.`
      );
      if (!ok) return;
      // Also blank any raw Authorization header row a step might already
      // have (e.g. from a pasted curl command) — picking a credential here
      // bypasses AuthorizationField's own onChange, which is normally what
      // clears that row, so without this the old raw value would keep
      // riding along as a second, differently-cased Authorization header
      // at request time (see flowExecutor.js's dedup for the other half of
      // this fix).
      const steps = editingFlow.steps.map((step) => (
        stepUsesNonBearerAuth(step)
          ? step
          : { ...step, authCredentialId: String(cred.id), headersRows: setAuthHeaderValue(step.headersRows, '') }
      ));
      setEditingFlow({ ...editingFlow, steps });
      showToast(`Set Authorization to "${cred.name}" for ${eligibleSteps.length} step${eligibleSteps.length === 1 ? '' : 's'}.${protectedNote}`);
    } else {
      if (emptyCount === 0) {
        showToast(`Every eligible step already has its own Authorization set — nothing to fill.${protectedNote}`);
        setPendingAuthCredential(null);
        return;
      }
      const steps = editingFlow.steps.map((step) => (
        !step.authCredentialId && !stepUsesNonBearerAuth(step)
          ? { ...step, authCredentialId: String(cred.id), headersRows: setAuthHeaderValue(step.headersRows, '') }
          : step
      ));
      setEditingFlow({ ...editingFlow, steps });
      showToast(`Filled Authorization for ${emptyCount} step${emptyCount === 1 ? '' : 's'} with "${cred.name}".${protectedNote}`);
    }
    setPendingAuthCredential(null);
  };

  const hasActiveXToken = (step) => step.headersRows.some((r) => (
    r.key.trim().toLowerCase() === 'x-token' && r.enabled !== false && r.value.trim()
  ));
  const setXTokenOnStep = (step, value) => {
    const idx = step.headersRows.findIndex((r) => r.key.trim().toLowerCase() === 'x-token');
    if (idx === -1) return { ...step, headersRows: [...step.headersRows, { key: 'X-Token', value, enabled: true }] };
    const headersRows = [...step.headersRows];
    headersRows[idx] = { ...headersRows[idx], value, enabled: true };
    return { ...step, headersRows };
  };

  // Same fill-empty/override-all choice as handleApplyAuthCredential, for a
  // value picked from "Select x-token" — previously this always overwrote every
  // step in one shot behind a single confirm, with no way to only fill in
  // the steps that didn't have one yet.
  const handleApplyXToken = async (h, overrideExisting) => {
    const label = `${h.label || 'X-Token'}${h.environment_name ? ` (${h.environment_name})` : ''}`;
    const emptyCount = editingFlow.steps.filter((s) => !hasActiveXToken(s)).length;
    const filledCount = editingFlow.steps.length - emptyCount;
    if (overrideExisting) {
      if (filledCount === 0) {
        showToast('No step has its own X-Token set yet — nothing to override.');
        setPendingXToken(null);
        return;
      }
      const ok = await confirm(
        `Override X-Token on ${filledCount} step${filledCount === 1 ? '' : 's'} that already ${filledCount === 1 ? 'has' : 'have'} one set, replacing it with "${label}"? This can't be undone.`
      );
      if (!ok) return;
      const steps = editingFlow.steps.map((step) => setXTokenOnStep(step, h.value));
      setEditingFlow({ ...editingFlow, steps });
      showToast(`Select x-token to "${label}" for all ${steps.length} step${steps.length === 1 ? '' : 's'}.`);
    } else {
      if (emptyCount === 0) {
        showToast('Every step already has its own X-Token set — nothing to fill.');
        setPendingXToken(null);
        return;
      }
      const steps = editingFlow.steps.map((step) => (
        !hasActiveXToken(step) ? setXTokenOnStep(step, h.value) : step
      ));
      setEditingFlow({ ...editingFlow, steps });
      showToast(`Filled X-Token for ${emptyCount} step${emptyCount === 1 ? '' : 's'} with "${label}".`);
    }
    setPendingXToken(null);
  };

  // Unchecks (disables) every step's X-Token row instead of deleting it — the
  // value stays put so a step can be switched back on individually later,
  // rather than someone having to re-pick "Select x-token" from scratch.
  const handleDisableXTokenForAll = async () => {
    const enabledCount = editingFlow.steps.filter((s) => (
      s.headersRows.some((r) => r.key.trim().toLowerCase() === 'x-token' && r.enabled !== false)
    )).length;
    if (enabledCount === 0) {
      showToast('No step has X-Token enabled — nothing to disable.');
      return;
    }
    const ok = await confirm(
      `Uncheck X-Token on ${enabledCount} step${enabledCount === 1 ? '' : 's'}? The value is kept — you can re-enable it on individual steps later.`
    );
    if (!ok) return;
    const steps = editingFlow.steps.map((step) => ({
      ...step,
      headersRows: step.headersRows.map((r) => (
        r.key.trim().toLowerCase() === 'x-token' ? { ...r, enabled: false } : r
      )),
    }));
    setEditingFlow({ ...editingFlow, steps });
    showToast(`Unchecked X-Token on ${enabledCount} step${enabledCount === 1 ? '' : 's'}.`);
  };

  const refreshFlowList = () => loadFlows(selectedFolderId === 'all' ? undefined : selectedFolderId);

  const handleSaveFlow = async () => {
    setError('');

    const errors = {};
    editingFlow.steps.forEach((step, idx) => {
      const e = {};
      if (!step.endpoint_id && !step.url_template) e.endpoint = true;
      if (Object.keys(e).length) errors[idx] = e;
    });
    setStepErrors(errors);
    if (Object.keys(errors).length) {
      const firstErrorIdx = Number(Object.keys(errors)[0]);
      setExpandedStep(firstErrorIdx);
      // Wait a tick for the step to expand (its height changes) before
      // measuring where to scroll, so it doesn't land in the wrong spot.
      setTimeout(() => {
        stepRefs.current[firstErrorIdx]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 0);
      return;
    }

    try {
      const steps = editingFlow.steps.map((step) => stepToPayload(step, endpoints));
      // Not required — falls back to a generic default so a flow can be
      // saved without stopping to think of a name up front.
      const payload = {
        name: editingFlow.name.trim() || 'Untitled Flow',
        description: editingFlow.description,
        folder_id: editingFlow.folder_id,
        stop_on_failure: editingFlow.stop_on_failure,
        steps,
      };
      const wasEditing = !!editingFlow.id;
      if (wasEditing) await updateFlow(editingFlow.id, payload);
      else await createFlow(payload);
      setEditingFlow(null);
      refreshFlowList();
      showToast(`Flow "${payload.name}" ${wasEditing ? 'updated' : 'added'} successfully.`);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to save flow');
    }
  };

  const handleDeleteFlow = async (id) => {
    if (await confirm('Delete this flow?')) {
      await deleteFlow(id);
      if (editingFlow?.id === id) setEditingFlow(null);
      refreshFlowList();
    }
  };

  const handleDuplicateFlow = async (id) => {
    await duplicateFlow(id);
    refreshFlowList();
  };

  // Moves a flow into a different folder from the list's Options menu. The
  // Flow List row itself doesn't carry `steps` (GET /flows omits them for a
  // lighter list payload), and PUT /flows/:id replaces steps wholesale, so
  // the full flow has to be fetched first — its raw step rows already match
  // what the PUT payload expects, same as the View Flow step-reorder above.
  const handleMoveFlow = async (id, folderId) => {
    const flow = await getFlow(id);
    await updateFlow(id, {
      name: flow.name,
      description: flow.description,
      folder_id: folderId,
      stop_on_failure: flow.stop_on_failure,
      steps: flow.steps,
    });
    refreshFlowList();
  };

  const handleRunFlow = async (flowId, confirmProd = false) => {
    const envId = flowEnvIds[flowId];
    if (!envId) return; // Play button is disabled without one — nothing to run yet
    setEditingFlow(null);
    setViewingFlow(null);
    setRunning(true);
    setRunningFlowId(flowId);
    // Handed to the backend so a "Cancel" click has something to identify
    // this exact run by — generated fresh per actual attempt (the prod
    // confirmation retry below counts as a new attempt, since the first one
    // never got past the confirmation gate to execute anything).
    const runToken = crypto.randomUUID();
    setRunningToken(runToken);
    setRunningIsBatch(false);
    setCancelling(false);
    setRunResult(null);
    setBatchRunResult(null);
    setError('');
    // When we hand off to a recursive confirmed-run call below, that call
    // owns clearing running/runningFlowId in its own finally — this outer
    // finally must not stomp on it while the confirmed run is still in flight.
    let handedOff = false;
    try {
      const res = await runFlow(flowId, { environment_id: envId, confirm_prod: confirmProd, run_token: runToken });
      setRunResult({
        ...res,
        flow_name: flows.find((f) => f.id === flowId)?.name || 'Flow',
        environment_name: environments.find((e) => e.id === envId)?.name || '',
      });
    } catch (err) {
      if (err.response?.status === 412) {
        if (await confirm(err.response.data.message + ' Continue?')) {
          handedOff = true;
          await handleRunFlow(flowId, true);
          return;
        }
      } else {
        setError(err.response?.data?.error || err.message);
      }
    } finally {
      if (!handedOff) {
        setRunning(false);
        setRunningFlowId(null);
        setRunningToken(null);
        setCancelling(false);
      }
    }
  };

  // Polls whichever steps have completed so far for the in-flight run (or
  // Batch Run — see runningIsBatch), so the "Running…" card can render them
  // as they land instead of showing nothing until the whole thing finishes.
  // `segments` is one entry per flow run under this token: always exactly
  // one for a plain run, one per flow (in start order) for a batch — see
  // backend/src/services/runProgress.js. Starts as soon as a runningToken
  // shows up, stops (and clears) the moment it's cleared back to null.
  const [liveSegments, setLiveSegments] = useState([]);
  useEffect(() => {
    if (!runningToken) {
      setLiveSegments([]);
      return;
    }
    let stopped = false;
    const poll = () => {
      getRunProgress(runningToken).then((data) => {
        if (!stopped) setLiveSegments(data.segments || []);
      }).catch(() => {});
    };
    poll();
    const interval = setInterval(poll, 800);
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }, [runningToken]);

  // Auto-scroll while a run is live: brings the "Running…" card into view
  // the moment a run starts, then keeps following along by scrolling all
  // the way to the bottom of the page every time another step actually
  // finishes — driven off the total count (not liveSegments itself, which
  // is a new array reference on every 800ms poll tick even when nothing
  // actually changed) so it only re-scrolls on real progress.
  const runningCardRef = useRef(null);
  const liveTotalSteps = liveSegments.reduce((sum, seg) => sum + seg.steps.length, 0);

  useEffect(() => {
    if (running) runningCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [running]);

  // Fires on the false->true transition only (see the `!!editingFlow`
  // boolean dependency) — not on every keystroke while the form is already
  // open, which would otherwise re-run this on every setEditingFlow call.
  const newFlowPanelRef = useRef(null);
  const isEditingFlowOpen = !!editingFlow;
  useEffect(() => {
    if (isEditingFlowOpen) newFlowPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [isEditingFlowOpen]);
  // Same idea for clicking a flow row to open its read-only "View Flow"
  // detail panel — otherwise it renders below the fold and needs a manual
  // scroll to actually see.
  const viewFlowPanelRef = useRef(null);
  const isViewingFlowOpen = !!viewingFlow;
  useEffect(() => {
    if (isViewingFlowOpen) viewFlowPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [isViewingFlowOpen]);
  useEffect(() => {
    if (running && liveTotalSteps > 0) {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
    }
  }, [liveTotalSteps]);

  // Which segment/index (across all of liveSegments, flattened) is the 5th
  // completed step overall — a ref goes on that one specific row so the
  // scroll-to-top button's visibility can track it directly ("have I
  // scrolled past step 5") instead of "am I at the very bottom of the
  // page", which doesn't fit here since the page keeps auto-scrolling to
  // the bottom on every new step anyway.
  let fifthStepSegIdx = -1;
  let fifthStepIdx = -1;
  {
    let flatCount = 0;
    outer: for (let i = 0; i < liveSegments.length; i++) {
      for (let j = 0; j < liveSegments[i].steps.length; j++) {
        if (flatCount === 4) { fifthStepSegIdx = i; fifthStepIdx = j; break outer; }
        flatCount += 1;
      }
    }
  }
  const fifthStepRef = useRef(null);
  const [scrolledPastFifthStep, setScrolledPastFifthStep] = useState(false);
  // Deliberately depends only on `running`, not liveTotalSteps — re-running
  // this on every new step tore the listeners down and immediately re-checked
  // position synchronously, which could fire right as a new step's DOM node
  // was still landing and the auto-scroll-to-bottom animation hadn't actually
  // moved the page yet, reading a stale "not scrolled past" position and
  // hiding the button right when it should have stayed shown. The native
  // 'scroll' events fired by that same auto-scroll (and by manual scrolling)
  // already keep this correctly up to date without forcing an extra check.
  useEffect(() => {
    if (!running) { setScrolledPastFifthStep(false); return; }
    const checkPosition = () => {
      const el = fifthStepRef.current;
      setScrolledPastFifthStep(!!el && el.getBoundingClientRect().top < 0);
    };
    checkPosition();
    window.addEventListener('scroll', checkPosition, { passive: true });
    window.addEventListener('resize', checkPosition);
    return () => {
      window.removeEventListener('scroll', checkPosition);
      window.removeEventListener('resize', checkPosition);
    };
  }, [running]);

  const handleCancelRun = async () => {
    if (!runningToken || cancelling) return;
    // Stops the repeat loop from starting another pass once the current one
    // settles — a no-op flag outside a repeated batch run, where nothing
    // ever checks it.
    repeatCancelledRef.current = true;
    setCancelling(true);
    try {
      await cancelFlowRun(runningToken);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
      setCancelling(false);
    }
  };

  const toggleFlowSelected = (id) => {
    setSelectedFlowIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleSelectAllFlows = () => {
    setSelectedFlowIds((prev) => (prev.size === flows.length ? new Set() : new Set(flows.map((f) => f.id))));
  };

  const handleDropFlow = async (targetId) => {
    const fromId = draggedFlowId;
    setDraggedFlowId(null);
    setDragOverFlowId(null);
    if (!fromId || fromId === targetId) return;

    const fromIdx = flows.findIndex((f) => f.id === fromId);
    const toIdx = flows.findIndex((f) => f.id === targetId);
    if (fromIdx === -1 || toIdx === -1) return;

    const reordered = [...flows];
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);
    setFlows(reordered);

    try {
      await reorderFlows(reordered.map((f) => f.id));
    } catch (err) {
      setError(err.response?.data?.error || err.message);
      refreshFlowList();
    }
  };

  const handleShareRunResultToTelegram = async () => {
    setSharingRunResult(true);
    try {
      const { base64, filename } = getRunResultPdfBase64(runResult);
      await sendDocumentToTelegram({
        filename,
        caption: `Flow Run: ${runResult.flow_name} — ${runResult.flow_run.status}`,
        fileBase64: base64,
      });
      showToast('Sent to Telegram.');
    } catch (err) {
      showToast(err.response?.data?.error || err.message, 'error');
    } finally {
      setSharingRunResult(false);
    }
  };

  const handleShareBatchRunResultToTelegram = async () => {
    setSharingBatchRunResult(true);
    try {
      const { base64, filename } = getBatchRunResultPdfBase64(batchRunResult);
      const passCount = batchRunResult.results.filter((r) => r.flow_run?.status === 'PASS').length;
      await sendDocumentToTelegram({
        filename,
        caption: `Batch Run: ${passCount}/${batchRunResult.results.length} flows passed`,
        fileBase64: base64,
      });
      showToast('Sent to Telegram.');
    } catch (err) {
      showToast(err.response?.data?.error || err.message, 'error');
    } finally {
      setSharingBatchRunResult(false);
    }
  };

  // One combined PDF — the visual summary (pass-rate chart + a short
  // written explanation per flow) followed by the detailed report (every
  // repeat's full flow/step breakdown), as two sections of the SAME file.
  // Two separate doc.save() calls back-to-back get the second one silently
  // blocked by the browser's "multiple automatic downloads" guard (even
  // with a delay between them), so one file is the only reliable way to
  // deliver both sections from a single click.
  const handleDownloadRepeatResultsPdfs = () => {
    exportRepeatCombinedToPdf(repeatResults, runningRepeatCount);
  };

  const handleShareRepeatResultsToTelegram = async () => {
    setSharingRepeatResults(true);
    try {
      const passCount = repeatResults.filter((rr) => rr.result && !rr.error && rr.result.results.every((r) => !r.error && r.flow_run?.status === 'PASS')).length;
      const caption = `Repeated Batch Run: ${passCount}/${repeatResults.length} of ${runningRepeatCount}x passed`;
      const { base64, filename } = getRepeatCombinedPdfBase64(repeatResults, runningRepeatCount);
      await sendDocumentToTelegram({ filename, caption, fileBase64: base64 });
      showToast('Sent to Telegram.');
    } catch (err) {
      showToast(err.response?.data?.error || err.message, 'error');
    } finally {
      setSharingRepeatResults(false);
    }
  };

  // Runs every selected flow against one environment — serial (default)
  // chains each flow's extracted variables into the next (e.g. Login then
  // Get Profile reusing the token Login extracted), parallel runs them all
  // at once with no chaining (see runParallel) — see routes/flows.js
  // /batch-run. No separate "batch environment" picker — reuses whichever
  // environment is already set on each selected flow's own Flow List row,
  // which all have to agree (a token extracted from a STG run shouldn't get
  // reused against RC, and running two envs at once wouldn't mean anything).
  // Runs one pass of the selected batch and returns { result, error,
  // stoppedByUser } — factored out of handleBatchRun so repeating it N
  // times is just calling this in a loop. The PROD-confirmation handshake
  // (412 -> confirm -> retry with confirm_prod: true) is handled entirely
  // within this one call instead of the old recursive handleBatchRun(true)
  // re-entry, since a loop needs a value back, not a tail call.
  const runOneBatchPass = async (selected, envId) => {
    const runToken = crypto.randomUUID();
    setRunningToken(runToken);
    let confirmProd = false;
    while (true) {
      try {
        const result = await batchRunFlows({
          // Follow the Flow List's current visual/drag order, not the Set's
          // insertion order (which is whichever order the checkboxes were
          // clicked in and can drift from the list after a reorder).
          flow_ids: selected.map((f) => f.id),
          environment_id: envId,
          confirm_prod: confirmProd,
          run_token: runToken,
          parallel: runParallel,
        });
        return { result, error: null, stoppedByUser: false };
      } catch (err) {
        if (err.response?.status === 412 && !confirmProd) {
          const message = err.response?.data?.message || 'Confirmation required.';
          if (await confirm(`${message} Continue?`)) {
            confirmProd = true;
            continue;
          }
          return { result: null, error: null, stoppedByUser: true };
        }
        return { result: null, error: err.response?.data?.error || err.message, stoppedByUser: false };
      }
    }
  };

  // Runs every selected flow against one environment — serial (default)
  // chains each flow's extracted variables into the next (e.g. Login then
  // Get Profile reusing the token Login extracted), parallel runs them all
  // at once with no chaining (see runParallel) — see routes/flows.js
  // /batch-run. No separate "batch environment" picker — reuses whichever
  // environment is already set on each selected flow's own Flow List row,
  // which all have to agree (a token extracted from a STG run shouldn't get
  // reused against RC, and running two envs at once wouldn't mean anything).
  //
  // With repeatCount > 1, the whole batch runs again from the top that many
  // times, one pass fully finishing before the next starts (never
  // overlapping) — each pass gets its own run_token, so live progress and
  // per-flow chaining reset cleanly at every repeat boundary. Every pass
  // still runs even if an earlier one failed (kept simple/consistent — this
  // is meant for flakiness/repeatability checks, not a stop-on-first-failure
  // gate), and Cancel stops the whole repeat run, not just whichever pass
  // is currently in flight (see repeatCancelledRef).
  const handleBatchRun = async () => {
    const selected = flows.filter((f) => selectedFlowIds.has(f.id));
    if (selected.some((f) => !flowEnvIds[f.id])) {
      showToast('Set an environment for every selected flow first.', 'error');
      return;
    }
    const envIds = [...new Set(selected.map((f) => flowEnvIds[f.id]))];
    if (envIds.length > 1) {
      showToast('Selected flows must all use the same environment to batch run together.', 'error');
      return;
    }
    const totalRepeats = Math.max(1, Math.min(50, Number(repeatCount) || 1));

    setEditingFlow(null);
    setViewingFlow(null);
    setRunning(true);
    setRunningIsBatch(true);
    setRunningParallel(runParallel);
    setRunningRepeatCount(totalRepeats);
    setRunResult(null);
    setBatchRunResult(null);
    setRepeatResults(totalRepeats > 1 ? [] : null);
    setExpandedRepeatIdx(null);
    setError('');
    repeatCancelledRef.current = false;

    // A try/finally around the loop itself, not just relying on
    // runOneBatchPass's own try/catch — if literally anything in here ever
    // throws unexpectedly (a future edit, an unhandled edge case), `running`
    // must still get cleared instead of leaving the whole page's run/cancel
    // controls stuck disabled forever (they all gate on `disabled={running}`)
    // until a full reload.
    try {
      for (let i = 1; i <= totalRepeats; i++) {
        if (repeatCancelledRef.current) break;
        setRepeatIndex(i);
        const pass = await runOneBatchPass(selected, envIds[0]);
        if (pass.stoppedByUser) { repeatCancelledRef.current = true; break; }
        if (totalRepeats > 1) {
          setRepeatResults((prev) => [...(prev || []), { result: pass.result, error: pass.error }]);
        } else {
          if (pass.result) setBatchRunResult(pass.result);
          if (pass.error) setError(pass.error);
        }
      }
    } finally {
      setRunning(false);
      setRunningToken(null);
      setRunningIsBatch(false);
      setCancelling(false);
      setRepeatIndex(0);
    }
  };

  // Runs one step in isolation (no chaining from other steps) — for quickly
  // re-testing a single request from the read-only View Flow panel without
  // re-running the whole flow, and without losing that panel's context.
  const handleRunStep = async (flowId, stepId, confirmProd = false) => {
    const envId = flowEnvIds[flowId];
    if (!envId) return; // Play button is disabled without one — nothing to run yet
    setRunning(true);
    setRunningStepId(stepId);
    setRunResult(null);
    setBatchRunResult(null);
    setError('');
    let handedOff = false;
    try {
      const res = await runFlowStep(flowId, stepId, { environment_id: envId, confirm_prod: confirmProd });
      setRunResult({
        ...res,
        flow_name: flows.find((f) => f.id === flowId)?.name || 'Flow',
        environment_name: environments.find((e) => e.id === envId)?.name || '',
      });
    } catch (err) {
      if (err.response?.status === 412) {
        if (await confirm(err.response.data.message + ' Continue?')) {
          handedOff = true;
          await handleRunStep(flowId, stepId, true);
          return;
        }
      } else {
        setError(err.response?.data?.error || err.message);
      }
    } finally {
      if (!handedOff) {
        setRunning(false);
        setRunningStepId(null);
      }
    }
  };

  // Unchecking a step here skips it on the flow's next full/batch/scheduled
  // run (it can still be run individually via the per-step play button)
  // without needing to open the edit form and re-save every step.
  const handleToggleStepEnabled = async (flowId, stepId, enabled) => {
    setViewingFlow((prev) => (prev ? { ...prev, steps: prev.steps.map((s) => (s.id === stepId ? { ...s, enabled } : s)) } : prev));
    try {
      await updateFlowStep(flowId, stepId, { enabled });
    } catch (err) {
      setViewingFlow((prev) => (prev ? { ...prev, steps: prev.steps.map((s) => (s.id === stepId ? { ...s, enabled: !enabled } : s)) } : prev));
      showToast(err.response?.data?.error || 'Failed to update step — please try again.', 'error');
    }
  };

  const handleToggleAllSteps = async (flowId, enabled) => {
    const prevSteps = viewingFlow.steps;
    setViewingFlow((prev) => (prev ? { ...prev, steps: prev.steps.map((s) => ({ ...s, enabled })) } : prev));
    try {
      await updateAllFlowSteps(flowId, { enabled });
    } catch (err) {
      setViewingFlow((prev) => (prev ? { ...prev, steps: prevSteps } : prev));
      showToast(err.response?.data?.error || 'Failed to update steps — please try again.', 'error');
    }
  };

  // Save Flow stays disabled (and quiet) until every required field is
  // actually filled in — a name isn't one of them (falls back to the first
  // step's endpoint name), just every step pointed at either an endpoint or
  // a pasted curl command.
  const canSaveFlow = !!(editingFlow && editingFlow.steps.length > 0 && editingFlow.steps.every((s) => s.endpoint_id || s.url_template));

  return (
    <div>
      <div className="page-header">
        <h3>Flows</h3>
        <p>
          Chain several endpoints into one sequential flow (e.g. log in, then use its token in the
          next step via <code>{'{{variable}}'}</code>), save it to a folder, then run it.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <div className="card" style={{ width: 240, flexShrink: 0 }}>
          <h4>Folder</h4>
          <FolderTree
            folders={folders}
            selectedFolderId={selectedFolderId}
            onSelect={(folderId) => { setSelectedFolderId(folderId); saveSelectedFolder('qa-tool:flows-selected-folder', folderId); setViewingFlow(null); }}
            onCreateFolder={handleCreateFolder}
            onDeleteFolder={handleDeleteFolder}
            onRenameFolder={handleRenameFolder}
            storageKey="qa-tool:flows-collapsed-folders"
            allLabel="All Flows"
          />
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="card">
            <div className="card-row">
              <h4 style={{ margin: 0 }}>Flow List</h4>
              <div className="toolbar">
                {selectedFlowIds.size > 0 && (
                  <>
                    <select
                      value={runParallel ? 'parallel' : 'serial'}
                      onChange={(e) => setRunParallel(e.target.value === 'parallel')}
                      disabled={running}
                      title="Serial chains each flow's extracted variables into the next (e.g. Login then reuse its token) — Parallel runs every selected flow at once, faster, but only makes sense when they don't depend on each other."
                    >
                      <option value="serial">Serial</option>
                      <option value="parallel">Parallel</option>
                    </select>
                    <input
                      type="number"
                      className="no-spinner"
                      min={1}
                      max={50}
                      value={repeatCount}
                      onChange={(e) => setRepeatCount(e.target.value)}
                      disabled={running}
                      title="Runs the whole selected batch again from the top this many times, one pass finishing before the next starts."
                      style={{ width: 56, textAlign: 'center' }}
                    />
                    <button
                      className={`btn-success${running ? '' : ' btn-ready'}`}
                      onClick={() => handleBatchRun()}
                      disabled={running}
                      title="Uses whichever environment is already set on each selected flow's row — they all have to match."
                    >
                      Run Selected ({selectedFlowIds.size}){Number(repeatCount) > 1 ? ` x${Number(repeatCount)}` : ''}
                    </button>
                  </>
                )}
                <button
                  className={`btn-primary${!editingFlow && (selectedFlowIds.size === 0 || running) ? ' btn-ready' : ''}`}
                  onClick={openNewFlow}
                >
                  + New Flow
                </button>
              </div>
            </div>
            <div className="scroll-table" style={{ maxHeight: 560 }}>
            <table>
              <thead>
                <tr>
                  <th style={{ width: 32 }}></th>
                  <th style={{ width: 32 }}>
                    <input
                      type="checkbox"
                      checked={flows.length > 0 && selectedFlowIds.size === flows.length}
                      onChange={toggleSelectAllFlows}
                      title="Select all"
                    />
                  </th>
                  <th style={{ width: 400 }}>Name</th>
                  <th style={{ width: 80 }}>Steps</th>
                  <th style={{ width: 110 }}>Environment</th>
                  <th style={{ width: 120 }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {flows.map((f) => (
                  <tr
                    key={f.id}
                    onClick={() => openFlowDetail(f.id)}
                    style={{
                      cursor: 'pointer',
                      opacity: draggedFlowId === f.id ? 0.4 : 1,
                      borderTop: dragOverFlowId === f.id && draggedFlowId !== f.id ? '2px solid var(--accent)' : undefined,
                      background: (editingFlow?.id === f.id || viewingFlow?.id === f.id) ? 'var(--surface-2)' : undefined,
                    }}
                    title="Click to view step detail"
                    draggable
                    onDragStart={(e) => { e.stopPropagation(); setDraggedFlowId(f.id); }}
                    onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); if (dragOverFlowId !== f.id) setDragOverFlowId(f.id); }}
                    onDragLeave={() => setDragOverFlowId((id) => (id === f.id ? null : id))}
                    onDrop={(e) => { e.stopPropagation(); handleDropFlow(f.id); }}
                    onDragEnd={() => { setDraggedFlowId(null); setDragOverFlowId(null); }}
                  >
                    <td className="hint" style={{ cursor: 'grab' }} onClick={(e) => e.stopPropagation()} title="Drag to reorder">
                      <GripIcon />
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedFlowIds.has(f.id)}
                        onChange={() => toggleFlowSelected(f.id)}
                      />
                    </td>
                    <td>
                      <span className="truncate" style={{ width: 360 }}>{f.name}</span>
                    </td>
                    <td>{f.step_count}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <select
                        value={flowEnvIds[f.id] || ''}
                        onChange={(e) => setFlowEnv(f.id, e.target.value ? Number(e.target.value) : null)}
                        style={{ width: '100%' }}
                      >
                        <option value="">Select env...</option>
                        {environments.map((env) => (
                          <option key={env.id} value={env.id}>{env.name}{env.is_protected ? '' : ''}</option>
                        ))}
                      </select>
                    </td>
                    <td className="row-actions">
                      <span className="row-actions-inner">
                        <button
                          className="btn-icon"
                          onClick={(e) => { e.stopPropagation(); handleRunFlow(f.id); }}
                          disabled={running || !flowEnvIds[f.id]}
                          title={flowEnvIds[f.id] ? 'Run' : 'Select an environment first'}
                          aria-label="Run"
                        >
                          {runningFlowId === f.id ? <span className="spinner" /> : <PlayIcon />}
                        </button>
                        <OptionsMenu
                          items={[
                            { label: 'Edit', icon: <EditIcon />, onClick: () => openFlow(f.id) },
                            { label: 'Duplicate', icon: <CopyIcon />, onClick: () => handleDuplicateFlow(f.id) },
                            {
                              label: 'Move to Folder',
                              icon: <FolderIcon />,
                              submenu: [
                                { label: 'No Folder', onClick: () => handleMoveFlow(f.id, null) },
                                ...flattenFolders(folders).map((fo) => ({
                                  label: folderOptionLabel(fo),
                                  onClick: () => handleMoveFlow(f.id, fo.id),
                                })),
                              ],
                            },
                            { label: 'Delete', icon: <TrashIcon />, onClick: () => handleDeleteFlow(f.id), danger: true, divider: true },
                          ]}
                        />
                      </span>
                    </td>
                  </tr>
                ))}
                {flows.length === 0 && <tr><td colSpan={6} className="empty-state">No flows yet.</td></tr>}
              </tbody>
            </table>
            </div>
          </div>

          {error && <div className="card error-text">{error}</div>}

          {viewingFlow && (
            <div className="card" ref={viewFlowPanelRef}>
              <div className="card-row">
                <h4 style={{ margin: 0 }}>View Flow: {viewingFlow.name}</h4>
                <div className="toolbar">
                  {reorderingViewSteps && <span className="hint">Saving order…</span>}
                  {viewingFlow.steps.length > 0 && (
                    <button
                      className="btn-quiet"
                      onClick={() => handleToggleAllSteps(viewingFlow.id, !viewingFlow.steps.every((s) => s.enabled !== false))}
                    >
                      {viewingFlow.steps.every((s) => s.enabled !== false) ? 'Unselect All' : 'Select All'}
                    </button>
                  )}
                  <button className="btn-quiet" onClick={() => setViewingFlow(null)}>✕ Close</button>
                </div>
              </div>
              <div className="stack" style={{ marginTop: 16, gap: 20 }}>
                {viewingFlow.steps.length === 0 && <span className="hint">This flow has no steps yet.</span>}
                {viewingFlow.steps.map((s, idx) => (
                  <details
                    key={s.id}
                    onDragOver={(e) => { e.preventDefault(); if (dragOverViewStepIdx !== idx) setDragOverViewStepIdx(idx); }}
                    onDragLeave={() => setDragOverViewStepIdx((i) => (i === idx ? null : i))}
                    onDrop={() => handleDropViewStep(idx)}
                    style={{
                      ...(idx < viewingFlow.steps.length - 1 ? { borderBottom: '1px solid var(--border-soft)', paddingBottom: 20 } : {}),
                      opacity: draggedViewStepIdx === idx ? 0.4 : 1,
                      borderTop: dragOverViewStepIdx === idx && draggedViewStepIdx !== idx ? '2px solid var(--accent)' : undefined,
                    }}
                  >
                    <summary className="step-summary">
                      <span
                        className="hint"
                        style={{ cursor: 'grab' }}
                        draggable
                        onDragStart={(e) => { e.stopPropagation(); setDraggedViewStepIdx(idx); }}
                        onDragEnd={() => { setDraggedViewStepIdx(null); setDragOverViewStepIdx(null); }}
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
                        title="Drag to reorder"
                      >
                        <GripIcon />
                      </span>
                      <input
                        type="checkbox"
                        checked={s.enabled !== false}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => handleToggleStepEnabled(viewingFlow.id, s.id, e.target.checked)}
                        title={s.enabled === false ? 'Skipped on the next run — check to include it again' : 'Uncheck to skip this step on the next run'}
                      />
                      <ChevronIcon className="chevron" />
                      <span className="step-number-badge" style={{ opacity: s.enabled === false ? 0.5 : 1 }}>{idx + 1}</span>
                      <b style={{ opacity: s.enabled === false ? 0.5 : 1, textDecoration: s.enabled === false ? 'line-through' : undefined }}>{s.name}</b>
                      {Number(s.delay_ms) > 0 && <span className="hint" title="Delay before this step runs">⏱ {formatDelaySeconds(s.delay_ms)}s</span>}
                      <button
                        className="btn-icon"
                        style={{ marginLeft: 'auto' }}
                        disabled={running || !flowEnvIds[viewingFlow.id]}
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleRunStep(viewingFlow.id, s.id); }}
                        title={flowEnvIds[viewingFlow.id] ? 'Run this step only' : 'Select an environment for this flow in the Flow List first'}
                        aria-label="Run this step only"
                      >
                        {runningStepId === s.id ? <span className="spinner" /> : <PlayIcon />}
                      </button>
                    </summary>

                    <div className="mono hint" style={{ fontSize: 12, marginTop: 10, marginLeft: 32 }}>
                      {s.method} {s.url_template}
                    </div>
                    {s.auth_credential_id && (() => {
                      const cred = authCredentials.find((c) => c.id === s.auth_credential_id);
                      return (
                        <div className="hint" style={{ fontSize: 12.5, marginTop: 6, marginLeft: 32 }}>
                          Authorization: {cred?.name || `#${s.auth_credential_id}`}{cred?.environment_name ? ` (${cred.environment_name})` : ''}{cred && ` — ${cred.type === 'web_login' ? 'Web Login' : 'Basic Auth'}`}
                        </div>
                      );
                    })()}

                    <div style={{ marginTop: 14, marginLeft: 32 }}>
                      <span className="field-label">Headers</span>
                      <JsonBlock value={headersForDisplay(s.headers)} />
                    </div>

                    {s.body_template != null && Object.keys(s.body_template).length > 0 && (
                      <div style={{ marginTop: 14, marginLeft: 32 }}>
                        <span className="field-label">Body ({s.body_type || 'json'})</span>
                        <JsonBlock value={s.body_template} formData={s.body_type === 'form-data'} />
                      </div>
                    )}

                    {(s.assertions || []).filter((a) => a.enabled !== false).length > 0 && (
                      <div style={{ marginTop: 14, marginLeft: 32 }}>
                        <span className="field-label">Assertions</span>
                        <div className="stack" style={{ gap: 4, marginTop: 4 }}>
                          {s.assertions.filter((a) => a.enabled !== false).map((a, i) => {
                            const parts = describeAssertionParts(a);
                            return (
                              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                                <span className="hint" style={{ fontSize: 10 }}>●</span>
                                <span>{parts.label}</span>
                                {parts.value !== '' && (
                                  <span className="mono" style={{ color: 'var(--text-dim)', overflowWrap: 'anywhere' }}>{parts.value}</span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {(s.extract || []).length > 0 && (
                      <div style={{ marginTop: 14, marginLeft: 32, fontSize: 12.5 }}>
                        <span className="field-label">Extract variable</span>
                        {s.extract.map((e, i) => <div key={i} className="mono">{e.variable} ← {e.path}</div>)}
                      </div>
                    )}
                  </details>
                ))}
              </div>
            </div>
          )}

          {editingFlow && (
            <div className="card" ref={newFlowPanelRef}>
              <div className="toolbar" style={{ marginBottom: 8 }}>
                <input
                  placeholder="Flow name (optional)"
                  value={editingFlow.name}
                  onChange={(e) => setEditingFlow({ ...editingFlow, name: e.target.value })}
                  style={{ flex: 1, minWidth: 0 }}
                />
                <button
                  className="btn-icon"
                  onClick={handleSaveFlow}
                  title="Save Flow"
                  aria-label="Save Flow"
                  style={{ color: 'var(--pass)' }}
                >
                  <CheckIcon />
                </button>
                <button
                  className="btn-icon"
                  onClick={() => setEditingFlow(null)}
                  title="Close"
                  aria-label="Close"
                >
                  <XIcon />
                </button>
              </div>
              <div className="toolbar" style={{ marginBottom: 4, flexWrap: 'wrap' }}>
                <select
                  value={editingFlow.folder_id ?? ''}
                  onChange={(e) => setEditingFlow({ ...editingFlow, folder_id: e.target.value ? Number(e.target.value) : null })}
                  style={{ flex: 1, minWidth: 0 }}
                >
                  <option value="">Select folder...</option>
                  {flattenFolders(folders).map((f) => <option key={f.id} value={f.id}>{folderOptionLabel(f)}</option>)}
                </select>
                <BulkSelectDropdown
                  placeholder="Select account"
                  title="Pick a credential, then choose whether to only fill empty steps or override every step's Authorization."
                  options={authCredentials}
                  groupBy={(c) => c.environment_name || 'No Environment'}
                  renderOption={(c) => (
                    <>
                      <span className="header-value-item-name">{c.name}</span>
                      <span className="badge neutral auth-type-badge">
                        {c.type === 'web_login' ? 'Web Login' : 'Basic Auth'}
                      </span>
                    </>
                  )}
                  onPick={(c) => setPendingAuthCredential(c)}
                />
                <BulkSelectDropdown
                  placeholder="Select x-token"
                  title="Pick a value, then choose whether to only fill empty steps or override every step's X-Token."
                  options={xTokenOptions}
                  groupBy={(h) => h.environment_name || 'No Environment'}
                  extraTopAction={{ label: 'Uncheck X-Token (all steps)', onClick: handleDisableXTokenForAll }}
                  renderOption={(h) => (
                    <>
                      <span className="header-value-item-name">{h.label || 'X-Token'}</span>
                      <span className="badge neutral mono header-value-item-value" title={h.value}>{h.value}</span>
                    </>
                  )}
                  onPick={(h) => setPendingXToken(h)}
                />
                <label style={{ flexShrink: 0, whiteSpace: 'nowrap', marginLeft: 'auto' }}>
                  <input
                    type="checkbox"
                    checked={editingFlow.stop_on_failure}
                    onChange={(e) => setEditingFlow({ ...editingFlow, stop_on_failure: e.target.checked })}
                  /> Stop if a step FAILs/ERRORs
                </label>
              </div>

              {pendingAuthCredential && (
                <div className="toolbar" style={{ gap: 8, background: 'var(--surface-2)', padding: '8px 10px', borderRadius: 8, marginBottom: 4 }}>
                  <span className="hint" style={{ fontSize: 12.5 }}>Apply "{pendingAuthCredential.name}" to:</span>
                  <button className="btn-quiet" onClick={() => handleApplyAuthCredential(pendingAuthCredential, false)}>
                    Fill empty steps ({editingFlow.steps.filter((s) => !s.authCredentialId && !stepUsesNonBearerAuth(s)).length})
                  </button>
                  <button className="btn-quiet" onClick={() => handleApplyAuthCredential(pendingAuthCredential, true)}>
                    Override all steps ({editingFlow.steps.filter((s) => !stepUsesNonBearerAuth(s)).length})
                  </button>
                  <button className="btn-icon" onClick={() => setPendingAuthCredential(null)} title="Cancel" style={{ marginLeft: 'auto' }}>
                    <XIcon />
                  </button>
                </div>
              )}

              {pendingXToken && (
                <div className="toolbar" style={{ gap: 8, background: 'var(--surface-2)', padding: '8px 10px', borderRadius: 8, marginBottom: 4 }}>
                  <span className="hint" style={{ fontSize: 12.5 }}>
                    Apply "{pendingXToken.label || 'X-Token'}{pendingXToken.environment_name ? ` (${pendingXToken.environment_name})` : ''}" to:
                  </span>
                  <button className="btn-quiet" onClick={() => handleApplyXToken(pendingXToken, false)}>
                    Fill empty steps ({editingFlow.steps.filter((s) => !hasActiveXToken(s)).length})
                  </button>
                  <button className="btn-quiet" onClick={() => handleApplyXToken(pendingXToken, true)}>
                    Override all steps ({editingFlow.steps.length})
                  </button>
                  <button className="btn-icon" onClick={() => setPendingXToken(null)} title="Cancel" style={{ marginLeft: 'auto' }}>
                    <XIcon />
                  </button>
                </div>
              )}

              <div className="card-row" style={{ marginTop: 20 }}>
                <h4 style={{ margin: 0 }}>Steps</h4>
                {editingFlow.steps.length > 0 && (
                  <button type="button" className="btn-quiet" onClick={handleToggleAllStepsEnabled}>
                    {allStepsEnabled ? 'Uncheck All' : 'Check All'}
                  </button>
                )}
              </div>
              <div className="stack">
                {editingFlow.steps.map((step, idx) => (
                  <div
                    key={idx}
                    className="panel"
                    ref={(el) => { stepRefs.current[idx] = el; }}
                    onDragOver={(e) => { e.preventDefault(); if (dragOverStepIdx !== idx) setDragOverStepIdx(idx); }}
                    onDragLeave={() => setDragOverStepIdx((i) => (i === idx ? null : i))}
                    onDrop={() => handleDropStep(idx)}
                    style={{
                      opacity: draggedStepIdx === idx ? 0.4 : 1,
                      borderTop: dragOverStepIdx === idx && draggedStepIdx !== idx ? '2px solid var(--accent)' : undefined,
                    }}
                  >
                    {idx !== expandedStep ? (
                      <div
                        className="toolbar"
                        style={{ cursor: 'pointer', border: stepErrors[idx] ? '1px solid var(--fail)' : undefined, borderRadius: 8, padding: stepErrors[idx] ? '6px 8px' : undefined }}
                        onClick={() => setExpandedStep(idx)}
                      >
                        <span
                          className="hint"
                          style={{ cursor: 'grab' }}
                          draggable
                          onDragStart={(e) => { e.stopPropagation(); setDraggedStepIdx(idx); }}
                          onDragEnd={() => { setDraggedStepIdx(null); setDragOverStepIdx(null); }}
                          onClick={(e) => e.stopPropagation()}
                          title="Drag to reorder"
                        >
                          <GripIcon />
                        </span>
                        <input
                          type="checkbox"
                          checked={step.enabled !== false}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => handleStepChange(idx, 'enabled', e.target.checked)}
                          title={step.enabled === false ? 'Skipped on the next run — check to include it again' : 'Uncheck to skip this step on the next run'}
                        />
                        <ChevronIcon />
                        <span className="step-number-badge" style={{ opacity: step.enabled === false ? 0.5 : 1 }}>{idx + 1}</span>
                        <span style={{ fontWeight: 600, opacity: step.enabled === false ? 0.5 : 1, textDecoration: step.enabled === false ? 'line-through' : undefined }}>{step.name || 'Untitled step'}</span>
                        {step.method && <span className="hint mono">{step.method}</span>}
                        {Number(step.delayMs) > 0 && <span className="hint" title="Delay before this step runs">⏱ {formatDelaySeconds(step.delayMs)}s</span>}
                        <div style={{ marginLeft: 'auto' }}>
                          <OptionsMenu
                            items={[
                              { label: 'Duplicate', icon: <CopyIcon />, onClick: () => handleDuplicateStep(idx) },
                              { label: 'Delete', icon: <TrashIcon />, onClick: () => handleRemoveStep(idx), danger: true },
                            ]}
                          />
                        </div>
                      </div>
                    ) : (
                    <>
                    <div className="toolbar" style={{ marginBottom: 8 }}>
                      <span
                        className="hint"
                        style={{ cursor: 'grab' }}
                        draggable
                        onDragStart={(e) => { e.stopPropagation(); setDraggedStepIdx(idx); }}
                        onDragEnd={() => { setDraggedStepIdx(null); setDragOverStepIdx(null); }}
                        title="Drag to reorder"
                      >
                        <GripIcon />
                      </span>
                      <input
                        type="checkbox"
                        checked={step.enabled !== false}
                        onChange={(e) => handleStepChange(idx, 'enabled', e.target.checked)}
                        title={step.enabled === false ? 'Skipped on the next run — check to include it again' : 'Uncheck to skip this step on the next run'}
                      />
                      <ChevronIcon style={{ transform: 'rotate(90deg)', cursor: 'pointer' }} onClick={() => setExpandedStep(null)} />
                      <span className="step-number-badge">{idx + 1}</span>
                      <input
                        placeholder="Step name (optional)"
                        value={step.name}
                        onChange={(e) => handleStepChange(idx, 'name', e.target.value)}
                        style={{ flex: 1 }}
                      />
                      <OptionsMenu
                        items={[
                          { label: 'Duplicate', icon: <CopyIcon />, onClick: () => handleDuplicateStep(idx) },
                          { label: 'Delete', icon: <TrashIcon />, onClick: () => handleRemoveStep(idx), danger: true },
                        ]}
                      />
                    </div>

                    <div className="toolbar" style={{ marginBottom: 8, flexWrap: 'nowrap' }}>
                      <FolderPillPicker
                        value={step.endpoint_id}
                        placeholder="Select endpoint"
                        options={endpoints}
                        folders={endpointFolders}
                        folderIdOf={(ep) => ep.folder_id ?? 'none'}
                        getLabel={(ep) => ep.name}
                        onPick={(ep) => handleSelectEndpoint(idx, String(ep.id))}
                        extraTopAction={{ label: 'Paste curl...', onClick: () => startCurlPaste(idx) }}
                        borderColor={stepErrors[idx]?.endpoint
                          ? 'var(--fail)'
                          : (!step.endpoint_id && !step.url_template ? 'var(--accent)' : undefined)}
                        singleLineTabs
                      />
                      {(step.endpoint_id || step.url_template) && (
                        <select
                          value={step.method}
                          onChange={(e) => handleStepChange(idx, 'method', e.target.value)}
                          style={{ flexShrink: 0 }}
                        >
                          {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                        </select>
                      )}
                      {step.url_template && (
                        <input
                          className="mono"
                          value={step.url_template}
                          onChange={(e) => handleStepChange(idx, 'url_template', e.target.value)}
                          title="Editing this only affects this step — the shared endpoint definition (and any other step using it) is unchanged."
                          style={{ flex: 1, minWidth: 0 }}
                        />
                      )}
                    </div>

                    {curlPasteIdx === idx && (
                      <div className="panel" style={{ marginBottom: 14, padding: 12 }}>
                        <textarea
                          autoFocus
                          placeholder="Paste a curl command here..."
                          value={curlPasteText}
                          onChange={(e) => setCurlPasteText(e.target.value)}
                          rows={6}
                          className="mono"
                          style={{ width: '100%' }}
                        />
                        {curlPasteError && <div className="hint" style={{ color: 'var(--fail)', marginTop: 6 }}>{curlPasteError}</div>}
                        <div className="toolbar" style={{ marginTop: 8 }}>
                          <button
                            className="btn-primary"
                            disabled={curlPasteLoading || !curlPasteText.trim()}
                            onClick={() => handleParseCurlForStep(idx)}
                          >
                            {curlPasteLoading ? 'Parsing...' : 'Parse & Fill Step'}
                          </button>
                          <button onClick={cancelCurlPaste}>Cancel</button>
                        </div>
                      </div>
                    )}

                    {((step.endpoint_id || step.url_template) || idx > 0) && (
                      <div className="toolbar" style={{ marginBottom: 8, flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                        {(step.endpoint_id || step.url_template) && (
                          <label
                            className="step-flag-chip"
                            title="Wait this many seconds before running this step — e.g. giving an async backend process time to finish first."
                          >
                            <span aria-hidden="true">⏱</span>
                            <input
                              type="number"
                              min="0"
                              step="0.1"
                              placeholder="0"
                              value={step.delayMs ? String(Number(step.delayMs) / 1000) : ''}
                              onChange={(e) => handleStepChange(idx, 'delayMs', e.target.value ? String(Number(e.target.value) * 1000) : '')}
                              className="step-flag-chip-input"
                            />
                            <span>s delay</span>
                          </label>
                        )}
                        {(step.endpoint_id || step.url_template) && (
                          <label
                            className={`step-flag-chip${step.responseType === 'base64' ? ' active' : ''}`}
                            title="JSON: a non-JSON/text response (e.g. a file download) is saved as a size-only placeholder. Base64: fetch the real response bytes so a downloaded file can be extracted/previewed instead of just a placeholder."
                          >
                            <input
                              type="checkbox"
                              checked={step.responseType === 'base64'}
                              onChange={(e) => handleStepChange(idx, 'responseType', e.target.checked ? 'base64' : 'auto')}
                            />
                            Response: {step.responseType === 'base64' ? 'Base64' : 'JSON'}
                          </label>
                        )}
                        {idx > 0 && (
                          <>
                            <label
                              className={`step-flag-chip${step.parallelWithPrevious === true ? ' active' : ''}`}
                              title="Runs at the same time as the previous step instead of waiting for it to finish."
                            >
                              <input
                                type="checkbox"
                                checked={step.parallelWithPrevious === true}
                                onChange={(e) => handleStepChange(idx, 'parallelWithPrevious', e.target.checked)}
                                disabled={!!step.runConditionStatusCode}
                              />
                              <ZapIcon aria-hidden="true" />
                              Run in parallel
                            </label>
                            <label
                              className={`step-flag-chip${step.runConditionStatusCode ? ' active' : ''}`}
                              title="Leave empty to always run this step. When set, this step is recorded as SKIPPED (never sent) unless the immediately preceding step's response status code equals this value."
                            >
                              <span className="step-flag-chip-badge">IF</span>
                              status
                              <input
                                type="number"
                                placeholder="any"
                                value={step.runConditionStatusCode}
                                onChange={(e) => handleRunConditionChange(idx, e.target.value)}
                                className="step-flag-chip-input"
                              />
                            </label>
                          </>
                        )}
                      </div>
                    )}

                    {(step.endpoint_id || step.url_template) && (
                    <details style={{ marginTop: 18, marginBottom: 14 }}>
                      <summary className="field-label"><ChevronIcon className="chevron" />Authorization</summary>
                      <div style={{ marginTop: 8 }}>
                        <AuthorizationField
                          credentials={authCredentials}
                          credentialId={step.authCredentialId}
                          rawValue={getAuthHeaderValue(step.headersRows)}
                          onChange={(patch) => handleAuthorizationFieldChange(idx, patch)}
                        />
                      </div>
                    </details>
                    )}

                    {(step.endpoint_id || step.url_template) && (
                    <details style={{ marginTop: 18, marginBottom: 14 }}>
                      <summary className="field-label"><ChevronIcon className="chevron" />Headers</summary>
                      <div style={{ marginTop: 8 }}>
                        <KeyValueEditor
                          // Authorization has its own field above — hiding it here too
                          // (rather than just leaving it visible-but-blank) is what stops
                          // someone from typing a second value into it under a different
                          // case (e.g. "authorization") that would then ride along
                          // alongside the credential's own header at request time.
                          rows={step.headersRows.filter((r) => r.key.trim().toLowerCase() !== 'authorization')}
                          onChange={(rows) => {
                            const authRow = step.headersRows.find((r) => r.key.trim().toLowerCase() === 'authorization');
                            handleStepChange(idx, 'headersRows', authRow ? [...rows, authRow] : rows);
                          }}
                        />
                      </div>
                    </details>
                    )}

                    {BODY_METHODS.includes(step.method) && (
                      <>
                        <div className="card-row" style={{ marginTop: 18, marginBottom: 10 }}>
                          <span className="field-label" style={{ margin: 0 }}>Body (Auto fill)</span>
                          <div className="toolbar">
                            <button
                              className={step.bodyType === 'json' ? 'btn-primary' : ''}
                              onClick={() => handleBodyTypeChange(idx, 'json')}
                            >
                              JSON
                            </button>
                            <button
                              className={step.bodyType === 'form-data' ? 'btn-primary' : ''}
                              onClick={() => handleBodyTypeChange(idx, 'form-data')}
                            >
                              Form Data
                            </button>
                          </div>
                        </div>
                        {step.bodyType === 'form-data' ? (
                          <div style={{ marginBottom: 16 }}>
                            <FormDataEditor
                              rows={step.bodyRows}
                              onChange={(rows) => handleStepChange(idx, 'bodyRows', rows)}
                            />
                          </div>
                        ) : (
                          <div style={{ marginBottom: 16 }}>
                            <JsonPasteEditor
                              value={step.bodyText}
                              onChange={(text) => handleStepChange(idx, 'bodyText', text)}
                              height={360}
                            />
                          </div>
                        )}
                      </>
                    )}

                    {(step.endpoint_id || step.url_template) && (
                    <>
                    <span className="field-label" style={{ marginTop: 18 }}>Assertions (Auto fill)</span>
                    <div style={{ marginBottom: 16 }}>
                      <AssertionsEditor
                        rows={step.assertionsRows}
                        onChange={(rows) => handleStepChange(idx, 'assertionsRows', rows)}
                      />
                    </div>

                    <details style={{ marginTop: 18 }}>
                      <summary className="field-label"><ChevronIcon className="chevron" />Extract variable from response (Optional)</summary>
                      <div style={{ marginTop: 8 }}>
                        <ExtractVariableEditor
                          rows={step.extractRows}
                          onChange={(rows) => handleStepChange(idx, 'extractRows', rows)}
                        />
                      </div>
                    </details>
                    </>
                    )}
                    </>
                    )}
                  </div>
                ))}
              </div>
              <button onClick={handleAddStep} style={{ margin: '12px 0' }}>+ Add Step</button>

              <div className="toolbar" style={{ justifyContent: 'flex-end' }}>
                {editingFlow.steps.length >= 7 && (
                  <button onClick={() => setEditingFlow(null)}>Cancel</button>
                )}
                <button
                  className={`btn-primary${canSaveFlow ? ' btn-ready' : ' btn-look-disabled'}`}
                  onClick={handleSaveFlow}
                >
                  Save Flow
                </button>
              </div>
            </div>
          )}

          {running && !runResult && !batchRunResult && (() => {
            return (
              <div className="card" ref={runningCardRef}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className="spinner" />
                  <span className="hint">{cancelling ? 'Cancelling…' : runningIsBatch ? 'Running batch…' : 'Running flow…'}</span>
                  {runningRepeatCount > 1 && (
                    <span className="hint">Repeat {repeatIndex} of {runningRepeatCount}</span>
                  )}
                  {liveTotalSteps > 0 && (
                    <span className="hint">{liveTotalSteps} step{liveTotalSteps === 1 ? '' : 's'} done so far</span>
                  )}
                  {runningToken && (
                    <button
                      className="btn-quiet"
                      style={{ marginLeft: 'auto' }}
                      disabled={cancelling}
                      onClick={handleCancelRun}
                      title={runningIsBatch
                        ? (runningParallel
                          ? "Stops every still-running flow at its own next step boundary — flows that already finished are kept."
                          : "Stops the batch at the next flow boundary — whichever flow is currently running finishes its own current step batch first, and flows already completed are kept.")
                        : 'Stops the run at the next step boundary — whatever already completed is kept.'}
                    >
                      Cancel
                    </button>
                  )}
                </div>
                {liveSegments.map((seg, segIdx) => (
                  seg.steps.length > 0 && (
                    <div key={segIdx} style={segIdx > 0 ? { marginTop: 20, paddingTop: 20, borderTop: '1px solid var(--border-soft)' } : { marginTop: 16 }}>
                      {runningIsBatch && (
                        <div className="field-label" style={{ marginBottom: 8 }}>{seg.flow_name}</div>
                      )}
                      <div className="stack" style={{ gap: 20 }}>
                        {seg.steps.map((s, idx) => (
                          <div key={s.step_order} ref={segIdx === fifthStepSegIdx && idx === fifthStepIdx ? fifthStepRef : undefined}>
                            <StepResultRow step={s} isLast={idx === seg.steps.length - 1} />
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                ))}
              </div>
            );
          })()}

          {runResult && (
            <div className="card">
              <div className="card-row">
                <h4 style={{ margin: 0 }}>
                  Run Result: {runResult.flow_name} — <span className={`badge ${runResult.flow_run.status.toLowerCase()}`}>{runResult.flow_run.status}</span>
                </h4>
                <div className="toolbar">
                  <OptionsMenu
                    label="Export"
                    title="Download this run result as a PDF, or share it straight to Telegram"
                    items={[
                      { label: 'Download PDF', icon: <DownloadIcon />, onClick: () => exportRunResultToPdf(runResult) },
                      { label: sharingRunResult ? 'Sharing...' : 'Share to Telegram', icon: <SendIcon />, onClick: handleShareRunResultToTelegram, disabled: sharingRunResult },
                    ]}
                  />
                  <button className="btn-quiet" onClick={() => setRunResult(null)}>✕ Close</button>
                </div>
              </div>
              <div className="hint" style={{ display: 'flex', gap: 16, fontSize: 12.5, marginTop: 4, flexWrap: 'wrap' }}>
                {runResult.environment_name && <span>Environment: {runResult.environment_name}</span>}
                <span>Run at {formatDateTime(runResult.flow_run.created_at)}</span>
                <span>Duration: {runResult.steps.reduce((sum, s) => sum + (s.response_time_ms || 0), 0)}ms</span>
                <span>{runResult.steps.length} step{runResult.steps.length === 1 ? '' : 's'}</span>
              </div>
              <div className="stack" style={{ marginTop: 16, gap: 20 }}>
                {runResult.steps.map((s, idx) => (
                  <StepResultRow key={s.step_order} step={s} isLast={idx === runResult.steps.length - 1} />
                ))}
              </div>
            </div>
          )}

          {batchRunResult && (
            <div className="card">
              <div className="card-row">
                <h4 style={{ margin: 0 }}>Batch Run Result</h4>
                <div className="toolbar">
                  <OptionsMenu
                    label="Export"
                    title="Download this batch run result as a PDF, or share it straight to Telegram"
                    items={[
                      { label: 'Download PDF', icon: <DownloadIcon />, onClick: () => exportBatchRunResultToPdf(batchRunResult) },
                      { label: sharingBatchRunResult ? 'Sharing...' : 'Share to Telegram', icon: <SendIcon />, onClick: handleShareBatchRunResultToTelegram, disabled: sharingBatchRunResult },
                    ]}
                  />
                  <button className="btn-quiet" onClick={() => setBatchRunResult(null)}>✕ Close</button>
                </div>
              </div>
              <div style={{ marginTop: 16 }}>
                <BatchResultsList results={batchRunResult.results} />
              </div>
            </div>
          )}

          {repeatResults && (
            <div className="card">
              <div className="card-row">
                <h4 style={{ margin: 0 }}>Run Selected x{runningRepeatCount} Result</h4>
                <div className="toolbar">
                  <OptionsMenu
                    label="Export"
                    title="Download this repeated batch run result as a PDF, or share it straight to Telegram"
                    items={[
                      { label: 'Download PDF', icon: <DownloadIcon />, onClick: handleDownloadRepeatResultsPdfs },
                      { label: sharingRepeatResults ? 'Sharing...' : 'Share to Telegram', icon: <SendIcon />, onClick: handleShareRepeatResultsToTelegram, disabled: sharingRepeatResults },
                    ]}
                  />
                  <button className="btn-quiet" onClick={() => setRepeatResults(null)}>✕ Close</button>
                </div>
              </div>
              <p className="hint" style={{ marginTop: 4 }}>
                {repeatResults.filter((rr) => batchPassAllFlows(rr.result)).length}/{repeatResults.length} repeat{repeatResults.length === 1 ? '' : 's'} fully passed
                {repeatResults.length < runningRepeatCount && !running ? ' — stopped early' : ''}
              </p>
              <div className="stack" style={{ marginTop: 16, gap: 8 }}>
                {repeatResults.map((rr, i) => {
                  const isOpen = expandedRepeatIdx === i;
                  const passed = batchPassAllFlows(rr.result);
                  return (
                    <div key={i} className="panel" style={{ padding: 0 }}>
                      <button
                        type="button"
                        onClick={() => setExpandedRepeatIdx(isOpen ? null : i)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                          padding: '10px 14px', background: 'transparent', border: 'none',
                          color: 'var(--text)', cursor: 'pointer', textAlign: 'left',
                        }}
                      >
                        <ChevronIcon style={{ transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)', flexShrink: 0 }} />
                        <b>Repeat {i + 1}</b>
                        {rr.error
                          ? <span className="badge fail">ERROR</span>
                          : <span className={`badge ${passed ? 'pass' : 'fail'}`}>{passed ? 'PASS' : 'FAIL'}</span>}
                      </button>
                      {isOpen && (
                        <div style={{ padding: '0 14px 14px' }}>
                          {rr.error && <div className="error-text" style={{ marginBottom: 8 }}>{rr.error}</div>}
                          {rr.result && <BatchResultsList results={rr.result.results} />}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
      <ScrollToTopButton active={!!(runResult || batchRunResult || repeatResults)} />
      <ScrollToTopButton active={running && liveTotalSteps >= 5 && scrolledPastFifthStep} skipBottomCheck />
    </div>
  );
}
