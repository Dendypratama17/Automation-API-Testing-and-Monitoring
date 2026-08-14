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
