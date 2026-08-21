import React from 'react';
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
function isTupleArray(value) {
  return Array.isArray(value) && value.length > 0
    && value.every((el) => Array.isArray(el) && el.length === 2 && typeof el[0] === 'string');
}

function stringifyForDisplay(value, indent = 0) {
  const pad = '  '.repeat(indent);
  const childPad = '  '.repeat(indent + 1);
  if (isTupleArray(value)) {
    const lines = value.map(([k, v]) => `${childPad}${JSON.stringify(k)}: ${stringifyForDisplay(v, indent + 1)}`);
    return `{\n${lines.join(',\n')}\n${pad}}`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const lines = value.map((v) => `${childPad}${stringifyForDisplay(v, indent + 1)}`);
    return `[\n${lines.join(',\n')}\n${pad}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    const lines = keys.map((k) => `${childPad}${JSON.stringify(k)}: ${stringifyForDisplay(value[k], indent + 1)}`);
    return `{\n${lines.join(',\n')}\n${pad}}`;
  }
  return JSON.stringify(value);
}

export default function JsonBlock({ value }) {
  const showToast = useToast();
  const navigate = useNavigate();
  const text = stringifyForDisplay(value ?? {});

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
      <pre className="json-block">{text}</pre>
    </div>
  );
}
