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
  // Baris tab folder biasanya wrap ke bawah kalau kepanjangan — set true
  // untuk memaksanya jadi satu baris saja dengan scroll horizontal (dipakai
  // Schedules' Select Flow, tidak untuk Select endpoint di step Flow).
  singleLineTabs,
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
    // Selalu pilih sisi (atas/bawah) yang ruangnya lebih besar — bukan cuma
    // membuka ke atas kalau ruang bawah "kritis" sempit. Step ke-2/3/dst di
    // flow yang panjang biasanya trigger-nya sudah di posisi bawah viewport
    // begitu halaman di-scroll ke sana, jadi ruang bawah pas-pasan tapi
    // masih di atas ambang lama — dropdown-nya jadi kependekan padahal
    // ruang di atas jauh lebih luas.
    const spaceBelow = window.innerHeight - rect.bottom - 12;
    const spaceAbove = rect.top - 12;
    const openUpward = spaceAbove > spaceBelow;
    // 480 (bukan 320) — daftar folder/item sekarang lebih panjang (ada tab
    // "All Folder" yang menampilkan semua section sekaligus), jadi kasih
    // ruang lebih dulu sebelum harus scroll, tetap dibatasi ruang layar
    // yang benar-benar tersedia.
    const maxHeight = Math.max(160, Math.min(480, openUpward ? spaceAbove : spaceBelow));
    setPos(openUpward
      ? { bottom: window.innerHeight - rect.top + 4, left, width, maxHeight }
      : { top: rect.bottom + 4, left, width, maxHeight });
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
  const realKeys = [
    'none',
    ...flattenFolders(folders || []).map((f) => f.id),
  ].filter((key) => groups.has(key));
  // "All Folder" adalah tab default — menampilkan gabungan semua folder di
  // list yang scroll, tetap dipisah per section (label folder kecil) biar
  // asal tiap item jelas, bukan cuma daftar rata tanpa keterangan.
  const orderedKeys = realKeys.length > 0 ? ['__all__', ...realKeys] : [];
  const currentKey = activeFolderKey != null && (activeFolderKey === '__all__' || groups.has(activeFolderKey))
    ? activeFolderKey
    : orderedKeys[0];

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
        <div
          ref={listRef}
          className="cred-select-list"
          style={{
            position: 'fixed', top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width,
            maxHeight: pos.maxHeight, overflow: 'hidden',
          }}
        >
          {/* Bagian ini TIDAK ikut scroll — search box dan tab folder tetap
              di tempat, cuma daftar item di bawahnya (div berikutnya) yang
              scroll sendiri. */}
          <div style={{ flexShrink: 0 }}>
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
            {orderedKeys.length > 0 && (
              <div className="cred-select-search">
                <SearchIcon style={{ flexShrink: 0, color: 'var(--text-dim)' }} />
                <input
                  autoFocus
                  placeholder=" Search name..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            )}
            {orderedKeys.length > 0 && !searching && (
              <div className={`folder-pill-tabs${singleLineTabs ? ' single-line' : ''}`}>
                {orderedKeys.map((key) => (
                  <button
                    type="button"
                    key={key}
                    className={`folder-tab${key === currentKey ? ' active' : ''}`}
                    onClick={() => setActiveFolderKey(key)}
                  >
                    {key === '__all__' ? 'All Folder' : (folderLabelByKey[key] || 'Folder')}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {orderedKeys.length === 0 ? (
              <div className="hint" style={{ padding: '8px 10px', fontSize: 12.5 }}>Nothing configured yet.</div>
            ) : searching ? (
              searchResults.length === 0 ? (
                <div className="hint" style={{ padding: '8px 10px', fontSize: 12.5 }}>No match.</div>
              ) : (
                searchResults.map((opt) => renderItemRow(opt, folderIdOf(opt) ?? 'none'))
              )
            ) : currentKey === '__all__' ? (
              realKeys.map((key, gi) => (
                <div key={key}>
                  <div
                    className="cred-select-group-label"
                    style={gi > 0 ? { marginTop: 6, borderTop: '1px solid var(--border)', paddingTop: 10 } : undefined}
                  >
                    {folderLabelByKey[key] || 'Folder'}
                  </div>
                  {groups.get(key).map((opt) => renderItemRow(opt, null))}
                </div>
              ))
            ) : (
              currentKey && groups.get(currentKey).map((opt) => renderItemRow(opt, null))
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
