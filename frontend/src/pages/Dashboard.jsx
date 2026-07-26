import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  LineChart, Line, Bar, ComposedChart, CartesianGrid, XAxis, YAxis, Tooltip, Legend, ReferenceLine, ResponsiveContainer,
} from 'recharts';
import { getEndpointDetail, getEndpointTrend, getAlerts, getLastRuns, getLastFlowRuns, getAnalytics, getEnvironments, getFlowRun, getFlow } from '../api/client';
import JsonBlock from '../components/JsonBlock.jsx';
import { describeAssertionParts } from '../utils/assertionDescriptions.js';
import AssertionStatusIcon from '../components/AssertionStatusIcon.jsx';

// A generic, commonly-used API response-time guideline — not tied to any
// specific assertion, just a visual reference line on the aggregate chart so
// a slowdown trend is obvious at a glance. Ask to change it if 2s isn't right
// for this API.
const SLA_THRESHOLD_MS = 2000;

const RANGE_PRESETS = [
  { key: '1d', label: '1 Day', days: 1 },
  { key: '2d', label: '2 Days', days: 2 },
  { key: '7d', label: '7 Days', days: 7 },
  { key: '1m', label: '1 Month', days: 30 },
];

// Colored by the HTTP status code's leading digit — not by the assertion
// outcome (that's the separate Expected column): 2xx/3xx green, 4xx amber
// (client error), 5xx red (server error), no response at all purple.
function statusCodeBadge(row) {
  const code = row.response_status_code;
  let cls;
  if (code == null) cls = 'error';
  else if (code >= 500) cls = 'fail';
  else if (code >= 400) cls = 'drift';
  else cls = 'pass';
  return <span className={`badge ${cls}`}>{code ?? 'ERR'}</span>;
}

// Whether the step's own assertions (or the fallback < 400 check) passed —
// distinct from the Status column, which shows the raw HTTP status code.
// SCHEMA_DRIFT is its own case, not lumped in with "Failed": the assertions
// did pass, the response shape just changed from what was seen before.
function expectedBadge(row) {
  if (row.status === 'PASS') return <span className="badge pass">Passed</span>;
  if (row.status === 'SCHEMA_DRIFT') return <span className="badge drift">Drift</span>;
  return <span className="badge fail">Failed</span>;
}

// DD/MM/YYYY instead of the browser-locale-dependent default (often M/D/YYYY).
function formatDateTime(dateStr) {
  const d = new Date(dateStr);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `${day}/${month}/${d.getFullYear()}, ${time}`;
}

// Show just the path (not the full https://host/... URL) so the column stays
// compact and doesn't wrap — the Env column already identifies the host.
function resourcePath(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

// One row per Flow Run (see /dashboard/last-flow-runs) — the whole run's
// outcome, not any single step's. `selectedRowId` compares against the
// flow_run id, same id the row itself carries.
function FlowRunHitRow({ row, selectedRowId, onSelect }) {
  const passRatio = `${row.pass_count}/${row.step_count} passed`;
  return (
    <tr
      onClick={() => onSelect(row)}
      style={{ cursor: 'pointer', background: selectedRowId === row.id ? 'var(--accent-soft)' : undefined }}
    >
      <td className="hint" style={{ whiteSpace: 'nowrap' }}>{formatDateTime(row.created_at)}</td>
      <td className="mono hint">{row.id}</td>
      <td title={row.flow_name}>
        <span className="truncate" style={{ maxWidth: '100%' }}>{row.flow_name}</span>
      </td>
      <td>{expectedBadge(row)}</td>
      <td className="hint">{passRatio}</td>
      <td className="mono">{row.total_duration_ms != null ? `${row.total_duration_ms}ms` : '-'}</td>
    </tr>
  );
}

function matchesFlowRunFilters(row, { envFilter, resourceFilter, statusFilter }) {
  if (envFilter !== 'all' && row.environment_name !== envFilter) return false;
  if (statusFilter === 'ok' && row.status !== 'PASS') return false;
  if (statusFilter === 'error' && row.status === 'PASS') return false;
  if (resourceFilter.trim()) {
    const needle = resourceFilter.trim().toLowerCase();
    const haystack = `${row.id} ${row.flow_name || ''} ${row.endpoint_names || ''}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

function HitRow({ row, selectedRowId, onSelect }) {
  return (
    <tr
      onClick={() => row.endpoint_id && onSelect(row)}
      style={{ cursor: row.endpoint_id ? 'pointer' : 'default', background: selectedRowId === row.id ? 'var(--accent-soft)' : undefined }}
    >
      <td className="hint" style={{ whiteSpace: 'nowrap' }}>{formatDateTime(row.created_at)}</td>
      <td className="mono">{row.request_method}</td>
      <td className="mono" style={{ fontSize: 12 }} title={row.request_url}>
        <span className="truncate" style={{ maxWidth: '100%' }}>{resourcePath(row.request_url)}</span>
      </td>
      <td>{statusCodeBadge(row)}</td>
      <td title={row.flow_name}>
        <span className="truncate" style={{ maxWidth: '100%' }}>{row.flow_name}</span>
      </td>
      <td>{expectedBadge(row)}</td>
      <td className="mono">{row.response_time_ms != null ? `${row.response_time_ms}ms` : '-'}</td>
    </tr>
  );
}

// Full detail for one selected hit — rendered right below whichever table
// (Recent Hits or Recent Alerts) the row was clicked from, so it never
// appears to "do nothing" when clicked from the lower table.
function HitDetailPanel({ detail, selectedRow, setSelectedRow, runSteps, stepHeaders, trend, closeDetail, detailRef }) {
  return (
    <div className="card" ref={detailRef}>
      <div className="card-row">
        <h4 style={{ margin: 0 }}>{detail.endpoint.method} {detail.endpoint.name}</h4>
        <button className="btn-quiet" onClick={closeDetail}>✕ Close</button>
      </div>

      <div style={{ marginTop: 16 }}>
        <span className="field-label">Selected Hit</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
          {runSteps.length <= 1 && <span className={`badge ${selectedRow.status.toLowerCase()}`}>{selectedRow.status}</span>}
          <span style={{ fontSize: 13 }}>Flow: <b>{selectedRow.flow_name}</b></span>
        </div>
        <div className="hint" style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12.5, marginTop: 10 }}>
          {selectedRow.base_url && <span>Base URL: {selectedRow.base_url}</span>}
          <span>Env: {selectedRow.environment_name}</span>
          <span>Status: {selectedRow.response_status_code ?? '-'}</span>
          <span>Duration: {selectedRow.response_time_ms}ms</span>
          {selectedRow.request_id && <span className="mono">Request ID: {selectedRow.request_id}</span>}
          <span>{formatDateTime(selectedRow.created_at)}</span>
        </div>

        {runSteps.length > 1 && (
          <div style={{ marginTop: 14 }}>
            <span className="field-label">Steps In This Flow Run</span>
            <div className="stack" style={{ gap: 4, marginTop: 4 }}>
              {runSteps.map((s) => {
                const isCurrent = s.id === selectedRow.id;
                return (
                  <div
                    key={s.id}
                    onClick={() => {
                      if (isCurrent) return;
                      // Sibling steps come from /flow-runs/:id, which doesn't carry the
                      // flow/environment join columns — reuse those from the currently
                      // selected row since every step in a run shares the same flow run.
                      setSelectedRow({
                        ...s,
                        flow_name: selectedRow.flow_name,
                        environment_name: selectedRow.environment_name,
                        base_url: selectedRow.base_url,
                        triggered_by: selectedRow.triggered_by,
                      });
                    }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5,
                      fontWeight: isCurrent ? 700 : 400,
                      cursor: isCurrent ? 'default' : 'pointer',
                      padding: '4px 6px', margin: '-4px -6px', borderRadius: 6,
                    }}
                    onMouseEnter={(e) => { if (!isCurrent) e.currentTarget.style.background = 'var(--surface-2)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <span className={`badge ${s.status.toLowerCase()}`} style={{ flexShrink: 0 }}>{s.status}</span>
                    <span>{s.step_order + 1}. {s.name}</span>
                    {isCurrent && <span className="hint">(currently viewing)</span>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {Array.isArray(selectedRow.assertion_results) && selectedRow.assertion_results.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <span className="field-label">Assertions</span>
            <div className="stack" style={{ gap: 4, marginTop: 4 }}>
              {selectedRow.assertion_results.map((a, i) => {
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
        )}
      </div>

      {/* Response Body aligned with Request Headers (same row); Request
          Body stacks below Request Headers in the left column. */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 18 }}>
        <div className="stack" style={{ minWidth: 0 }}>
          <div>
            <span className="field-label">Request Headers</span>
            <JsonBlock value={stepHeaders ?? detail.endpoint.headers} />
          </div>
          <div>
            <span className="field-label">Request Body</span>
            <JsonBlock value={detail.endpoint.body_template} />
          </div>
        </div>
        <div style={{ minWidth: 0 }}>
          <span className="field-label">Response Body</span>
          <JsonBlock value={selectedRow.response_body} />
        </div>
      </div>

      <h4 style={{ marginTop: 20 }}>Response Time Trend (this endpoint, 7 days)</h4>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={trend}>
          <XAxis dataKey="time" hide />
          <YAxis stroke="#616a80" fontSize={11} tickLine={false} axisLine={false} />
          <Tooltip contentStyle={{ background: '#1a1e29', border: '1px solid #242a3a', borderRadius: 8, fontSize: 12 }} />
          <Line type="monotone" dataKey="ms" stroke="#6d6af6" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function matchesFilters(row, { envFilter, resourceFilter, statusFilter }) {
  if (envFilter !== 'all' && row.environment_name !== envFilter) return false;
  // Match the "Today X OK / Y Error" badge and the Recent Hits status filter:
  // OK/Error is decided by the assertion outcome (row.status), not the raw
  // HTTP code — a step can fail its assertions while still getting back a
  // 200/201, and that must still count (and show up) as an error.
  if (statusFilter === 'ok' && row.status !== 'PASS') return false;
  if (statusFilter === 'error' && row.status === 'PASS') return false;
  if (resourceFilter.trim()) {
    const needle = resourceFilter.trim().toLowerCase();
    // flow_run_id (not this row's own step id) — so typing a Recent Hits ID
    // into search also surfaces that same run's alert rows below.
    const haystack = `${row.flow_run_id ?? ''} ${row.request_url || ''} ${row.endpoint_name || ''} ${row.flow_name || ''}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

export default function Dashboard() {
  const [lastFlowRuns, setLastFlowRuns] = useState([]);
  const [lastFlowRunsTotal, setLastFlowRunsTotal] = useState(0);
  const [alerts, setAlerts] = useState([]);
  const [alertsTotal, setAlertsTotal] = useState(0);
  const [analytics, setAnalytics] = useState([]);
  const [environments, setEnvironments] = useState([]);
  // The specific row (flow_run_step) the user clicked — the detail panel
  // always reflects exactly this hit, not just "the endpoint's latest hit"
  // (those can differ: an older row in the table vs. what happened since).
  const [selectedRow, setSelectedRow] = useState(null);
  // Which table the selected row came from — the detail panel renders right
  // below that same table, instead of always sitting in one fixed spot
  // between the two (which used to make an Alerts-table click look like it
  // did nothing until you scrolled back up).
  const [selectedFrom, setSelectedFrom] = useState(null);
  const [detail, setDetail] = useState(null);
  const [trend, setTrend] = useState([]);
  const [runSteps, setRunSteps] = useState([]);
  const [stepHeaders, setStepHeaders] = useState(null);
  const detailRef = useRef(null);

  const [rangePreset, setRangePreset] = useState('7d');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [envFilter, setEnvFilter] = useState('Stag');
  const [resourceFilter, setResourceFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  // Independent of the range/rangePreset filter above — always "today so
  // far," recomputed periodically so it naturally resets at local midnight
  // even if the tab is left open.
  const [todayRuns, setTodayRuns] = useState([]);

  const range = useMemo(() => {
    if (rangePreset === 'custom') {
      return {
        since: customStart ? new Date(`${customStart}T00:00:00`).toISOString() : undefined,
        until: customEnd ? new Date(`${customEnd}T23:59:59`).toISOString() : undefined,
      };
    }
    const preset = RANGE_PRESETS.find((p) => p.key === rangePreset) || RANGE_PRESETS[2];
    return { since: new Date(Date.now() - preset.days * 24 * 60 * 60 * 1000).toISOString(), until: undefined };
  }, [rangePreset, customStart, customEnd]);

  useEffect(() => {
    getEnvironments().then(setEnvironments).catch(() => setEnvironments([]));
  }, []);

  const refreshTables = () => {
    getLastFlowRuns(range).then((data) => { setLastFlowRuns(data.rows); setLastFlowRunsTotal(data.total); }).catch(() => { setLastFlowRuns([]); setLastFlowRunsTotal(0); });
    getAlerts(range).then((data) => { setAlerts(data.rows); setAlertsTotal(data.total); }).catch(() => { setAlerts([]); setAlertsTotal(0); });
  };

  useEffect(() => {
    refreshTables();
    const analyticsParams = envFilter === 'all' ? range : { ...range, env: envFilter };
    getAnalytics(analyticsParams).then(setAnalytics).catch(() => setAnalytics([]));
  }, [range, envFilter]);

  useEffect(() => {
    const fetchToday = () => {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      // No day is expected to produce more than a few thousand step-hits —
      // the default 300-row cap (meant for the paginated Recent Hits view)
      // would otherwise silently truncate this "whole day" OK/Error count,
      // undercounting errors that happened to fall outside the most recent 300.
      getLastRuns({ since: start.toISOString(), limit: 5000 }).then((data) => setTodayRuns(data.rows)).catch(() => setTodayRuns([]));
    };
    fetchToday();
    const interval = setInterval(fetchToday, 60000);
    return () => clearInterval(interval);
  }, []);

  // Only fetch the endpoint's static config (headers/body/path) + its 7-day
  // trend here — everything about the hit itself (status, response body,
  // timing) comes straight from `selectedRow`, the exact row that was
  // clicked, not a separate "latest run" lookup.
  useEffect(() => {
    if (!selectedRow?.endpoint_id) return;
    let cancelled = false;
    getEndpointDetail(selectedRow.endpoint_id).then((data) => { if (!cancelled) setDetail(data); }).catch(() => { if (!cancelled) setDetail(null); });
    getEndpointTrend(selectedRow.endpoint_id, { days: 7 }).then((data) => {
      if (!cancelled) setTrend(data.map((d) => ({ time: new Date(d.created_at).toLocaleString(), ms: d.response_time_ms })));
    });
    return () => { cancelled = true; };
  }, [selectedRow]);

  // Every step that ran as part of the SAME flow execution as this hit (e.g.
  // Upload then Share) — a flow run's steps show as separate rows in the
  // tables above, so this ties the selected one back to its siblings.
  useEffect(() => {
    if (!selectedRow?.flow_run_id) { setRunSteps([]); return; }
    let cancelled = false;
    getFlowRun(selectedRow.flow_run_id).then((run) => { if (!cancelled) setRunSteps(run.steps || []); }).catch(() => { if (!cancelled) setRunSteps([]); });
    return () => { cancelled = true; };
  }, [selectedRow]);

  // The endpoint's own headers (`detail.endpoint.headers`, fetched above)
  // don't reflect anything the Flow step itself overrode/added (e.g. an
  // Accept-Language row added only in this flow) — flow_run_steps doesn't
  // persist the exact resolved headers either, so the closest accurate
  // stand-in is the flow step's OWN saved header config (still a template,
  // same caveat as the Request Body box already has).
  useEffect(() => {
    if (!selectedRow?.flow_run_id || selectedRow.step_order == null) { setStepHeaders(null); return; }
    let cancelled = false;
    getFlowRun(selectedRow.flow_run_id)
      .then((run) => getFlow(run.flow_id))
      .then((flow) => {
        if (cancelled) return;
        const step = (flow.steps || []).find((s) => s.step_order === selectedRow.step_order);
        setStepHeaders(step ? step.headers : null);
      })
      .catch(() => { if (!cancelled) setStepHeaders(null); });
    return () => { cancelled = true; };
  }, [selectedRow]);

  // The panel now renders right below whichever table (Hits or Alerts) the
  // row was clicked from (see `selectedFrom`) — this just nudges it fully
  // into view in case it renders partly below the fold.
  useEffect(() => {
    if (detail) detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [detail]);

  const closeDetail = () => {
    setSelectedRow(null);
    setSelectedFrom(null);
    setDetail(null);
    setTrend([]);
  };

  // A Recent Hits row is now a whole Flow Run, not a single step — the
  // detail panel below still needs one specific step to key off of (it shows
  // that step's request/response plus the "Steps In This Flow Run" list to
  // switch between siblings), so default to the run's first step.
  const handleSelectFlowRun = async (flowRunRow) => {
    const run = await getFlowRun(flowRunRow.id);
    const firstStep = run.steps?.[0];
    if (!firstStep) return;
    setSelectedRow({
      ...firstStep,
      flow_name: flowRunRow.flow_name,
      environment_name: flowRunRow.environment_name,
      base_url: flowRunRow.base_url,
      triggered_by: flowRunRow.triggered_by,
    });
    setSelectedFrom('hits');
  };

  const filters = { envFilter, resourceFilter, statusFilter };
  const filteredFlowRuns = lastFlowRuns.filter((r) => matchesFlowRunFilters(r, filters));
  const filteredAlerts = alerts.filter((a) => matchesFilters(a, filters));

  // Total Passed/Failed for TODAY only (resets at local midnight, fetched
  // independently of whatever date range is selected above) — driven by the
  // same assertion outcome as the Expected column, ignoring the status
  // filter itself so both counts stay meaningful regardless of its value.
  const todayFilteredHits = todayRuns.filter((r) => matchesFilters(r, { envFilter, resourceFilter, statusFilter: 'all' }));
  const totalOk = todayFilteredHits.filter((r) => r.status === 'PASS').length;
  const totalError = todayFilteredHits.length - totalOk;

  const chartData = analytics.map((d) => ({
    day: new Date(d.day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    Pass: Number(d.pass_count),
    Fail: Number(d.fail_count),
    Error: Number(d.error_count),
    Drift: Number(d.drift_count),
    avgMs: d.avg_duration_ms != null ? Number(d.avg_duration_ms) : null,
  }));

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 24, flexWrap: 'wrap' }}>
        <div>
          <h3>Dashboard</h3>
          <p>Traffic and health of every endpoint hit via a Flow, across all environments.</p>
        </div>

        <div className="toolbar" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <select value={rangePreset} onChange={(e) => setRangePreset(e.target.value)}>
            {RANGE_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            <option value="custom">Custom</option>
          </select>
          {rangePreset === 'custom' && (
            <>
              <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} style={{ width: 140 }} />
              <span className="hint">to</span>
              <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} style={{ width: 140 }} />
            </>
          )}
          <select value={envFilter} onChange={(e) => setEnvFilter(e.target.value)}>
            {environments.map((env) => <option key={env.id} value={env.name}>{env.name}</option>)}
          </select>
          <input
            placeholder="Search ID, resource, or flow..."
            value={resourceFilter}
            onChange={(e) => setResourceFilter(e.target.value)}
            style={{ width: 210 }}
          />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="all">All Statuses</option>
            <option value="ok">OK</option>
            <option value="error">Error</option>
          </select>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 28, marginBottom: 12 }}>
        <h4 style={{ margin: 0 }}>Recent Hits</h4>
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '7px 16px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 999,
          }}
        >
          <span className="hint" style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Today
          </span>
          <span style={{ width: 1, height: 14, background: 'var(--border)' }} />
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--pass)' }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--pass)' }} />
            {totalOk} OK
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--fail)' }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--fail)' }} />
            {totalError} Error
          </span>
        </div>
      </div>
      <div className="card scroll-table" style={{ padding: 0, maxHeight: 315 }}>
        <table>
          <thead>
            <tr>
              <th style={{ width: 170 }}>Date</th>
              <th style={{ width: 70 }}>ID</th>
              <th style={{ width: 220 }}>Flow</th>
              <th style={{ width: 90 }}>Result</th>
              <th style={{ width: 110 }}>Steps</th>
              <th style={{ width: 90 }}>Duration</th>
            </tr>
          </thead>
          <tbody>
            {filteredFlowRuns.map((r) => (
              <FlowRunHitRow
                key={r.id} row={r} selectedRowId={selectedRow?.flow_run_id}
                onSelect={handleSelectFlowRun}
              />
            ))}
            {filteredFlowRuns.length === 0 && (
              <tr><td colSpan={6} className="empty-state">No hits match this range/filter.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {lastFlowRunsTotal > lastFlowRuns.length && (
        <p className="hint" style={{ fontSize: 12, marginTop: 6 }}>
          Showing {lastFlowRuns.length} of {lastFlowRunsTotal} — narrow the date range to see the rest.
        </p>
      )}

      {detail && selectedRow && selectedFrom === 'hits' && (
        <HitDetailPanel
          detail={detail} selectedRow={selectedRow} setSelectedRow={setSelectedRow}
          runSteps={runSteps} stepHeaders={stepHeaders} trend={trend} closeDetail={closeDetail} detailRef={detailRef}
        />
      )}

      <h4 style={{ marginTop: 28, marginBottom: 12 }}>Recent Alerts</h4>
      <div className="card scroll-table" style={{ padding: 0, maxHeight: 235 }}>
        <table>
          <thead>
            <tr>
              <th style={{ width: 170 }}>Date</th>
              <th style={{ width: 80 }}>Method</th>
              <th style={{ width: 210 }}>Resource</th>
              <th style={{ width: 90 }}>Status</th>
              <th style={{ width: 200 }}>Flow</th>
              <th style={{ width: 90 }}>Result</th>
              <th style={{ width: 90 }}>Duration</th>
            </tr>
          </thead>
          <tbody>
            {filteredAlerts.map((a) => (
              <HitRow
                key={a.id} row={a} selectedRowId={selectedRow?.id}
                onSelect={(row) => { setSelectedRow(row); setSelectedFrom('alerts'); }}
              />
            ))}
            {filteredAlerts.length === 0 && <tr><td colSpan={7} className="empty-state">No alerts match this range/filter.</td></tr>}
          </tbody>
        </table>
      </div>
      {alertsTotal > alerts.length && (
        <p className="hint" style={{ fontSize: 12, marginTop: 6 }}>
          Showing {alerts.length} of {alertsTotal} — narrow the date range to see the rest.
        </p>
      )}

      {detail && selectedRow && selectedFrom === 'alerts' && (
        <HitDetailPanel
          detail={detail} selectedRow={selectedRow} setSelectedRow={setSelectedRow}
          runSteps={runSteps} stepHeaders={stepHeaders} trend={trend} closeDetail={closeDetail} detailRef={detailRef}
        />
      )}

      <h4 style={{ marginTop: 28, marginBottom: 12 }}>Traffic &amp; Health Trend</h4>
      <div className="card">
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={chartData}>
            <defs>
              <linearGradient id="gradPass" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#34d399" stopOpacity={0.55} />
                <stop offset="100%" stopColor="#34d399" stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="gradFail" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#f87171" stopOpacity={0.55} />
                <stop offset="100%" stopColor="#f87171" stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="gradError" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#c084fc" stopOpacity={0.55} />
                <stop offset="100%" stopColor="#c084fc" stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="gradDrift" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#fbbf24" stopOpacity={0.55} />
                <stop offset="100%" stopColor="#fbbf24" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#1c212e" vertical={false} />
            <XAxis dataKey="day" stroke="#616a80" fontSize={11.5} tickLine={false} axisLine={false} />
            <YAxis yAxisId="left" stroke="#616a80" fontSize={11.5} tickLine={false} axisLine={false} allowDecimals={false} width={32} />
            <YAxis yAxisId="right" orientation="right" stroke="#616a80" fontSize={11.5} tickLine={false} axisLine={false} width={40} />
            <Tooltip
              cursor={{ stroke: '#33394a', strokeWidth: 1 }}
              contentStyle={{ background: '#12151d', border: '1px solid #242a3a', borderRadius: 10, fontSize: 12.5, padding: '10px 12px' }}
              labelStyle={{ color: '#97a0b5', marginBottom: 4 }}
            />
            <Legend wrapperStyle={{ fontSize: 12.5, paddingTop: 12 }} iconType="circle" iconSize={8} />
            <Bar yAxisId="left" dataKey="Pass" stackId="s" fill="url(#gradPass)" stroke="#34d399" strokeWidth={1} barSize={22} />
            <Bar yAxisId="left" dataKey="Fail" stackId="s" fill="url(#gradFail)" stroke="#f87171" strokeWidth={1} barSize={22} />
            <Bar yAxisId="left" dataKey="Error" stackId="s" fill="url(#gradError)" stroke="#c084fc" strokeWidth={1} barSize={22} />
            <Bar yAxisId="left" dataKey="Drift" stackId="s" fill="url(#gradDrift)" stroke="#fbbf24" strokeWidth={1} barSize={22} radius={[4, 4, 0, 0]} />
            <Line yAxisId="right" type="monotone" dataKey="avgMs" name="Avg Duration (ms)" stroke="#8280f8" strokeWidth={2.5} dot={{ r: 3, fill: '#8280f8', strokeWidth: 0 }} activeDot={{ r: 6 }} />
            <ReferenceLine
              yAxisId="right"
              y={SLA_THRESHOLD_MS}
              stroke="var(--fail)"
              strokeDasharray="4 4"
              strokeWidth={1.5}
              label={{ value: `SLA ${SLA_THRESHOLD_MS}ms`, position: 'insideTopRight', fill: 'var(--fail)', fontSize: 11 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
        {chartData.length === 0 && <p className="empty-state">No data in this range yet.</p>}
      </div>
    </div>
  );
}
