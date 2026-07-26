import React, { useEffect, useRef, useState } from 'react';
import { DotsIcon, ChevronIcon } from './icons.jsx';

/**
 * A "⋮" button that opens a small dropdown of secondary row actions (Edit,
 * Duplicate, Delete, ...) — keeps a table row's Action column from turning
 * into a wall of icon buttons. Closes on outside click or after picking an
 * item.
 *
 * `items`: [{ label, icon, onClick, danger?, divider? }] — a plain action.
 * An item can instead carry `submenu: [{ label, icon, onClick }]` (e.g.
 * "Move to Folder" listing every folder) — clicking it swaps the panel to
 * that submenu instead of closing, with a "Back" row to return.
 */
export default function OptionsMenu({ items }) {
  const [open, setOpen] = useState(false);
  const [submenuIndex, setSubmenuIndex] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e) => {
      if (ref.current && !ref.current.contains(e.target)) { setOpen(false); setSubmenuIndex(null); }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const close = () => { setOpen(false); setSubmenuIndex(null); };
  const activeSubmenu = submenuIndex != null ? items[submenuIndex] : null;

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }} onClick={(e) => e.stopPropagation()}>
      <button
        className="btn-icon"
        onClick={() => setOpen((o) => { const next = !o; if (!next) setSubmenuIndex(null); return next; })}
        title="Options"
        aria-label="Options"
      >
        <DotsIcon />
      </button>
      {open && (
        <div className="options-menu">
          {activeSubmenu ? (
            <>
              <button className="options-menu-item" onClick={() => setSubmenuIndex(null)}>
                <ChevronIcon style={{ transform: 'rotate(180deg)' }} />
                Back
              </button>
              <div className="options-menu-divider" />
              {activeSubmenu.submenu.map((sub, i) => (
                <button key={i} className="options-menu-item" onClick={() => { close(); sub.onClick(); }}>
                  {sub.icon}
                  {sub.label}
                </button>
              ))}
            </>
          ) : (
            items.map((item, i) => (
              <React.Fragment key={i}>
                {item.divider && <div className="options-menu-divider" />}
                <button
                  className={`options-menu-item${item.danger ? ' danger' : ''}`}
                  disabled={item.disabled}
                  onClick={() => {
                    if (item.disabled) return;
                    if (item.submenu) setSubmenuIndex(i);
                    else { close(); item.onClick(); }
                  }}
                >
                  {item.icon}
                  {item.label}
                  {item.submenu && <ChevronIcon style={{ marginLeft: 'auto', transform: 'rotate(-90deg)' }} />}
                </button>
              </React.Fragment>
            ))
          )}
        </div>
      )}
    </div>
  );
}
