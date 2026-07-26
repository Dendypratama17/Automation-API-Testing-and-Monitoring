import React, { useEffect, useState } from 'react';
import {
  getSchedules, createSchedule, deleteSchedule, getScheduleHistory, getScheduleRuns, getEnvironments, getFlows,
} from '../api/client';
import { StopIcon } from '../components/icons.jsx';
import { useConfirm } from '../components/ConfirmProvider.jsx';
import { useToast } from '../components/ToastProvider.jsx';
import JsonBlock from '../components/JsonBlock.jsx';
import { describeAssertionParts } from '../utils/assertionDescriptions.js';
import AssertionStatusIcon from '../components/AssertionStatusIcon.jsx';

const CRON_PRESETS = [
  { label: 'Every 30 seconds', value: '*/30 * * * * *' },
  { label: 'Every 1 minute', value: '*/1 * * * *' },
  { label: 'Every 5 minutes', value: '*/5 * * * *' },
  { label: 'Every 30 minutes', value: '*/30 * * * *' },
  { label: 'Every 1 hour', value: '0 * * * *' },
  { label: 'Every day at 12pm', value: '0 12 * * *' },
  { label: 'Every day at 6pm', value: '0 18 * * *' },
];

// Just the path, not the full {{base_url}}-resolved URL — matches the
// Dashboard's Resource column so run history reads consistently.
function resourcePath(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

const ASSERTION_FAILURE_LABELS = {
  status_code: (a) => `Expected status ${a.expected}`,
  response_time: (a) => `Expected response time ≤ ${a.max_ms}ms`,
  field_exists: (a) => `Expected field "${a.path}" to exist`,
  field_not_null: (a) => `Expected field "${a.path}" to not be null`,
  field_equals: (a) => `Expected "${a.path}" to equal ${JSON.stringify(a.expected)}`,
  field_contains: (a) => `Expected "${a.path}" to contain "${a.expected}"`,
  field_matches: (a) => `Expected "${a.path}" to match /${a.pattern}/`,
  field_greater_than: (a) => `Expected "${a.path}" > ${a.expected}`,
  field_less_than: (a) => `Expected "${a.path}" < ${a.expected}`,
  array_length: (a) => `Expected "${a.path}" to have length ${a.expected}`,
  array_find_equals: (a) => `Expected "${a.path}" item where "${a.matchField}"=${JSON.stringify(a.matchValue)} to have "${a.checkField}"=${JSON.stringify(a.expected)}`,
  header_exists: (a) => `Expected header "${a.header}" to exist`,
  header_equals: (a) => `Expected header "${a.header}" to equal "${a.expected}"`,
  http_status: (a) => `Expected status ${a.expected}, got ${a.actual}`,
};

function formatFailureReasons(errorMessage) {
  if (!errorMessage) return [];
  try {
    const parsed = JSON.parse(errorMessage);
    if (Array.isArray(parsed)) {
      return parsed.map((a) => (ASSERTION_FAILURE_LABELS[a.type] ? ASSERTION_FAILURE_LABELS[a.type](a) : JSON.stringify(a)));
    }
  } catch {
    // not JSON — fall through to plain text below
  }
  return [String(errorMessage)];
}

export default function Schedules() {
  const confirm = useConfirm();
  const showToast = useToast();
  const [schedules, setSchedules] = useState([]);
  const [environments, setEnvironments] = useState([]);
  const [flows, setFlows] = useState([]);
  const [form, setForm] = useState({ name: '', cron_expression: '', flow_id: '', environment_id: '' });
  const [formErrors, setFormErrors] = useState({});
  const [viewingSchedule, setViewingSchedule] = useState(null); // { schedule, runs }

  const load = () => getSchedules().then(setSchedules);
  useEffect(() => {
    load();
    getEnvironments().then((envs) => {
      setEnvironments(envs);
      const stag = envs.find((e) => e.name.toLowerCase() === 'stag');
      if (stag) setForm((f) => ({ ...f, environment_id: String(stag.id) }));
    });
    getFlows().then(setFlows);
  }, []);

  const openScheduleRuns = async (schedule) => {
    const runs = await getScheduleRuns(schedule.id, { limit: 20 }).catch(() => []);
    setViewingSchedule({ schedule, runs });
  };

  const handleCreate = async () => {
    const errors = {};
    if (!form.name.trim()) errors.name = true;
    if (!form.cron_expression) errors.cron = true;
    if (!form.flow_id) errors.flow = true;
    if (!form.environment_id) errors.environment = true;
    setFormErrors(errors);
    if (Object.keys(errors).length) return;

    const env = environments.find((e) => e.id === Number(form.environment_id));
    if (env?.is_protected) {
      const ok = await confirm(
        `"${env.name}" is a protected environment. This schedule will run automatically on its cron, with no confirmation each time. Continue?`
      );
      if (!ok) return;
    }
    await createSchedule({ ...form, flow_id: Number(form.flow_id), environment_id: Number(form.environment_id) });
    showToast(`Schedule "${form.name}" created successfully.`);
    setForm({ name: '', cron_expression: '', flow_id: '', environment_id: '' });
    load();
  };

  const handleDelete = async (id) => {
    const schedule = schedules.find((s) => s.id === id);
    const history = await getScheduleHistory(id).catch(() => null);
    const totalRuns = history ? Number(history.total_runs) : 0;

    let message = `Stop schedule "${schedule?.name}"?`;
    if (totalRuns > 0) {
      message += `\n\nThis schedule has run ${totalRuns} time${totalRuns === 1 ? '' : 's'}:`;
      message += `\n  ✅ ${history.pass_count} pass · ❌ ${history.fail_count} fail · 🔥 ${history.error_count} error · ⚠️ ${history.drift_count} drift`;
      message += `\n  Last run: ${new Date(history.last_run_at).toLocaleString()}`;
      message += '\n\nThis only stops the schedule itself — its past run history stays in the Dashboard.';
    }

    if (await confirm(message)) {
      await deleteSchedule(id);
      load();
    }
  };

  return (
    <div>
      <div className="page-header">
        <h3>Scheduled Runs</h3>
        <p>A Flow will run automatically on its cron schedule; results land in the Dashboard, and any FAIL/ERROR/DRIFT step sends a Telegram notification.</p>
      </div>

      <div className="card">
        <h4>Create New Schedule</h4>
        <div className="toolbar">
          <input
            placeholder="Schedule name"
            value={form.name}
            onChange={(e) => { setForm({ ...form, name: e.target.value }); setFormErrors({ ...formErrors, name: false }); }}
            style={{ borderColor: formErrors.name ? 'var(--fail)' : undefined }}
          />
          <select
            value={form.cron_expression}
            onChange={(e) => { setForm({ ...form, cron_expression: e.target.value }); setFormErrors({ ...formErrors, cron: false }); }}
            style={{ borderColor: formErrors.cron ? 'var(--fail)' : undefined }}
          >
            <option value="">Select Schedule</option>
            {CRON_PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
          <select
            value={form.flow_id}
            onChange={(e) => { setForm({ ...form, flow_id: e.target.value }); setFormErrors({ ...formErrors, flow: false }); }}
            style={{ borderColor: formErrors.flow ? 'var(--fail)' : undefined }}
          >
            <option value="">Select Flow</option>
            {flows.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <select
            value={form.environment_id}
            onChange={(e) => { setForm({ ...form, environment_id: e.target.value }); setFormErrors({ ...formErrors, environment: false }); }}
            style={{ borderColor: formErrors.environment ? 'var(--fail)' : undefined }}
          >
            <option value="">Select Environment</option>
            {environments.map((env) => (
              <option key={env.id} value={env.id}>{env.name}{env.is_protected ? ' (protected)' : ''}</option>
            ))}
          </select>
          <button className="btn-primary" onClick={handleCreate}>Create</button>
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th style={{ width: 160 }}>Name</th>
              <th style={{ width: 100 }}>Cron</th>
              <th style={{ width: 140 }}>Flow</th>
              <th style={{ width: 110 }}>Environment</th>
              <th style={{ width: 140 }}>Date Created</th>
              <th style={{ width: 150 }}>Last Run</th>
              <th style={{ width: 150 }}>Runs</th>
              <th style={{ width: 80 }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {schedules.map((s) => (
              <tr
                key={s.id}
                style={{ cursor: 'pointer', ...(s.deleted_at ? { opacity: 0.5 } : {}) }}
                onClick={() => openScheduleRuns(s)}
                title="Click to view run history"
              >
                <td title={s.name}>
                  <span className="truncate" style={{ maxWidth: '100%' }}>{s.name}</span>
                  {s.deleted_at && <span className="badge fail" style={{ marginLeft: 6 }}>stopped</span>}
                </td>
                <td><code>{s.cron_expression}</code></td>
                <td title={s.flow_name}><span className="truncate" style={{ maxWidth: '100%' }}>{s.flow_name}</span></td>
                <td>
                  {s.environment_name}
                  {s.is_protected && <span className="badge fail" style={{ marginLeft: 6 }}>protected</span>}
                </td>
                <td className="hint" style={{ whiteSpace: 'nowrap' }}>{new Date(s.created_at).toLocaleString()}</td>
                <td className="hint" style={{ whiteSpace: 'nowrap' }}>{s.last_run_at ? new Date(s.last_run_at).toLocaleString() : 'never'}</td>
                <td style={{ fontSize: 12.5 }}>
                  {Number(s.total_runs) > 0 ? (
                    <span className="hint">
                      <span style={{ color: 'var(--pass)' }}>✓{s.pass_count}</span>
                      {' · '}
                      <span style={{ color: 'var(--fail)' }}>✕{s.fail_count}</span>
                      {Number(s.error_count) > 0 && <span style={{ color: 'var(--error)' }}> · 🔥{s.error_count}</span>}
                      {Number(s.drift_count) > 0 && <span style={{ color: 'var(--drift)' }}> · ⚠{s.drift_count}</span>}
                    </span>
                  ) : (
                    <span className="hint">—</span>
                  )}
                </td>
                <td>
                  {s.deleted_at ? (
                    <span className="hint">—</span>
                  ) : (
                    <button
                      className="btn-icon btn-danger"
                      onClick={(e) => { e.stopPropagation(); handleDelete(s.id); }}
                      title="Stop"
                      aria-label="Stop"
                    >
                      <StopIcon />
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {schedules.length === 0 && <tr><td colSpan={8} className="empty-state">No schedules yet.</td></tr>}
          </tbody>
        </table>
      </div>

      {viewingSchedule && (
        <div className="card">
          <div className="card-row">
            <h4 style={{ margin: 0 }}>Run History: {viewingSchedule.schedule.name}</h4>
            <button className="btn-quiet" onClick={() => setViewingSchedule(null)}>✕ Close</button>
          </div>
          <div className="stack" style={{ marginTop: 16, gap: 20 }}>
            {viewingSchedule.runs.length === 0 && <span className="hint">No runs yet.</span>}
            {viewingSchedule.runs.map((r, idx) => {
              const failureReasons = formatFailureReasons(r.error_message);
              const hasAssertionResults = Array.isArray(r.assertion_results) && r.assertion_results.length > 0;
              return (
                <div
                  key={r.id}
                  style={idx < viewingSchedule.runs.length - 1 ? { borderBottom: '1px solid var(--border-soft)', paddingBottom: 20 } : undefined}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span className={`badge ${r.status.toLowerCase()}`}>{r.status}</span>
                    <span className="hint">{new Date(r.created_at).toLocaleString()}</span>
                  </div>
                  <div className="mono hint" style={{ fontSize: 12, marginTop: 6 }}>
                    {r.request_method} {resourcePath(r.request_url)}
                  </div>
                  <div className="hint" style={{ display: 'flex', gap: 16, fontSize: 12.5, marginTop: 6, flexWrap: 'wrap' }}>
                    <span>Status: {r.response_status_code ?? '-'}</span>
                    <span>Duration: {r.response_time_ms ?? '-'}ms</span>
                    {r.request_id && <span className="mono">Request ID: {r.request_id}</span>}
                  </div>

                  {hasAssertionResults ? (
                    <div style={{ marginTop: 10 }}>
                      <span className="field-label">Assertions</span>
                      <div className="stack" style={{ gap: 4, marginTop: 4 }}>
                        {r.assertion_results.map((a, i) => {
                          const parts = describeAssertionParts(a);
                          return (
                            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                              <AssertionStatusIcon passed={a.passed} />
                              <span>{parts.label}</span>
                              {parts.value !== '' && (
                                <span className="mono" style={{ color: 'var(--text-dim)', overflowWrap: 'anywhere' }}>{parts.value}</span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : failureReasons.length > 0 && (
                    <div
                      style={{
                        marginTop: 10, padding: '8px 12px', borderRadius: 8,
                        background: 'var(--fail-bg)', color: 'var(--fail)', fontSize: 12.5,
                      }}
                    >
                      {failureReasons.map((reason, i) => <div key={i}>{reason}</div>)}
                    </div>
                  )}

                  {(r.request_body != null || r.response_body != null) && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 14 }}>
                      <div style={{ minWidth: 0 }}>
                        {r.request_body != null && (
                          <>
                            <span className="field-label">Request Body</span>
                            <JsonBlock value={r.request_body} />
                          </>
                        )}
                      </div>
                      <div style={{ minWidth: 0 }}>
                        {r.response_body != null && (
                          <>
                            <span className="field-label">Response Body</span>
                            <JsonBlock value={r.response_body} />
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
