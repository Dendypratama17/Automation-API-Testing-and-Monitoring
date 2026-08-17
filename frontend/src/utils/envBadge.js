// Maps an environment name to one of the existing status-badge colors, so a
// picker listing values across environments (e.g. HeaderValueSelect) reads
// at a glance instead of everything looking the same. Falls back to
// 'neutral' for anything outside the known DEV/STG/RC/PROD set.
const ENV_BADGE_CLASS = {
  DEV: 'info',
  STG: 'drift',
  RC: 'error',
  PROD: 'fail',
};

export function envBadgeClass(environmentName) {
  if (!environmentName) return 'neutral';
  return ENV_BADGE_CLASS[environmentName.toUpperCase()] || 'neutral';
}

// Known environments sort first (in this fixed, meaningful order); anything
// else (an environment name that isn't one of the four known ones) is
// appended alphabetically after, rather than in whatever order it happened
// to appear in the source list.
const ENV_GROUP_ORDER = ['DEV', 'STG', 'RC', 'PROD'];

// Splits a flat list into one group per environment (via `getEnvName`),
// ordered DEV/STG/RC/PROD then anything else alphabetically — used to
// display credentials/header values grouped by environment instead of one
// long mixed list. Items with no environment are grouped under
// 'No Environment', sorted last.
export function groupByEnv(items, getEnvName) {
  const groups = new Map();
  for (const item of items) {
    const key = getEnvName(item) || 'No Environment';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const orderedKeys = [...groups.keys()].sort((a, b) => {
    const ai = ENV_GROUP_ORDER.indexOf(a.toUpperCase());
    const bi = ENV_GROUP_ORDER.indexOf(b.toUpperCase());
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  return orderedKeys.map((key) => ({ key, items: groups.get(key) }));
}
