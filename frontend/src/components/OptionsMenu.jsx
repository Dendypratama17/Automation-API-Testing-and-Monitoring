import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DotsIcon, ChevronIcon } from './icons.jsx';

/**
 * A "⋮" button that opens a small dropdown of secondary row actions (Edit,
 * Duplicate, Delete, ...) — keeps a table row's Action column from turning
 * into a wall of icon buttons. Closes on outside click or after picking an
 * item.
 *
 * The dropdown itself is rendered through a portal into document.body,
 * position: fixed at the trigger button's on-screen coordinates, rather than
 * living inside this component's own DOM position. A plain position:
 * absolute child gets silently clipped/hidden the moment any ancestor sets
 * overflow-x (e.g. a horizontally-scrollable table wrapper) — per the CSS
 * overflow spec, setting one axis to non-visible forces the other to
 * compute as 'auto' too, turning the ancestor into a clipping box even
 * though nothing asked it to clip vertically.
 *
 * `items`: [{ label, icon, onClick, danger?, divider? }] — a plain action.
 * An item can instead carry `submenu: [{ label, icon, onClick }]` (e.g.
 * "Move to Folder" listing every folder) — clicking it swaps the panel to
 * that submenu instead of closing, with a "Back" row to return.
 *
 * By default the trigger is the icon-only "⋮" button (a row's secondary
 * actions). Passing `label` instead renders a normal text button with a
 * chevron — e.g. an "Export ▾" button offering "Download PDF" / "Share to
 * Telegram" as one combined action instead of two separate buttons.
 */
export default function OptionsMenu({ items, icon, title = 'Options', label, className }) {
  const [open, setOpen] = useState(false);
  const [submenuIndex, setSubmenuIndex] = useState(null);
  const [menuPos, setMenuPos] = useState(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e) => {
      if (
        triggerRef.current && !triggerRef.current.contains(e.target)
        && menuRef.current && !menuRef.current.contains(e.target)
      ) {
        setOpen(false);
        setSubmenuIndex(null);
      }
    };
    // Scroll position (of the table wrapper, the page, anywhere) can move
    // the trigger button out from under a `position: fixed` menu computed
    // from a one-time snapshot of its coordinates — simplest correct fix is
    // to just close the menu rather than track/re-measure on every scroll.
    // BUT scrolling the menu's own list (it's max-height + overflow-y:auto
    // for a long items list or a "Move to Folder" submenu with many
    // folders) fires scroll events too — without this exemption, wheeling
    // over that list closed the whole menu instead of scrolling it.
    const handleScroll = (e) => {
      if (menuRef.current && menuRef.current.contains(e.target)) return;
      setOpen(false);
      setSubmenuIndex(null);
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

  const close = () => { setOpen(false); setSubmenuIndex(null); };
  const activeSubmenu = submenuIndex != null ? items[submenuIndex] : null;

  const toggleOpen = () => {
    setOpen((o) => {
      const next = !o;
      if (next && triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect();
        const right = window.innerWidth - rect.right;
        // A trigger on the bottom-most row (e.g. the last item in a long
        // list) can have less room below it than the menu's own max-height
        // (320px, see .options-menu) — always opening downward then just
        // ran the menu off the bottom of the viewport, cut off with no way
        // to reach its lower items. Open upward instead whenever there's
        // more room above than below.
        const spaceBelow = window.innerHeight - rect.bottom - 12;
        const spaceAbove = rect.top - 12;
        const openUpward = spaceAbove > spaceBelow;
        setMenuPos(openUpward
          ? { bottom: window.innerHeight - rect.top + 4, right }
          : { top: rect.bottom + 4, right });
      }
      if (!next) setSubmenuIndex(null);
      return next;
    });
  };

  return (
    <div ref={triggerRef} style={{ position: 'relative', display: 'inline-block' }} onClick={(e) => e.stopPropagation()}>
      <button
        className={className ?? (label ? '' : 'btn-icon')}
        onClick={toggleOpen}
        title={title}
        aria-label={title}
      >
        {label ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {label}
            <ChevronIcon style={{ transform: 'rotate(90deg)', width: 12, height: 12 }} />
          </span>
        ) : (icon || <DotsIcon />)}
      </button>
      {open && menuPos && createPortal(
        <div ref={menuRef} className="options-menu" style={{ position: 'fixed', top: menuPos.top, bottom: menuPos.bottom, right: menuPos.right }}>
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
        </div>,
        document.body
      )}
    </div>
  );
}
