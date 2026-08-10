import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronIcon, CheckIcon } from './icons.jsx';

/**
 * Styled stand-in for a header value <select> once Config > Default Headers
 * has 2+ options for that key (see KeyValueEditor) — a plain <select> can
 * only ever show one line of plain text per <option>, which is unreadable
 * once a value has a Name/Env label AND a long raw string (e.g. an X-Token
 * hash) to show at the same time. Same portal-based approach as
 * CredentialSelect/OptionsMenu, for the same overflow-clipping reason.
 */
export default function HeaderValueSelect({ options, value, onChange }) {
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
        // The trigger itself stays only as wide as its column in the
        // key/value grid, but the opened panel widens past that — a
        // name + env + raw-value badge needs real room to breathe (the
        // same room Authorization's picker gets, since that one isn't
        // squeezed into a grid column) or the badge ends up jammed right
        // up against the name with no gap. Clamped so it still fits on
        // screen instead of running off the right edge.
        const width = Math.max(rect.width, 460);
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 12));
        setPos({ top: rect.bottom + 4, left, width });
      }
      return next;
    });
  };

  const selected = options.find((o) => o.value === value) || { value, label: null, environment_name: null };
  const pick = (opt) => { onChange(opt.value); setOpen(false); };

  // Same single-line "name (env)" + pill layout as CredentialSelect — an
  // unlabeled option (no Name/Env set in Config > Default Headers) has
  // nothing to put in that first slot, so it just falls back to the raw
  // value alone, same as before this got a Name/Env option.
  const renderOptionContent = (opt) => (
    opt.label ? (
      <>
        <span className="cred-select-item-label">{opt.label}{opt.environment_name ? ` (${opt.environment_name})` : ''}</span>
        <span className="badge neutral mono truncate" title={opt.value}>{opt.value || '(empty)'}</span>
      </>
    ) : (
      <span className="header-value-option-plain">{opt.value || '(empty)'}</span>
    )
  );

  return (
    <div ref={triggerRef} style={{ position: 'relative', width: '100%', minWidth: 0 }}>
      <button type="button" className="cred-select-trigger" onClick={toggleOpen}>
        <span className="cred-select-trigger-label">{renderOptionContent(selected)}</span>
        <ChevronIcon style={{ transform: 'rotate(90deg)', flexShrink: 0, color: 'var(--text-dim)' }} />
      </button>
      {open && pos && createPortal(
        <div
          ref={listRef}
          className="cred-select-list"
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width }}
        >
          {options.map((opt) => (
            <button type="button" key={opt.value} className="cred-select-item" onClick={() => pick(opt)}>
              <span className="cred-select-check">{value === opt.value && <CheckIcon />}</span>
              {renderOptionContent(opt)}
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}
