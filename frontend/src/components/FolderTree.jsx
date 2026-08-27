import React, { useState } from 'react';
import OptionsMenu from './OptionsMenu.jsx';
import { EditIcon, TrashIcon, FolderPlusIcon, ChevronIcon } from './icons.jsx';

/**
 * Recursive folder tree (supports folders nested inside folders via
 * parent_id) with an "All" / "No Folder" pseudo-entry at the top, and an
 * inline "+ New Folder" input that can be opened at the root or under any
 * existing folder to create a subfolder there.
 */
export default function FolderTree({
  folders, selectedFolderId, onSelect, onCreateFolder, onDeleteFolder, onRenameFolder,
  allLabel = 'All', noneLabel = 'No Folder',
  // Optional: (folder) => JSX, rendered under a folder's own row while it's
  // the selected one — e.g. Flows uses this to preview each flow's steps
  // inline instead of requiring a click into the editor.
  renderExpanded,
  // Optional: a localStorage key to remember which folders are collapsed
  // across reloads/navigation. Omit to keep the toggle session-only (resets
  // on remount) — every current caller passes one.
  storageKey,
}) {
  const [addingUnder, setAddingUnder] = useState(null); // null | 'root' | folderId
  const [newName, setNewName] = useState('');
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  // Folder ids whose subfolders are hidden — starts empty (fully expanded,
  // same as before this toggle existed) unless a previous collapse was
  // persisted under storageKey.
  const [collapsedIds, setCollapsedIds] = useState(() => {
    if (!storageKey) return new Set();
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch {
      return new Set();
    }
  });

  const childrenOf = (parentId) => folders.filter((f) => (f.parent_id ?? null) === parentId);

  const toggleCollapsed = (folderId) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      if (storageKey) {
        try { localStorage.setItem(storageKey, JSON.stringify([...next])); } catch { /* ignore quota/private-mode errors */ }
      }
      return next;
    });
  };

  const startAdding = (parentId) => {
    setAddingUnder(parentId);
    setNewName('');
  };

  const submitNew = (parentId) => {
    if (!newName.trim()) return;
    onCreateFolder(newName.trim(), parentId);
    setNewName('');
    setAddingUnder(null);
  };

  const startRename = (folder) => {
    setRenamingId(folder.id);
    setRenameValue(folder.name);
  };

  const submitRename = (folder) => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== folder.name) onRenameFolder(folder.id, trimmed);
    setRenamingId(null);
  };

  const renderAddInput = (parentId) => (
    <div className="toolbar" style={{ marginBottom: 6 }}>
      <input
        autoFocus
        placeholder="Folder name"
        value={newName}
        onChange={(e) => setNewName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submitNew(parentId)}
        style={{ flex: 1, minWidth: 0 }}
      />
      <button onClick={() => submitNew(parentId)} disabled={!newName.trim()}>Add</button>
      <button className="btn-quiet" onClick={() => setAddingUnder(null)}>✕</button>
    </div>
  );

  const renderNode = (folder, depth) => {
    const kids = childrenOf(folder.id);
    const hasKids = kids.length > 0;
    const isSelected = selectedFolderId === folder.id;
    const isCollapsed = collapsedIds.has(folder.id);
    return (
      <li key={folder.id}>
        <div className={`tree-item${isSelected ? ' active' : ''}`} style={{ paddingLeft: 8 + depth * 16 }}>
          {renamingId === folder.id ? (
            <>
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitRename(folder);
                  if (e.key === 'Escape') setRenamingId(null);
                }}
                style={{ flex: 1, minWidth: 0 }}
              />
              <button className="btn-quiet" title="Save" onClick={() => submitRename(folder)} disabled={!renameValue.trim()}>✓</button>
              <button className="btn-quiet" title="Cancel" onClick={() => setRenamingId(null)}>✕</button>
            </>
          ) : (
            <>
              <span onClick={() => { if (!isSelected) onSelect(folder.id); }} style={{ flex: 1, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                {hasKids ? (
                  <button
                    type="button"
                    className="tree-toggle"
                    title={isCollapsed ? 'Expand' : 'Collapse'}
                    onClick={(e) => { e.stopPropagation(); toggleCollapsed(folder.id); }}
                  >
                    <ChevronIcon style={{ width: 15, height: 15, transform: isCollapsed ? 'none' : 'rotate(90deg)' }} />
                  </button>
                ) : (
                  <span className="tree-toggle-spacer" />
                )}
                📁 {folder.name}
              </span>
              <OptionsMenu
                items={[
                  { label: 'Rename', icon: <EditIcon />, onClick: () => startRename(folder) },
                  { label: 'New Subfolder', icon: <FolderPlusIcon />, onClick: () => startAdding(folder.id) },
                  { label: 'Delete', icon: <TrashIcon />, onClick: () => onDeleteFolder(folder.id), danger: true, divider: true },
                ]}
              />
            </>
          )}
        </div>
        {isSelected && renderExpanded && (
          <div style={{ paddingLeft: 8 + (depth + 1) * 16, marginTop: 4, marginBottom: 6 }}>
            {renderExpanded(folder)}
          </div>
        )}
        {addingUnder === folder.id && <div style={{ paddingLeft: 8 + (depth + 1) * 16, marginTop: 4 }}>{renderAddInput(folder.id)}</div>}
        {hasKids && !isCollapsed && (
          <ul className="tree-list" style={{ margin: 0 }}>
            {kids.map((child) => renderNode(child, depth + 1))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <div>
      <ul className="tree-list">
        <li className={`tree-item${selectedFolderId === 'all' ? ' active' : ''}`} onClick={() => onSelect('all')}>
          {allLabel}
        </li>
        <li className={`tree-item${selectedFolderId === 'null' ? ' active' : ''}`} onClick={() => onSelect('null')}>
          {noneLabel}
        </li>
        {childrenOf(null).map((f) => renderNode(f, 0))}
      </ul>

      <div style={{ marginTop: 12 }}>
        {addingUnder === 'root' ? (
          renderAddInput(null)
        ) : (
          <button onClick={() => startAdding('root')} style={{ width: '100%' }}>+ New Folder</button>
        )}
      </div>
    </div>
  );
}
