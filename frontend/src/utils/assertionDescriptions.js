// Plain-English description of a saved assertion, split into a label and a
// value — lets a run-result list visually separate "what's being checked"
// from "against what" (label in normal text, value in mono/dim style).
const ASSERTION_PARTS = {
  status_code: (a) => ({ label: 'Status code =', value: a.expected }),
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

export function describeAssertionParts(a) {
  return ASSERTION_PARTS[a.type] ? ASSERTION_PARTS[a.type](a) : { label: JSON.stringify(a), value: '' };
}
