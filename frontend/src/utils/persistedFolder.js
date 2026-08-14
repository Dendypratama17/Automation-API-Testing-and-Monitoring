// Remembers the last-selected folder (Flow List / Config's Endpoints list) in
// localStorage, so switching pages or reloading doesn't reset back to "All".
// Value is 'all' | 'null' | a numeric folder id.
export function loadSelectedFolder(key) {
  const raw = localStorage.getItem(key);
  if (raw === null) return 'all';
  if (raw === 'all' || raw === 'null') return raw;
  const num = Number(raw);
  return Number.isFinite(num) ? num : 'all';
}

export function saveSelectedFolder(key, value) {
  localStorage.setItem(key, String(value));
}

// True once a folder choice has ever been persisted for this key — lets a
// one-time "auto-select the oldest folder" default run only for a
// first-ever visit, instead of overriding the restored choice on every mount.
export function hasStoredFolder(key) {
  return localStorage.getItem(key) !== null;
}
