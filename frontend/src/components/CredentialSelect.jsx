import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronIcon, CheckIcon } from './icons.jsx';

/**
 * A styled stand-in for a native <select> of auth credentials — a plain
 * <select> can't show a type badge (Web Login vs Basic Auth) per row or
 * highlight the current value beyond the OS's own checkmark, so this
 * renders its own trigger + portal-based list instead (same portal
 * approach as OptionsMenu, for the same overflow-clipping reason).
 */
export default function CredentialSelect({ credentials, value, onChange, placeholder = 'None' }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const triggerRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e) => {
      if (
        triggerRef.current && !triggerRef.current.contains(e.target)
        && listRef.current && !listRef.current.contains(e.target)
      ) setOpen(false);
    };
    const handleScroll = () => setOpen(false);
    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleScroll);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleScroll);
    };
  }, [open]);

  const toggleOpen = () => {
    setOpen((o) => {
      const next = !o;
      if (next && triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect();
        setPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
      }
      return next;
    });
  };

  const selected = credentials.find((c) => String(c.id) === String(value));
  const pick = (id) => { onChange(id); setOpen(false); };

  return (
    <div ref={triggerRef} style={{ position: 'relative', width: '100%' }}>
      <button
        type="button"
        className="cred-select-trigger"
        onClick={toggleOpen}
      >
        {selected ? (
          <span className="cred-select-trigger-label">
            <span>{selected.name}{selected.environment_name ? ` (${selected.environment_name})` : ''}</span>
            <span className={`badge ${selected.type === 'web_login' ? 'info' : 'drift'}`}>
              {selected.type === 'web_login' ? 'Web Login (Bearer)' : 'Basic Auth'}
            </span>
          </span>
        ) : (
          <span className="cred-select-trigger-placeholder">{placeholder}</span>
        )}
        <ChevronIcon style={{ transform: 'rotate(90deg)', flexShrink: 0, color: 'var(--text-dim)' }} />
      </button>
      {open && pos && createPortal(
        <div
          ref={listRef}
          className="cred-select-list"
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width }}
        >
          <button type="button" className="cred-select-item" onClick={() => pick('')}>
            <span className="cred-select-check">{!value && <CheckIcon />}</span>
            None
          </button>
          {credentials.map((cred) => (
            <button
              type="button"
              key={cred.id}
              className="cred-select-item"
              onClick={() => pick(String(cred.id))}
            >
              <span className="cred-select-check">{String(value) === String(cred.id) && <CheckIcon />}</span>
              <span className="cred-select-item-label">{cred.name}{cred.environment_name ? ` (${cred.environment_name})` : ''}</span>
              <span className={`badge ${cred.type === 'web_login' ? 'info' : 'drift'}`}>
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
