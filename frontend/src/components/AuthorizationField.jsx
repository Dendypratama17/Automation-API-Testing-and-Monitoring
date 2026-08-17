import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronIcon, CheckIcon } from './icons.jsx';

/**
 * The Authorization section's combined "type it or pick it" field — same
 * idea as HeaderValueSelect for header values, but the "pick" side here is a
 * saved credential (Basic/Web Login) rather than a plain string, so typing
 * and picking can't share one storage slot: typing edits the step's raw
 * Authorization header directly, while picking a credential sets
 * `credentialId` instead (which always wins at run time, per flowExecutor).
 * Typing over a picked credential's label clears the credential and starts
 * editing the raw value from there, so there's always exactly one active
 * source instead of a stale credential silently overriding a value someone
 * just typed.
 *
 * `onChange` takes a single patch object (`{ credentialId? , rawValue? }`)
 * rather than two separate setters — clearing one field and setting the
 * other is a single step-state update, not two calls into the parent's
 * setState in the same tick (which would just have the second call
 * overwrite the first, since both would read the same not-yet-updated
 * `editingFlow` from closure).
 */
export default function AuthorizationField({ credentials, credentialId, rawValue, onChange }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
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
    setPos({ top: rect.bottom + 4, left: rect.left, width: Math.max(rect.width, 320) });
    setOpen(true);
  };

  const selectedCred = credentials.find((c) => String(c.id) === String(credentialId));
  const displayValue = selectedCred
    ? `${selectedCred.name}${selectedCred.environment_name ? ` (${selectedCred.environment_name})` : ''}`
    : rawValue;

  const handleTyped = (v) => {
    onChange(credentialId ? { credentialId: '', rawValue: v } : { rawValue: v });
  };
  const pickCredential = (cred) => {
    onChange({ credentialId: String(cred.id), rawValue: '' });
    setOpen(false);
  };
  const pickNone = () => {
    onChange({ credentialId: '' });
    setOpen(false);
  };

  return (
    <div ref={wrapRef} className="cred-select-combo" style={{ position: 'relative', width: '100%', minWidth: 0 }}>
      <input
        className="cred-select-combo-input"
        placeholder="None — type a raw Authorization value, or pick a saved credential"
        value={displayValue}
        onChange={(e) => handleTyped(e.target.value)}
      />
      {selectedCred && (
        <span className="badge neutral" style={{ flexShrink: 0, marginRight: 6 }}>
          {selectedCred.type === 'web_login' ? 'Web Login (Bearer)' : 'Basic Auth'}
        </span>
      )}
      <button
        type="button"
        className="cred-select-combo-toggle"
        onClick={() => (open ? setOpen(false) : openList())}
        title="Pick a saved credential"
      >
        <ChevronIcon style={{ transform: 'rotate(90deg)' }} />
      </button>
      {open && pos && createPortal(
        <div
          ref={listRef}
          className="cred-select-list"
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width }}
        >
          <button type="button" className="cred-select-item" onClick={pickNone}>
            <span className="cred-select-check">{!credentialId && <CheckIcon />}</span>
            None
          </button>
          {credentials.map((cred) => (
            <button type="button" key={cred.id} className="cred-select-item" onClick={() => pickCredential(cred)}>
              <span className="cred-select-check">{String(credentialId) === String(cred.id) && <CheckIcon />}</span>
              <span className="cred-select-item-label">{cred.name}{cred.environment_name ? ` (${cred.environment_name})` : ''}</span>
              <span className="badge neutral auth-type-badge">
                {cred.type === 'web_login' ? 'Web Login (Bearer)' : 'Basic Auth'}
              </span>
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}
