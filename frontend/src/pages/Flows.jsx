import React, { useEffect, useRef, useState } from 'react';
import {
  getFolders, createFolder, updateFolder, deleteFolder,
  getFlows, getFlow, createFlow, updateFlow, deleteFlow, duplicateFlow, reorderFlows,
  runFlow, batchRunFlows, runFlowStep, getEndpoints, getEnvironments, getAuthCredentials, getDefaultHeaders,
} from '../api/client';
import JsonBlock from '../components/JsonBlock.jsx';
import KeyValueEditor, { objectToRows, rowsToObject } from '../components/KeyValueEditor.jsx';
import FormDataEditor, { objectToFormRows, formRowsToObject, emptyFormRow } from '../components/FormDataEditor.jsx';
import { TrashIcon, EditIcon, PlayIcon, ChevronIcon, CopyIcon, GripIcon, FolderIcon, XIcon } from '../components/icons.jsx';
import FolderTree from '../components/FolderTree.jsx';
import AssertionsEditor, { objectToAssertionRows, assertionRowsToArray, emptyAssertionRow } from '../components/AssertionsEditor.jsx';
import ExtractVariableEditor, { arrayToExtractRows, extractRowsToArray } from '../components/ExtractVariableEditor.jsx';
import { useConfirm } from '../components/ConfirmProvider.jsx';
import { useToast } from '../components/ToastProvider.jsx';
import OptionsMenu from '../components/OptionsMenu.jsx';
import { describeAssertionParts } from '../utils/assertionDescriptions.js';
import AssertionStatusIcon from '../components/AssertionStatusIcon.jsx';
import { flattenFolders, folderOptionLabel } from '../utils/folderTree.js';
import { exportRunResultToPdf } from '../utils/exportRunResultPdf.js';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const BODY_METHODS = ['POST', 'PUT'];

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

// Just the path, not the full {{base_url}}-resolved URL — keeps the run
// result compact and readable (matches the Dashboard's Resource column).
function resourcePath(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
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
  return body;
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
        {step.request_method} {resourcePath(step.request_url)}
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
            background: 'var(--fail-bg)', color: 'var(--fail)', fontSize: 12.5,
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

      {(step.request_headers != null || step.response_headers != null) && (
        <details style={{ marginTop: 10 }}>
          <summary className="field-label"><ChevronIcon className="chevron" />Headers</summary>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 8 }}>
            <div style={{ minWidth: 0 }}>
              {step.request_headers != null && (
                <>
                  <span className="field-label">Request Headers</span>
                  <JsonBlock value={step.request_headers} />
                </>
              )}
            </div>
            <div style={{ minWidth: 0 }}>
              {step.response_headers != null && (
                <>
                  <span className="field-label">Response Headers</span>
                  <JsonBlock value={step.response_headers} />
                </>
              )}
            </div>
          </div>
        </details>
      )}

      {(step.request_body != null || step.response_body != null) && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 14 }}>
          <div style={{ minWidth: 0 }}>
            {step.request_body != null && (
              <>
                <span className="field-label">Request Body</span>
                <JsonBlock value={step.request_body} />
              </>
            )}
          </div>
          <div style={{ minWidth: 0 }}>
            {step.response_body != null && (
              <>
                <span className="field-label">Response Body</span>
                <JsonBlock value={step.response_body} />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Unwraps the { __disabled__: true, value } shape a disabled header row is
// stored as (see KeyValueEditor.jsx) into something readable in a plain
// JSON viewer, instead of showing the wrapper object as-is.
function headersForDisplay(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    out[key] = value && typeof value === 'object' && value.__disabled__ ? `${value.value} (disabled)` : value;
  }
  return out;
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
    extractRows: [], assertionsRows: [],
  };
};

function stepToPayload(step, endpoints) {
  if (!step.endpoint_id) throw new Error(`Step "${step.name || '(unnamed)'}" hasn't selected an endpoint`);
  const endpoint = endpoints.find((e) => e.id === Number(step.endpoint_id));
  const name = step.name.trim() || endpoint?.name || 'Untitled step';
  const headers = rowsToObject(step.headersRows);
  let body_template = null;
  if (BODY_METHODS.includes(step.method)) {
    if (step.bodyType === 'form-data') {
      body_template = formRowsToObject(step.bodyRows);
    } else {
      try { body_template = step.bodyText.trim() ? JSON.parse(step.bodyText) : null; }
      catch { throw new Error(`Body in step "${step.name}" is not valid JSON`); }
    }
  }
  const extract = extractRowsToArray(step.extractRows);
  const assertions = assertionRowsToArray(step.assertionsRows);

  return {
    endpoint_id: Number(step.endpoint_id),
    auth_credential_id: step.authCredentialId ? Number(step.authCredentialId) : null,
    name,
    method: step.method,
    url_template: step.url_template,
    headers,
    body_template,
    body_type: step.bodyType,
    extract,
    assertions,
  };
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
    bodyText: s.body_template ? JSON.stringify(s.body_template, null, 2) : '',
    bodyRows: objectToFormRows(s.body_template),
    extractRows: arrayToExtractRows(s.extract),
    assertionsRows: objectToAssertionRows(s.assertions),
  };
}

export default function Flows() {
  const confirm = useConfirm();
  const showToast = useToast();
  const [folders, setFolders] = useState([]);
  const [selectedFolderId, setSelectedFolderId] = useState('all'); // 'all' | 'null' | number
  const [flows, setFlows] = useState([]);
  const [endpoints, setEndpoints] = useState([]);
  const [endpointFolders, setEndpointFolders] = useState([]);
  const [environments, setEnvironments] = useState([]);
  const [selectedEnv, setSelectedEnv] = useState(null);
  const [envError, setEnvError] = useState(false);
  const [authCredentials, setAuthCredentials] = useState([]);
  const [defaultHeaders, setDefaultHeaders] = useState([]);

  const [editingFlow, setEditingFlow] = useState(null);
  const [viewingFlow, setViewingFlow] = useState(null);
  const [expandedStep, setExpandedStep] = useState(0);
  const [stepErrors, setStepErrors] = useState({});
  const [flowNameError, setFlowNameError] = useState(false);
  const flowNameRef = useRef(null);
  const [error, setError] = useState('');
  const [runResult, setRunResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [runningFlowId, setRunningFlowId] = useState(null);
  const [runningStepId, setRunningStepId] = useState(null);
  const [selectedFlowIds, setSelectedFlowIds] = useState(new Set());
  const [batchRunResult, setBatchRunResult] = useState(null);
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
  // created) instead of "All Flows" — only once, right after folders first
  // load, so it never overrides a folder the user picked afterward.
  const didAutoSelectFolder = useRef(false);
  useEffect(() => {
    if (didAutoSelectFolder.current || folders.length === 0) return;
    didAutoSelectFolder.current = true;
    const rootFolders = folders.filter((f) => (f.parent_id ?? null) === null);
    if (rootFolders.length === 0) return;
    const oldest = rootFolders.reduce((a, b) => (a.id < b.id ? a : b));
    setSelectedFolderId(oldest.id);
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
      if (selectedFolderId === id) setSelectedFolderId('all');
    }
  };

  const openNewFlow = () => {
    setRunResult(null);
    setError('');
    setExpandedStep(0);
    setStepErrors({});
    setFlowNameError(false);
    setViewingFlow(null);
    setEditingFlow({
      name: '', description: '',
      folder_id: typeof selectedFolderId === 'number' ? selectedFolderId : null,
      stop_on_failure: true,
      web_login_credential_id: null,
      steps: [emptyStep(defaultHeaders)],
    });
  };

  const openFlow = async (id) => {
    setRunResult(null);
    setError('');
    setExpandedStep(null);
    setStepErrors({});
    setFlowNameError(false);
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
        web_login_credential_id: viewingFlow.web_login_credential_id,
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
      try { parsed = step.bodyText.trim() ? JSON.parse(step.bodyText) : {}; } catch { parsed = undefined; }
      if (parsed === undefined) {
        steps[idx] = { ...step, bodyType: type };
      } else {
        // A file row's real fileMeta must never be replaced by the "<N bytes
        // omitted>" placeholder that JSON.parse would otherwise hand back —
        // keep whatever real data bodyRows already had for that key.
        const existingFileMetaByKey = Object.fromEntries(
          step.bodyRows.filter((r) => r.type === 'file' && r.fileMeta).map((r) => [r.key, r.fileMeta])
        );
        const newRows = objectToFormRows(parsed).map((r) => (
          r.type === 'file' && !r.fileMeta && existingFileMetaByKey[r.key]
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
    // a sane pass/fail check — POST creates a resource (201), everything
    // else just returns it (200). Only added when the step doesn't already
    // have one, so it never overwrites something the user already set up.
    //
    // Exception: orchestrator-eternals/resources/ aggregator endpoints are
    // POST-shaped RPC calls (e.g. AggregateGetDocumentIndexesByDocumentID)
    // that just query/read data, not create a resource — always 200 even
    // though the method is POST.
    const isAggregatorEndpoint = ep?.path_template?.includes('orchestrator-eternals/resources/');
    const defaultExpectedStatus = isAggregatorEndpoint ? 200 : (method === 'POST' ? 201 : 200);
    const hasStatusCodeAssertion = steps[idx].assertionsRows.some((r) => r.type === 'status_code');
    const assertionsRows = ep && !hasStatusCodeAssertion
      ? [{ ...emptyAssertionRow(), expected: String(defaultExpectedStatus) }, ...steps[idx].assertionsRows]
      : steps[idx].assertionsRows;
    steps[idx] = {
      ...steps[idx],
      endpoint_id: endpointId,
      url_template: ep ? ep.path_template : '',
      method,
      headersRows: ep ? objectToRows(ep.headers) : steps[idx].headersRows,
      bodyType: ep ? (ep.body_type || 'json') : steps[idx].bodyType,
      bodyText: ep && ep.body_template && Object.keys(ep.body_template).length
        ? JSON.stringify(ep.body_template, null, 2)
        : '',
      bodyRows: ep ? objectToFormRows(ep.body_template) : steps[idx].bodyRows,
      assertionsRows,
    };
    setEditingFlow({ ...editingFlow, steps });
  };


  const refreshFlowList = () => loadFlows(selectedFolderId === 'all' ? undefined : selectedFolderId);

  const handleSaveFlow = async () => {
    setError('');

    const nameInvalid = !editingFlow.name.trim();
    setFlowNameError(nameInvalid);

    const errors = {};
    editingFlow.steps.forEach((step, idx) => {
      const e = {};
      if (!step.endpoint_id) e.endpoint = true;
      if (Object.keys(e).length) errors[idx] = e;
    });
    setStepErrors(errors);
    if (nameInvalid || Object.keys(errors).length) {
      if (nameInvalid) {
        flowNameRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        const firstErrorIdx = Number(Object.keys(errors)[0]);
        setExpandedStep(firstErrorIdx);
        // Wait a tick for the step to expand (its height changes) before
        // measuring where to scroll, so it doesn't land in the wrong spot.
        setTimeout(() => {
          stepRefs.current[firstErrorIdx]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 0);
      }
      return;
    }

    try {
      const steps = editingFlow.steps.map((step) => stepToPayload(step, endpoints));
      const payload = {
        name: editingFlow.name,
        description: editingFlow.description,
        folder_id: editingFlow.folder_id,
        stop_on_failure: editingFlow.stop_on_failure,
        web_login_credential_id: editingFlow.web_login_credential_id || null,
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
      web_login_credential_id: flow.web_login_credential_id,
      steps: flow.steps,
    });
    refreshFlowList();
  };

  const handleRunFlow = async (flowId, confirmProd = false) => {
    if (!selectedEnv) {
      setEnvError(true);
      return;
    }
    setEditingFlow(null);
    setViewingFlow(null);
    setRunning(true);
    setRunningFlowId(flowId);
    setRunResult(null);
    setBatchRunResult(null);
    setError('');
    // When we hand off to a recursive confirmed-run call below, that call
    // owns clearing running/runningFlowId in its own finally — this outer
    // finally must not stomp on it while the confirmed run is still in flight.
    let handedOff = false;
    try {
      const res = await runFlow(flowId, { environment_id: selectedEnv, confirm_prod: confirmProd });
      setRunResult({ ...res, flow_name: flows.find((f) => f.id === flowId)?.name || 'Flow' });
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
      }
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

  // Runs every selected flow in sequence against one environment, chaining
  // each flow's extracted variables into the next (e.g. Login then Get
  // Profile reusing the token Login extracted) — see routes/flows.js /batch-run.
  const handleBatchRun = async (confirmProd = false) => {
    if (!selectedEnv) {
      setEnvError(true);
      return;
    }
    setEditingFlow(null);
    setViewingFlow(null);
    setRunning(true);
    setRunResult(null);
    setBatchRunResult(null);
    setError('');
    let handedOff = false;
    try {
      const res = await batchRunFlows({
        // Follow the Flow List's current visual/drag order, not the Set's
        // insertion order (which is whichever order the checkboxes were
        // clicked in and can drift from the list after a reorder).
        flow_ids: flows.filter((f) => selectedFlowIds.has(f.id)).map((f) => f.id),
        environment_id: selectedEnv,
        confirm_prod: confirmProd,
      });
      setBatchRunResult(res);
    } catch (err) {
      if (err.response?.status === 412) {
        if (await confirm(err.response.data.message + ' Continue?')) {
          handedOff = true;
          await handleBatchRun(true);
          return;
        }
      } else {
        setError(err.response?.data?.error || err.message);
      }
    } finally {
      if (!handedOff) {
        setRunning(false);
      }
    }
  };

  // Runs one step in isolation (no chaining from other steps) — for quickly
  // re-testing a single request from the read-only View Flow panel without
  // re-running the whole flow, and without losing that panel's context.
  const handleRunStep = async (flowId, stepId, confirmProd = false) => {
    if (!selectedEnv) {
      setEnvError(true);
      return;
    }
    setRunning(true);
    setRunningStepId(stepId);
    setRunResult(null);
    setBatchRunResult(null);
    setError('');
    let handedOff = false;
    try {
      const res = await runFlowStep(flowId, stepId, { environment_id: selectedEnv, confirm_prod: confirmProd });
      setRunResult({ ...res, flow_name: flows.find((f) => f.id === flowId)?.name || 'Flow' });
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

  // Save Flow stays disabled (and quiet) until every required field is
  // actually filled in — a name, and every step pointed at an endpoint.
  const canSaveFlow = !!(editingFlow && editingFlow.name.trim() && editingFlow.steps.every((s) => s.endpoint_id));

  const folderNameById = Object.fromEntries(endpointFolders.map((f) => [f.id, f.name]));
  const endpointsByFolder = endpoints.reduce((acc, ep) => {
    const key = ep.folder_id ?? 'none';
    if (!acc[key]) acc[key] = [];
    acc[key].push(ep);
    return acc;
  }, {});

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
            onSelect={(folderId) => { setSelectedFolderId(folderId); setViewingFlow(null); }}
            onCreateFolder={handleCreateFolder}
            onDeleteFolder={handleDeleteFolder}
            onRenameFolder={handleRenameFolder}
            allLabel="All Flows"
          />
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="card">
            <div className="card-row">
              <h4 style={{ margin: 0 }}>Flow List</h4>
              <div className="toolbar">
                <select
                  value={selectedEnv || ''}
                  onChange={(e) => { setSelectedEnv(e.target.value ? Number(e.target.value) : null); setEnvError(false); }}
                  style={{ borderColor: envError ? 'var(--fail)' : undefined }}
                >
                  <option value="">Select Environment</option>
                  {environments.map((env) => (
                    <option key={env.id} value={env.id}>{env.name}{env.is_protected ? ' (protected)' : ''}</option>
                  ))}
                </select>
                {selectedFlowIds.size > 0 && (
                  <button className="btn-primary" onClick={() => handleBatchRun()} disabled={running}>
                    Run Selected ({selectedFlowIds.size})
                  </button>
                )}
                <button className="btn-primary" onClick={openNewFlow}>+ New Flow</button>
              </div>
            </div>
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
                  <th style={{ width: 480 }}>Name</th>
                  <th style={{ width: 80 }}>Steps</th>
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
                      <span className="truncate" style={{ width: 440 }}>{f.name}</span>
                    </td>
                    <td>{f.step_count}</td>
                    <td className="row-actions">
                      <button
                        className="btn-icon"
                        onClick={(e) => { e.stopPropagation(); handleRunFlow(f.id); }}
                        disabled={running}
                        title="Run"
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
                    </td>
                  </tr>
                ))}
                {flows.length === 0 && <tr><td colSpan={5} className="empty-state">No flows yet.</td></tr>}
              </tbody>
            </table>
          </div>

          {error && <div className="card error-text">{error}</div>}

          {viewingFlow && (
            <div className="card">
              <div className="card-row">
                <h4 style={{ margin: 0 }}>View Flow: {viewingFlow.name}</h4>
                <div className="toolbar">
                  {reorderingViewSteps && <span className="hint">Saving order…</span>}
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
                      <ChevronIcon className="chevron" />
                      <span className="step-number-badge">{idx + 1}</span>
                      <b>{s.name}</b>
                      <button
                        className="btn-icon"
                        style={{ marginLeft: 'auto' }}
                        disabled={running}
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleRunStep(viewingFlow.id, s.id); }}
                        title="Run this step only"
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
                          Authorization: {cred?.name || `#${s.auth_credential_id}`}{cred?.environment_name ? ` (${cred.environment_name})` : ''}
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
                        <JsonBlock value={s.body_template} />
                      </div>
                    )}

                    {(s.assertions || []).length > 0 && (
                      <div style={{ marginTop: 14, marginLeft: 32 }}>
                        <span className="field-label">Assertions</span>
                        <div className="stack" style={{ gap: 4, marginTop: 4 }}>
                          {s.assertions.map((a, i) => {
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
            <div className="card" ref={flowNameRef}>
              <div className="card-row">
                <h4 style={{ margin: 0 }}>{editingFlow.id ? `Edit Flow: ${editingFlow.name}` : 'New Flow'}</h4>
                <button
                  className="btn-icon"
                  onClick={() => setEditingFlow(null)}
                  title="Close"
                  aria-label="Close"
                >
                  <XIcon />
                </button>
              </div>
              <div className="toolbar" style={{ marginBottom: 4, flexWrap: 'nowrap' }}>
                <input
                  placeholder="Flow name..."
                  value={editingFlow.name}
                  onChange={(e) => {
                    setEditingFlow({ ...editingFlow, name: e.target.value });
                    if (e.target.value.trim() && flowNameError) setFlowNameError(false);
                  }}
                  style={{ flex: 1, minWidth: 0, borderColor: flowNameError ? 'var(--fail)' : undefined }}
                />
                <select
                  value={editingFlow.folder_id ?? ''}
                  onChange={(e) => setEditingFlow({ ...editingFlow, folder_id: e.target.value ? Number(e.target.value) : null })}
                  style={{ flexShrink: 0 }}
                >
                  <option value="">Select folder...</option>
                  {flattenFolders(folders).map((f) => <option key={f.id} value={f.id}>{folderOptionLabel(f)}</option>)}
                </select>
                <select
                  value={editingFlow.web_login_credential_id ?? ''}
                  onChange={(e) => setEditingFlow({ ...editingFlow, web_login_credential_id: e.target.value ? Number(e.target.value) : null })}
                  style={{ flexShrink: 0 }}
                  title="On every run, refreshes the Authorization header of every step that already has one set — no per-step assignment needed."
                >
                  <option value="">No Web Login refresh</option>
                  {authCredentials.filter((c) => c.type === 'web_login').map((c) => (
                    <option key={c.id} value={c.id}>Refresh auth via: {c.name}</option>
                  ))}
                </select>
                <label style={{ flexShrink: 0, whiteSpace: 'nowrap', marginLeft: 'auto' }}>
                  <input
                    type="checkbox"
                    checked={editingFlow.stop_on_failure}
                    onChange={(e) => setEditingFlow({ ...editingFlow, stop_on_failure: e.target.checked })}
                  /> Stop if a step FAILs/ERRORs
                </label>
              </div>

              <h4 style={{ marginTop: 20 }}>Steps</h4>
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
                        <ChevronIcon />
                        <span className="step-number-badge">{idx + 1}</span>
                        <span style={{ fontWeight: 600 }}>{step.name || 'Untitled step'}</span>
                        {step.method && <span className="hint mono">{step.method}</span>}
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
                      <ChevronIcon style={{ transform: 'rotate(90deg)', cursor: 'pointer' }} onClick={() => setExpandedStep(null)} />
                      <span className="step-number-badge">{idx + 1}</span>
                      <input
                        placeholder="Step name (defaults to endpoint name if left blank)"
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
                      <select
                        value={step.endpoint_id}
                        onChange={(e) => handleSelectEndpoint(idx, e.target.value)}
                        style={{ flex: 1, minWidth: 0, borderColor: stepErrors[idx]?.endpoint ? 'var(--fail)' : undefined }}
                      >
                        <option value="">Select endpoint</option>
                        {Object.entries(endpointsByFolder).map(([key, list]) => (
                          <optgroup key={key} label={key === 'none' ? 'No Folder' : (folderNameById[key] || 'Folder')}>
                            {list.map((ep) => <option key={ep.id} value={ep.id}>{ep.name}</option>)}
                          </optgroup>
                        ))}
                      </select>
                      {step.endpoint_id && (
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
                          disabled
                          title={step.url_template}
                          style={{ flex: 1, minWidth: 0 }}
                        />
                      )}
                    </div>

                    {step.endpoint_id && (
                    <details style={{ marginTop: 18, marginBottom: 14 }}>
                      <summary className="field-label"><ChevronIcon className="chevron" />Authorization</summary>
                      <select
                        value={step.authCredentialId}
                        onChange={(e) => handleStepChange(idx, 'authCredentialId', e.target.value)}
                        style={{ width: '100%', marginTop: 8 }}
                      >
                        <option value="">None</option>
                        {authCredentials.map((cred) => (
                          <option key={cred.id} value={cred.id}>
                            {cred.name}{cred.environment_name ? ` (${cred.environment_name})` : ''}
                          </option>
                        ))}
                      </select>
                    </details>
                    )}

                    {step.endpoint_id && (
                    <details style={{ marginTop: 18, marginBottom: 14 }}>
                      <summary className="field-label"><ChevronIcon className="chevron" />Headers</summary>
                      <div style={{ marginTop: 8 }}>
                        <KeyValueEditor
                          rows={step.headersRows}
                          onChange={(rows) => handleStepChange(idx, 'headersRows', rows)}
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
                          <textarea
                            value={step.bodyText}
                            onChange={(e) => handleStepChange(idx, 'bodyText', e.target.value)}
                            rows={16}
                            className="mono"
                            style={{ width: '100%', marginBottom: 16 }}
                          />
                        )}
                      </>
                    )}

                    {step.endpoint_id && (
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

          {running && !runResult && !batchRunResult && (
            <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="spinner" />
              <span className="hint">Running flow…</span>
            </div>
          )}

          {runResult && (
            <div className="card">
              <div className="card-row">
                <h4 style={{ margin: 0 }}>
                  Run Result — <span className={`badge ${runResult.flow_run.status.toLowerCase()}`}>{runResult.flow_run.status}</span>
                </h4>
                <div className="toolbar">
                  <button onClick={() => exportRunResultToPdf(runResult)}>Export PDF</button>
                  <button className="btn-quiet" onClick={() => setRunResult(null)}>✕ Close</button>
                </div>
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
                <button className="btn-quiet" onClick={() => setBatchRunResult(null)}>✕ Close</button>
              </div>
              <div className="stack" style={{ marginTop: 16, gap: 24 }}>
                {batchRunResult.results.map((r, fIdx) => (
                  <div
                    key={r.flow_id}
                    style={fIdx < batchRunResult.results.length - 1 ? { borderBottom: '2px solid var(--border)', paddingBottom: 24 } : undefined}
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
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
