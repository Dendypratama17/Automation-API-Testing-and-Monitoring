import React from 'react';
import { CopyIcon } from './icons.jsx';
import { useToast } from './ToastProvider.jsx';

export default function JsonBlock({ value }) {
  const showToast = useToast();
  const text = JSON.stringify(value ?? {}, null, 2);

  const handleCopy = () => {
    navigator.clipboard.writeText(text)
      .then(() => showToast('Copied to clipboard.'))
      .catch(() => showToast('Failed to copy.', 'error'));
  };

  return (
    <div style={{ position: 'relative' }}>
      <button
        className="btn-icon json-block-copy"
        onClick={handleCopy}
        title="Copy to clipboard"
        aria-label="Copy to clipboard"
      >
        <CopyIcon />
      </button>
      <pre className="json-block">{text}</pre>
    </div>
  );
}
