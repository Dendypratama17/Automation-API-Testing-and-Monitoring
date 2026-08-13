import React, { useEffect, useRef, useState } from 'react';

/**
 * A single file-attach control. Plain mode: one button that opens the native
 * file picker. When `libraryOptions` is given (saved Test Files), it becomes
 * one button with a small dropdown offering "Upload from computer..." plus
 * each saved file — one control instead of two side-by-side ones.
 */
export default function FilePicker({ accept, onFileSelect, label = 'Choose File', fileName: initialFileName, libraryOptions, onLibrarySelect, hideFileName = false, onUseUrl, disabled = false }) {
  const inputRef = useRef(null);
  const menuRef = useRef(null);
  // Seeded from `initialFileName` so a previously-saved file (e.g. reopening
  // a flow step that already has one attached) shows up without requiring
  // the user to re-pick it in this session.
  const [fileName, setFileName] = useState(initialFileName || '');
  const [menuOpen, setMenuOpen] = useState(false);

  // Also re-sync whenever the prop changes after mount — e.g. picking a file
  // from the Test Files library updates the parent's fileMeta.name, and
  // without this the label would keep showing "No file chosen" since the
  // native <input> itself was never touched for that pick.
  useEffect(() => {
    setFileName(initialFileName || '');
  }, [initialFileName]);

  useEffect(() => {
    if (!menuOpen) return;
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

  const handleChange = (e) => {
    const file = e.target.files[0];
    setFileName(file ? file.name : '');
    onFileSelect(e);
  };

  const hiddenInput = <input ref={inputRef} type="file" accept={accept} onChange={handleChange} style={{ display: 'none' }} />;

  const hasMenu = (libraryOptions && libraryOptions.length > 0) || onUseUrl;

  if (!hasMenu) {
    return (
      <div className="file-picker">
        <button type="button" onClick={() => inputRef.current?.click()} disabled={disabled}>{label}</button>
        {!hideFileName && <span className={fileName ? 'mono' : 'hint'}>{fileName || 'No file chosen'}</span>}
        {hiddenInput}
      </div>
    );
  }

  return (
    <div ref={menuRef} className="file-picker-menu" style={{ position: 'relative' }}>
      <button type="button" onClick={() => setMenuOpen((o) => !o)} className="mono" disabled={disabled}>
        {fileName || label}
      </button>
      {hiddenInput}
      {menuOpen && (
        <div className="options-menu">
          <button
            className="options-menu-item"
            onClick={() => { setMenuOpen(false); inputRef.current?.click(); }}
          >
            Upload from computer...
          </button>
          {(libraryOptions || []).map((opt) => (
            <button
              key={opt.id}
              className="options-menu-item"
              onClick={() => { setMenuOpen(false); onLibrarySelect(opt.id); }}
            >
              {opt.file_name}
            </button>
          ))}
          {onUseUrl && (
            <button
              className="options-menu-item"
              onClick={() => { setMenuOpen(false); onUseUrl(); }}
            >
              Use a URL instead...
            </button>
          )}
        </div>
      )}
    </div>
  );
}
