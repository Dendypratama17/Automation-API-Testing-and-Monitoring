import React from 'react';
import { useNavigate } from 'react-router-dom';
import { CopyIcon, JsonDiffIcon } from './icons.jsx';
import { useToast } from './ToastProvider.jsx';
import OptionsMenu from './OptionsMenu.jsx';
import { writeJsonDiffDraft } from '../utils/jsonDiffDraft.js';

export default function JsonBlock({ value }) {
  const showToast = useToast();
  const navigate = useNavigate();
  const text = JSON.stringify(value ?? {}, null, 2);

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
