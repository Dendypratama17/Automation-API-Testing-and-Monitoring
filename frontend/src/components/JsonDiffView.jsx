import React from 'react';

// Splits a diff path like "data.placements[0].status" into
// ['data', 'placements', '[0]', 'status'] so it can be walked back into a
// nested tree — a flat list of {path, old_value, new_value} isn't readable
// on its own once there's more than a couple of differences.
function parsePathSegments(path) {
  return path.match(/[^.[\]]+|\[\d+\]/g) || [path];
}

// Rebuilds the flat diff list into a nested object tree, {__diff__: true,
// old_value, new_value} marking each leaf that actually differs — every
// other key in the tree only exists to give that leaf a path to sit at.
function buildDiffTree(diffs) {
  const root = {};
  for (const d of diffs) {
    const segments = parsePathSegments(d.path);
    let node = root;
    for (let i = 0; i < segments.length - 1; i++) {
      node[segments[i]] = node[segments[i]] || {};
      node = node[segments[i]];
    }
    node[segments[segments.length - 1]] = { __diff__: true, old_value: d.old_value, new_value: d.new_value };
  }
  return root;
}

function formatValue(value) {
  if (value === undefined) return '(missing)';
  if (typeof value === 'string') return `"${value}"`;
  return JSON.stringify(value);
}

const diffLineStyle = {
  wordBreak: 'break-all',
  whiteSpace: 'pre-wrap',
  borderRadius: 5,
  padding: '4px 8px',
  lineHeight: 1.5,
};

function DiffNode({ nodeKey, value, depth }) {
  const indent = { paddingLeft: depth * 16 };
  if (value && value.__diff__) {
    return (
      <div style={{ ...indent, fontSize: 12.5, padding: '6px 0' }}>
        <div className="mono" style={{ color: 'var(--text-dim)', marginBottom: 4 }}>{nodeKey}</div>
        <div className="stack" style={{ gap: 3 }}>
          <div className="mono" style={{ ...diffLineStyle, color: 'var(--fail)', background: 'var(--fail-bg)' }}>
            − {formatValue(value.old_value)}
          </div>
          <div className="mono" style={{ ...diffLineStyle, color: 'var(--pass)', background: 'var(--pass-bg)' }}>
            + {formatValue(value.new_value)}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div style={{ fontSize: 12.5 }}>
      <div style={{ ...indent, color: 'var(--text-dim)' }}>{nodeKey}:</div>
      {Object.entries(value).map(([k, v]) => (
        <DiffNode key={k} nodeKey={k} value={v} depth={depth + 1} />
      ))}
    </div>
  );
}

// Renders a flat list of {path, old_value, new_value} diffs (see
// backend/src/services/jsonDiff.js) as a nested "only what changed" tree —
// old value struck through in red, new value in green — instead of a full
// side-by-side of two entire JSON payloads that are mostly identical.
export default function JsonDiffView({ diffs }) {
  if (diffs.length === 0) {
    return <p className="hint" style={{ fontSize: 12.5 }}>No differences (outside of ignored fields).</p>;
  }
  const tree = buildDiffTree(diffs);
  return (
    <div className="mono" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
      {Object.entries(tree).map(([k, v]) => (
        <DiffNode key={k} nodeKey={k} value={v} depth={0} />
      ))}
    </div>
  );
}
