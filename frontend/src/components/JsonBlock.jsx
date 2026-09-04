import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { CopyIcon, JsonDiffIcon, EyeIcon, XIcon } from './icons.jsx';
import { useToast } from './ToastProvider.jsx';
import OptionsMenu from './OptionsMenu.jsx';
import { writeJsonDiffDraft } from '../utils/jsonDiffDraft.js';
import { isTupleArray, stringifyBodyForDisplay as stringifyForDisplay } from '../utils/tupleBodyDisplay.js';
import { tokenizeJsonLine } from '../utils/jsonTextHighlight.js';

// Same per-token palette as JsonPasteEditor's live editor, applied here to
// this read-only view too — Request/Response Body in a run result used to
// be one flat color, unlike every other JSON view in the app.
const TOKEN_COLOR = {
  key: 'var(--text)',
  string: 'var(--drift)',
  number: 'var(--pass)',
  boolean: 'var(--pass)',
  null: 'var(--pass)',
  punct: 'var(--text-dim)',
  plain: 'var(--text)',
};

function ColoredJsonText({ text, style }) {
  return (
    <pre className="json-block" style={style}>
      {text.split('\n').map((line, i) => (
        <div key={i}>
          {line.length === 0
            ? ' '
            : tokenizeJsonLine(line).map((tok, ti) => (
              <span key={ti} style={{ color: TOKEN_COLOR[tok.type] }}>{tok.text}</span>
            ))}
        </div>
      ))}
    </pre>
  );
}

// A step's response that isn't JSON/text (a downloaded PDF, ZIP, ...) is
// stored as this marker object — see flowExecutor.js's
// sanitizeBinaryResponseData. `data` (base64) is only present when the step
// opted into `response_type: 'base64'`; otherwise this is just a size/type
// placeholder with nothing to preview.
function isBinaryResponse(value) {
  return !!(value && typeof value === 'object' && value.__binary_response__ === true);
}

function formatBytes(n) {
  if (n == null) return 'unknown size';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// A download endpoint commonly declares a generic Content-Type
// (application/octet-stream, or nothing useful) even when the bytes are
// really a PDF/image the browser is perfectly able to render inline — a
// Blob opened with that generic type gets force-downloaded instead of
// previewed, since the browser has no way to know it's actually renderable.
// Sniffing the real format from its magic-number header (the same trick
// browsers/OSes themselves use for "detect file type") and overriding the
// Blob's type with that is what makes `window.open` show it in Chrome's
// native PDF/image viewer instead of triggering "Save As".
function sniffMimeType(bytes, declaredType) {
  const sig = (...expected) => expected.every((b, i) => bytes[i] === b);
  if (sig(0x25, 0x50, 0x44, 0x46)) return 'application/pdf'; // %PDF
  if (sig(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (sig(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (sig(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  return declaredType || 'application/octet-stream';
}

function BinaryResponseView({ value }) {
  const showToast = useToast();
  const handlePreview = () => {
    try {
      const byteChars = atob(value.data);
      const bytes = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
      const blob = new Blob([bytes], { type: sniffMimeType(bytes, value.content_type) });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      // Revoked well after the new tab has had time to load the blob — the
      // URL only needs to live long enough for that one navigation.
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch {
      showToast('Failed to open preview — the captured data looks corrupted.', 'error');
    }
  };

  return (
    <div className="json-block binary-response-view">
      <div>📦 Binary response — {value.content_type || 'unknown type'} · {formatBytes(value.approx_bytes)}</div>
      {value.data ? (
        <button type="button" className="btn-quiet" style={{ marginTop: 8, border: '1px solid var(--border)', borderRadius: 6, padding: '4px 10px' }} onClick={handlePreview}>
          Preview
        </button>
      ) : (
        <p className="hint" style={{ marginTop: 6, fontSize: 12, marginBottom: 0 }}>
          Only the size/type was captured. Set this step's "Response: Base64" option and run it again to preview the actual file.
        </p>
      )}
    </div>
  );
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
  const isBinary = isBinaryResponse(value);
  const canShowForm = !isBinary && isTupleArray(value, formData);
  // A body that's actually form-data reads better as form fields by default
  // — only falls back to JSON as the initial tab when there's nothing to
  // show as Form Data at all.
  const [viewMode, setViewMode] = useState(canShowForm ? 'form' : 'json');
  const [previewOpen, setPreviewOpen] = useState(false);
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
      {/* Rendered (with the buttons merely hidden, not omitted) even when this
          particular value has no Form Data view — Request/Response Body sit
          side by side in a two-column grid, and only one side commonly has a
          form-data body; omitting this row entirely on the other side would
          leave its box starting higher than its sibling's. */}
      <div className="json-block-view-toggle" style={canShowForm ? undefined : { visibility: 'hidden' }} aria-hidden={!canShowForm}>
        <button
          type="button"
          className={`json-block-view-btn${viewMode === 'json' ? ' active' : ''}`}
          onClick={() => setViewMode('json')}
          tabIndex={canShowForm ? 0 : -1}
        >
          JSON
        </button>
        <button
          type="button"
          className={`json-block-view-btn${viewMode === 'form' ? ' active' : ''}`}
          onClick={() => setViewMode('form')}
          tabIndex={canShowForm ? 0 : -1}
        >
          Form Data
        </button>
      </div>
      <div style={{ position: 'relative' }}>
        {!isBinary && (
          <div className="json-block-copy">
            <OptionsMenu
              title="JSON actions"
              items={[
                { label: 'Copy JSON', icon: <CopyIcon />, onClick: handleCopy },
                { label: 'Preview JSON', icon: <EyeIcon />, onClick: () => setPreviewOpen(true) },
                {
                  label: 'Send as JSON',
                  icon: <JsonDiffIcon />,
                  submenu: [
                    { label: 'Send as JSON A', onClick: () => handleSendToDiff('A') },
                    { label: 'Send as JSON B', onClick: () => handleSendToDiff('B') },
                  ],
                },
              ]}
            />
          </div>
        )}
        {isBinary
          ? <BinaryResponseView value={value} />
          : (canShowForm && viewMode === 'form' ? <FormDataView rows={value} /> : <ColoredJsonText text={text} />)}
      </div>
      {previewOpen && createPortal(
        <div className="modal-overlay" onClick={() => setPreviewOpen(false)}>
          <div
            className="modal-card"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 900, width: '90vw', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}
          >
            <div className="card-row" style={{ marginBottom: 12, flexShrink: 0 }}>
              <h4 style={{ margin: 0 }}>Preview JSON</h4>
              <div className="toolbar">
                <button className="btn-quiet" onClick={handleCopy}>
                  <CopyIcon /> Copy
                </button>
                <button className="btn-icon" onClick={() => setPreviewOpen(false)} title="Close" aria-label="Close">
                  <XIcon />
                </button>
              </div>
            </div>
            <div style={{ overflow: 'auto', flex: 1 }}>
              <ColoredJsonText text={text} style={{ maxHeight: 'none' }} />
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
