import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronIcon, CheckIcon } from './icons.jsx';
import { envBadgeClass } from '../utils/envBadge.js';

/**
 * A header value field that's always a real, freely-editable text input —
 * typing a brand-new value (an account that isn't saved as a Default Header
 * yet, a one-off token) always works. When Config > Default Headers has
 * known values for this key, a chevron button additionally opens a
 * portal-based dropdown of them (same approach as AuthorizationField/
 * OptionsMenu, for the same overflow-clipping reason) — picking one just
 * fills the input, which stays editable afterward.
 */
export default function HeaderValueSelect({ options, value, onChange, placeholder }) {
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

  const openList = () => {
    if (!wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    // The input itself stays only as wide as its column in the key/value
    // grid, but the opened suggestion panel widens past that — a name + env
    // + raw-value badge needs real room to breathe, or the badge ends up
    // jammed right up against the name with no gap. Clamped so it still
    // fits on screen instead of running off the right edge.
    const width = Math.max(rect.width, 520);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 12));
    setPos({ top: rect.bottom + 4, left, width });
    setOpen(true);
  };

  const pick = (opt) => { onChange(opt.value); setOpen(false); };

  // Same single-line "name [env]" + pill layout as AuthorizationField's
  // credential list, but the name (short, identifying) and the value (can
  // be a long hash) can't share that layout's flex rules — those give the
  // pill first claim on space and let the name get squeezed to a sliver.
  // Here the name keeps its full width instead, and the value pill is a
  // fixed width (not flex) so every row's badge lines up and none of them
  // balloons out just because its hash happens to be long. The env gets its
  // own color-coded badge (see utils/envBadge.js) so which environment a
  // value belongs to is obvious without reading the text.
  const renderOptionContent = (opt) => (
    opt.label ? (
      <>
        <span className="header-value-item-name">{opt.label}</span>
        {opt.environment_name && (
          <span className={`badge ${envBadgeClass(opt.environment_name)} header-value-item-env`}>{opt.environment_name}</span>
        )}
        <span className="badge neutral mono header-value-item-value" title={opt.value}>{opt.value || '(empty)'}</span>
      </>
    ) : (
      <span className="header-value-option-plain">{opt.value || '(empty)'}</span>
    )
  );

  return (
    <div ref={wrapRef} className="cred-select-combo" style={{ position: 'relative', width: '100%', minWidth: 0 }}>
      <input
        className="cred-select-combo-input"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {options.length > 0 && (
        <button
          type="button"
          className="cred-select-combo-toggle"
          onClick={() => (open ? setOpen(false) : openList())}
          title="Pick a known value"
        >
          <ChevronIcon style={{ transform: 'rotate(90deg)' }} />
        </button>
      )}
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
