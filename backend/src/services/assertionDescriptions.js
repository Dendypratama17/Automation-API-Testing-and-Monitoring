// Backend port of frontend/src/utils/assertionDescriptions.js — kept in sync
// by hand (CommonJS here vs the frontend's ESM) since this is the only
// place outside the browser that needs to describe an assertion in plain
// English (the automatic Telegram PDF report — see runResultPdf.js).
const ASSERTION_PARTS = {
  status_code: (a) => ({ label: 'Status code =', value: a.expected }),
  status_code_in: (a) => ({ label: 'Status code is one of', value: Array.isArray(a.expected) ? a.expected.join(', ') : a.expected }),
  response_time: (a) => ({ label: 'Response time ≤', value: `${a.max_ms}ms` }),
  field_exists: (a) => ({ label: `Field "${a.path}" exists`, value: '' }),
  field_not_null: (a) => ({ label: `Field "${a.path}" is not null`, value: '' }),
  field_equals: (a) => ({ label: `Field "${a.path}" =`, value: JSON.stringify(a.expected) }),
  field_contains: (a) => ({ label: `Field "${a.path}" contains`, value: `"${a.expected}"` }),
  field_matches: (a) => ({ label: `Field "${a.path}" matches`, value: `/${a.pattern}/` }),
  field_greater_than: (a) => ({ label: `Field "${a.path}" >`, value: a.expected }),
  field_less_than: (a) => ({ label: `Field "${a.path}" <`, value: a.expected }),
  array_length: (a) => ({ label: `Field "${a.path}" has length`, value: a.expected }),
  array_find_equals: (a) => ({
    label: `In "${a.path}", where "${a.matchField}" = ${JSON.stringify(a.matchValue)}, "${a.checkField}" =`,
    value: JSON.stringify(a.expected),
  }),
  array_none_equals: (a) => ({ label: `In "${a.path}", no item's "${a.checkField}" =`, value: JSON.stringify(a.expected) }),
  array_deep_none_equals: (a) => ({
    label: `In "${a.path}"${a.subPath ? `.${a.subPath}` : ''}, no nested "${a.key}" (any depth) =`,
    value: JSON.stringify(a.expected),
  }),
  header_exists: (a) => ({ label: `Header "${a.header}" exists`, value: '' }),
  header_equals: (a) => ({ label: `Header "${a.header}" =`, value: `"${a.expected}"` }),
};

function describeAssertionParts(a) {
  return ASSERTION_PARTS[a.type] ? ASSERTION_PARTS[a.type](a) : { label: JSON.stringify(a), value: '' };
}

module.exports = { describeAssertionParts };
