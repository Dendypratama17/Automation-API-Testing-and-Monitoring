import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CopyIcon, JsonDiffIcon } from './icons.jsx';
import { useToast } from './ToastProvider.jsx';
import OptionsMenu from './OptionsMenu.jsx';
import { writeJsonDiffDraft } from '../utils/jsonDiffDraft.js';
import { isTupleArray, stringifyBodyForDisplay as stringifyForDisplay } from '../utils/tupleBodyDisplay.js';

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
