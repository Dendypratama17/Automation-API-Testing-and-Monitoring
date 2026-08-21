import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronIcon, SearchIcon } from './icons.jsx';
import { flattenFolders, folderOptionLabel } from '../utils/folderTree.js';

// Popup picker dengan folder sebagai tab mendatar di atas, lalu di
// bawahnya daftar item milik folder yang aktif tetap tersusun vertikal
// (satu per baris) — dipakai untuk "Select endpoint" di step Flow dan
// "Select Flow" di halaman Schedules, dua tempat yang sebelumnya memakai
// <select><optgroup> biasa. Kotak pencarian di atas tab bisa mencari
// nama folder maupun nama item — begitu ada teks pencarian, tab folder
// disembunyikan dan diganti daftar gabungan dari semua folder yang cocok
// (nama folder ATAU nama item), tiap barisnya diberi label folder kecil
// biar tetap jelas asalnya.
export default function FolderPillPicker({
  value, options, folders, folderIdOf, getLabel, onPick, placeholder = 'Select...',
  extraTopAction, disabled, title, borderColor, style,
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const [activeFolderKey, setActiveFolderKey] = useState(null);
  const [search, setSearch] = useState('');
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
    if (!wrapRef.current || disabled) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const width = Math.max(rect.width, 360);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 12));
    setPos({ top: rect.bottom + 4, left, width });
    setActiveFolderKey(null); // reset — jatuh balik ke tab pertama tiap dibuka
    setSearch('');
    setOpen(true);
  };

  // Hanya folder yang benar-benar punya item yang jadi tab — folder kosong
  // tidak perlu tab-nya sendiri, sama seperti optgroup lama yang hanya
  // muncul kalau ada isinya.
  const groups = new Map();
  for (const opt of options) {
    const key = folderIdOf(opt) ?? 'none';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(opt);
  }
  const folderLabelByKey = { none: 'No Folder' };
  for (const f of flattenFolders(folders || [])) folderLabelByKey[f.id] = folderOptionLabel(f);
  const orderedKeys = [
    'none',
    ...flattenFolders(folders || []).map((f) => f.id),
  ].filter((key) => groups.has(key));
  const currentKey = activeFolderKey != null && groups.has(activeFolderKey) ? activeFolderKey : orderedKeys[0];

  const selected = options.find((o) => String(o.id) === String(value));

  const query = search.trim().toLowerCase();
  const searching = query.length > 0;
  const searchResults = searching
    ? options.filter((opt) => {
      const key = folderIdOf(opt) ?? 'none';
      return getLabel(opt).toLowerCase().includes(query) || (folderLabelByKey[key] || '').toLowerCase().includes(query);
    })
    : [];

  const renderItemRow = (opt, folderKey) => (
    <button
      type="button"
      key={opt.id}
      className="cred-select-item"
      style={String(opt.id) === String(value) ? { background: 'var(--accent-soft)' } : undefined}
      onClick={() => { setOpen(false); onPick(opt); }}
    >
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{getLabel(opt)}</span>
      {folderKey && <span className="hint" style={{ flexShrink: 0, fontSize: 11.5 }}>{folderLabelByKey[folderKey] || 'Folder'}</span>}
    </button>
  );

  return (
    <div ref={wrapRef} style={{ position: 'relative', flex: 1, minWidth: 0, ...style }}>
      <button
        type="button"
        className="cred-select-combo-input"
        style={{
          textAlign: 'left', width: '100%', cursor: disabled ? 'default' : 'pointer',
          color: selected ? 'var(--text)' : 'var(--text-muted)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          background: 'var(--surface-2)', border: `1px solid ${borderColor || 'var(--border)'}`,
          borderRadius: 'var(--radius-sm)', padding: '9px 11px', fontSize: 13.5,
        }}
        onClick={() => (open ? setOpen(false) : openList())}
        disabled={disabled}
        title={title}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selected ? getLabel(selected) : placeholder}
        </span>
        <ChevronIcon style={{ transform: 'rotate(90deg)', flexShrink: 0, color: 'var(--text-dim)' }} />
      </button>
      {open && pos && createPortal(
        <div ref={listRef} className="cred-select-list" style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width }}>
          {extraTopAction && (
            <button
              type="button"
              className="cred-select-item"
              style={{ borderBottom: '1px solid var(--border)', marginBottom: 4, paddingBottom: 10 }}
              onClick={() => { setOpen(false); extraTopAction.onClick(); }}
            >
              {extraTopAction.label}
            </button>
          )}
          {orderedKeys.length === 0 ? (
            <div className="hint" style={{ padding: '8px 10px', fontSize: 12.5 }}>Nothing configured yet.</div>
          ) : (
            <>
              <div className="cred-select-search">
                <SearchIcon style={{ flexShrink: 0, color: 'var(--text-dim)' }} />
                <input
                  autoFocus
                  placeholder="Search folder or name..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              {searching ? (
                searchResults.length === 0 ? (
                  <div className="hint" style={{ padding: '8px 10px', fontSize: 12.5 }}>No match.</div>
                ) : (
                  searchResults.map((opt) => renderItemRow(opt, folderIdOf(opt) ?? 'none'))
                )
              ) : (
                <>
                  <div className="folder-pill-tabs">
                    {orderedKeys.map((key) => (
                      <button
                        type="button"
                        key={key}
                        className={`folder-tab${key === currentKey ? ' active' : ''}`}
                        onClick={() => setActiveFolderKey(key)}
                      >
                        {folderLabelByKey[key] || 'Folder'}
                      </button>
                    ))}
                  </div>
                  {currentKey && groups.get(currentKey).map((opt) => renderItemRow(opt, null))}
                </>
              )}
            </>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}
