import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CopyIcon, JsonDiffIcon } from './icons.jsx';
import { useToast } from './ToastProvider.jsx';
import OptionsMenu from './OptionsMenu.jsx';
import { writeJsonDiffDraft } from '../utils/jsonDiffDraft.js';

// A form-data request body is an array of [key, value] tuples rather than
// a plain {key: value} object — the only shape that can hold a repeated
// key (e.g. two separate "documents" file parts in one upload) without one
// silently overwriting the other (see FormDataEditor.jsx's formRowsToBody).
// Plain `JSON.stringify` renders that literally as nested arrays —
// `[\n  "key",\n  value\n],\n` per entry — which is technically correct but
// reads far more spaced-out than the old flat-object body ever did. This
// walks the same structure but renders a tuple array looking like a plain
// object (one "key": value line per entry, duplicates included) purely for
// this read-only display — real JSON.stringify still handles everything
// else (nested objects/arrays/primitives) exactly as before.
// A real API response can legitimately BE an array of 2-element string
// tuples (e.g. `[["us","United States"],["ca","Canada"]]`) — structure
// alone can't tell that apart from our own form-data body shape, and
// JsonBlock renders both Request AND Response bodies, so guessing wrong
// would silently corrupt what a real response looks like (including what
// gets copied/sent to JSON Diff). Requiring an actual `__file__`/
// `__file_url__` marker somewhere inside removes that ambiguity — no
// unrelated API response would ever happen to contain one of our internal
// markers, and it's exactly what's present in every real case this
// compacting was built for (a form-data body with an attached file).
//
// Callers that KNOW the value is a request body they built themselves (not
// a response from some external API) can pass `formData` to widen this to
// ANY tuple-shaped array, file attached or not — safe there because the
// tuple shape only ever comes from our own form-data body construction,
// never from whatever an API happens to send back.
function containsFileMarker(value) {
  if (Array.isArray(value)) return value.some(containsFileMarker);
  if (value && typeof value === 'object') {
    if (value.__file__ || value.__file_url__) return true;
    return Object.values(value).some(containsFileMarker);
  }
  return false;
}

function isTupleShaped(value) {
  return Array.isArray(value) && value.length > 0
    && value.every((el) => Array.isArray(el) && el.length === 2 && typeof el[0] === 'string');
}

function isTupleArray(value, loose) {
  if (!isTupleShaped(value)) return false;
  return loose || value.some(([, v]) => containsFileMarker(v));
}

function stringifyForDisplay(value, indent, loose) {
  const pad = '  '.repeat(indent);
  const childPad = '  '.repeat(indent + 1);
  if (isTupleArray(value, loose)) {
    const lines = value.map(([k, v]) => `${childPad}${JSON.stringify(k)}: ${stringifyForDisplay(v, indent + 1, loose)}`);
    return `{\n${lines.join(',\n')}\n${pad}}`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const lines = value.map((v) => `${childPad}${stringifyForDisplay(v, indent + 1, loose)}`);
    return `[\n${lines.join(',\n')}\n${pad}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    const lines = keys.map((k) => `${childPad}${JSON.stringify(k)}: ${stringifyForDisplay(value[k], indent + 1, loose)}`);
    return `{\n${lines.join(',\n')}\n${pad}}`;
  }
  return JSON.stringify(value);
}

// One row per form field, closer to what FormDataEditor itself shows while
// building the step — a file marker becomes an icon + filename instead of
// its raw {__file__: true, data: "...", ...} JSON shape.
function formFieldValue(v) {
  if (v && typeof v === 'object' && v.__file__) return `📎 ${v.name || 'file'}${v.mimeType ? ` (${v.mimeType})` : ''}`;
  if (v && typeof v === 'object' && v.__file_url__) return `🔗 ${v.name || v.url}`;
  if (typeof v === 'string') return v;
  return stringifyForDisplay(v, 0, false);
}

function FormDataView({ rows }) {
  return (
    <div className="json-block form-data-view">
      {rows.map(([k, v], i) => (
        <div className="form-data-view-row" key={`${k}-${i}`}>
          <span className="form-data-view-key">{k}</span>
          <span className="form-data-view-value">{formFieldValue(v)}</span>
        </div>
      ))}
    </div>
  );
}

export default function JsonBlock({ value, formData = false }) {
  const showToast = useToast();
  const navigate = useNavigate();
  const [viewMode, setViewMode] = useState('json');
  const canShowForm = isTupleArray(value, formData);
  const text = stringifyForDisplay(value ?? {}, 0, formData);

  const handleCopy = () => {
    navigator.clipboard.writeText(text)
      .then(() => showToast('Copied to clipboard.'))
      .catch(() => showToast('Failed to copy.', 'error'));
  };

  const handleSendToDiff = (side) => {
    writeJsonDiffDraft({ [side === 'A' ? 'jsonAText' : 'jsonBText']: text, diffs: null, locked: false });
    showToast(`Sent to JSON Diff as JSON ${side}.`);
    navigate('/json-diff');
  };

  return (
    <div>
      {canShowForm && (
        <div className="json-block-view-toggle">
          <button
            type="button"
            className={`json-block-view-btn${viewMode === 'json' ? ' active' : ''}`}
            onClick={() => setViewMode('json')}
          >
            JSON
          </button>
          <button
            type="button"
            className={`json-block-view-btn${viewMode === 'form' ? ' active' : ''}`}
            onClick={() => setViewMode('form')}
          >
            Form Data
          </button>
        </div>
      )}
      <div style={{ position: 'relative' }}>
        <div className="json-block-copy" style={{ display: 'flex', gap: 2 }}>
          <button
            className="btn-icon"
            onClick={handleCopy}
            title="Copy to clipboard"
            aria-label="Copy to clipboard"
          >
            <CopyIcon />
          </button>
          <OptionsMenu
            icon={<JsonDiffIcon />}
            title="Send to JSON Diff"
            items={[
              { label: 'Send as JSON A', onClick: () => handleSendToDiff('A') },
              { label: 'Send as JSON B', onClick: () => handleSendToDiff('B') },
            ]}
          />
        </div>
        {canShowForm && viewMode === 'form' ? <FormDataView rows={value} /> : <pre className="json-block">{text}</pre>}
      </div>
    </div>
  );
}
