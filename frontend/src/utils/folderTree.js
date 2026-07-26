// Flattens a parent_id-linked folder list into an ordered array (parents
// immediately followed by their children, depth-first) with a `depth` field
// - used to show the main-folder/subfolder relationship in a flat <select>,
// where nested <ul>/<li> indentation (like the sidebar FolderTree) isn't available.
export function flattenFolders(folders) {
  const childrenOf = (parentId) => folders.filter((f) => (f.parent_id ?? null) === parentId);
  const result = [];
  const walk = (parentId, depth) => {
    for (const f of childrenOf(parentId)) {
      result.push({ ...f, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return result;
}

// Indented, tree-like label for a flattened folder entry - e.g. a depth-1
// subfolder renders as "- test" so it visually reads as nested under
// whichever main folder immediately precedes it in the list. Uses a
// non-breaking space for indentation since plain leading spaces can get
// trimmed by native <option> rendering in some browsers.
const INDENT_UNIT = String.fromCharCode(160).repeat(2);

export function folderOptionLabel(folder) {
  return folder.depth > 0
    ? `${INDENT_UNIT.repeat(folder.depth)}└ ${folder.name}`
    : folder.name;
}
