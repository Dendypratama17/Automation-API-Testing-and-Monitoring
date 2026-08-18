import React, { useRef } from 'react';
import { tokenizeJsonLine } from '../utils/jsonTextHighlight.js';
import { WandIcon, TrashIcon } from './icons.jsx';
import { useToast } from './ToastProvider.jsx';

const TOKEN_COLOR = {
  key: 'var(--text)',
  string: 'var(--drift)',
  number: 'var(--pass)',
  boolean: 'var(--pass)',
  null: 'var(--pass)',
  punct: 'var(--text-dim)',
  plain: 'var(--text)',
};

// A syntax-highlighted, indent-guided, diff-aware JSON textarea — the real
// <textarea> stays fully editable/selectable/pastable (its text is just
// transparent), with a colored <pre> of the exact same text overlaid behind
// it. Both share the same font/line-height/padding so the invisible real
// caret always lines up with the visible colored character underneath it —
// see utils/jsonTextHighlight.js for why the overlay tokenizes the raw text
// directly instead of re-serializing a parsed value.
export default function JsonPasteEditor({ value, onChange, diffLineSet, missingLineSet, placeholder, height = 420, readOnly = false }) {
  const preRef = useRef(null);
  const showToast = useToast();
  const lines = value.split('\n');

  const handleScroll = (e) => {
    if (preRef.current) {
      preRef.current.scrollTop = e.target.scrollTop;
      preRef.current.scrollLeft = e.target.scrollLeft;
    }
  };

  const handleBeautify = () => {
    if (!value.trim()) return;
    try {
      onChange(JSON.stringify(JSON.parse(value), null, 2));
    } catch {
      showToast('Not valid JSON — fix the syntax first.', 'error');
    }
  };

  const handleClear = () => {
    if (!value) return;
    onChange('');
  };

  return (
    <div className={`json-paste-editor${readOnly ? ' is-locked' : ''}`} style={{ height }}>
      {!readOnly && (
        <div className="json-paste-editor-toolbar">
          <button
            type="button"
            className="btn-icon"
            onClick={handleBeautify}
            title="Beautify — reformat with proper indentation"
            aria-label="Beautify JSON"
          >
            <WandIcon />
          </button>
          <button
            type="button"
            className="btn-icon"
            onClick={handleClear}
            title="Clear"
            aria-label="Clear"
          >
            <TrashIcon />
          </button>
        </div>
      )}
      <pre ref={preRef} className="json-paste-editor-highlight mono" aria-hidden="true">
        {lines.map((line, i) => {
          const indentChars = line.match(/^ */)[0].length;
          const isMissing = missingLineSet?.has(i);
          const isDiff = !isMissing && diffLineSet?.has(i);
          return (
            <div
              key={i}
              className="json-paste-editor-line"
              style={{
                // Different background for "this key doesn't exist on the
                // other side at all" (neutral) vs. "same key, different
                // value" (amber) — otherwise both look identical. A plain
                // var(--surface-3) is barely distinguishable from the
                // editor's own var(--surface-2) background (too close in
                // tone), so this uses a translucent slate-gray wash instead.
                backgroundColor: isMissing ? 'rgba(151, 160, 181, 0.28)' : isDiff ? 'var(--drift-bg)' : undefined,
                backgroundImage: indentChars > 0
                  ? 'repeating-linear-gradient(to right, var(--border) 0, var(--border) 1px, transparent 1px, transparent 2ch)'
                  : undefined,
                backgroundSize: indentChars > 0 ? `${indentChars}ch 100%` : undefined,
                backgroundRepeat: 'no-repeat',
              }}
            >
              {line.length === 0
                ? ' '
                : tokenizeJsonLine(line).map((tok, ti) => (
                  <span key={ti} style={{ color: TOKEN_COLOR[tok.type] }}>{tok.text}</span>
                ))}
            </div>
          );
        })}
      </pre>
      <textarea
        className="json-paste-editor-input mono"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={handleScroll}
        placeholder={placeholder}
        spellCheck={false}
        readOnly={readOnly}
      />
    </div>
  );
}
