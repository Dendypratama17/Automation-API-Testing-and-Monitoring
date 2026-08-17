const axios = require('axios');
const pool = require('../db/pool');
const { buildRunResultPdf } = require('./runResultPdf');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
// Separate bot for the "Share to Telegram" document feature — kept apart from
// the bot above (which only ever sends automatic flow-run alert messages).
const DOC_BOT_TOKEN = process.env.TELEGRAM_DOC_BOT_TOKEN || BOT_TOKEN;
const DOC_CHAT_ID = process.env.TELEGRAM_DOC_CHAT_ID || CHAT_ID;
// Optional — the group is a forum-style supergroup with Topics; when set,
// routes the document into that specific topic instead of the general one.
const DOC_THREAD_ID = process.env.TELEGRAM_DOC_THREAD_ID || null;
const APP_BASE_URL = process.env.APP_BASE_URL; // optional, e.g. http://localhost:5180 — enables a "View in Dashboard" link

/**
 * Send a message via Telegram Bot API using HTML parse mode.
 * (MarkdownV2 caused parse errors in past experience — HTML is more forgiving.)
 */
async function sendTelegramMessage(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn('[telegramNotifier] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set, skipping notification');
    return { skipped: true };
  }

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const response = await axios.post(url, {
    chat_id: CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
  return response.data;
}

/**
 * Share an arbitrary file (e.g. a JSON Diff / flow-run PDF export) to the
 * configured doc chat/topic, via Telegram's sendDocument. Called two ways:
 * manually (an explicit "Share to Telegram" click from the browser) and
 * automatically (notifyFlowIfNeeded below, attaching the run's PDF report
 * whenever it sends a failure alert). Native FormData/Blob (Node 20+) — no
 * extra multipart-body dependency.
 */
async function sendTelegramDocument(buffer, filename, caption = '') {
  if (!DOC_BOT_TOKEN || !DOC_CHAT_ID) {
    throw new Error('TELEGRAM_DOC_BOT_TOKEN / TELEGRAM_DOC_CHAT_ID not configured on the server.');
  }

  const url = `https://api.telegram.org/bot${DOC_BOT_TOKEN}/sendDocument`;
  const form = new FormData();
  form.append('chat_id', DOC_CHAT_ID);
  if (DOC_THREAD_ID) form.append('message_thread_id', DOC_THREAD_ID);
  if (caption) form.append('caption', caption.slice(0, 1024)); // Telegram's own caption limit
  form.append('document', new Blob([buffer], { type: 'application/pdf' }), filename);

  const response = await axios.post(url, form);
  return response.data;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// File fields carry a base64 blob (see FormDataEditor) — way too large and
// noisy for a chat message, so swap it for a short human-readable placeholder.
function sanitizeForDisplay(value) {
  if (Array.isArray(value)) return value.map(sanitizeForDisplay);
  if (value && typeof value === 'object') {
    if (value.__file__) {
      const bytes = value.data ? Math.round((value.data.length * 3) / 4) : 0;
      return { __file__: true, name: value.name, mimeType: value.mimeType, data: `<${bytes} bytes omitted>` };
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeForDisplay(v);
    return out;
  }
  return value;
}

// Renders a value as a compact, HTML-escaped JSON code block, capped so one
// giant body can't blow out the whole Telegram message.
function formatJsonBlock(value, maxLen = 500) {
  if (value === undefined || value === null) return null;
  let json = JSON.stringify(sanitizeForDisplay(value), null, 2);
  if (!json || json === '{}') return null;
  if (json.length > maxLen) json = `${json.slice(0, maxLen)}\n… (truncated)`;
  return `<pre>${escapeHtml(json)}</pre>`;
}

// Keeps message bodies compact and legible — just the path, not the full
// {{base_url}}-resolved URL (host is already implied by the environment).
function resourcePath(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

const STATUS_EMOJI = { FAIL: '❌', ERROR: '🔥', SCHEMA_DRIFT: '⚠️' };

// Every interpolated value is escaped, even ones that "should" just be a
// number — e.g. the default http_status assertion's expected value is the
// literal string "< 400", whose "<" previously broke Telegram's HTML parser
// and silently killed every FAIL notification.
const ASSERTION_LABELS = {
  status_code: (a) => `Expected status <b>${escapeHtml(a.expected)}</b>`,
  status_code_in: (a) => `Expected status to be one of <b>${escapeHtml(Array.isArray(a.expected) ? a.expected.join(', ') : a.expected)}</b>`,
  response_time: (a) => `Expected response time ≤ <b>${escapeHtml(a.max_ms)}ms</b>`,
  field_exists: (a) => `Expected field <code>${escapeHtml(a.path)}</code> to exist`,
  field_equals: (a) => `Expected <code>${escapeHtml(a.path)}</code> to equal <code>${escapeHtml(String(a.expected))}</code>`,
  field_contains: (a) => `Expected <code>${escapeHtml(a.path)}</code> to contain <code>${escapeHtml(String(a.expected))}</code>`,
  field_matches: (a) => `Expected <code>${escapeHtml(a.path)}</code> to match <code>/${escapeHtml(a.pattern)}/</code>`,
  field_greater_than: (a) => `Expected <code>${escapeHtml(a.path)}</code> &gt; <b>${escapeHtml(a.expected)}</b>`,
  field_less_than: (a) => `Expected <code>${escapeHtml(a.path)}</code> &lt; <b>${escapeHtml(a.expected)}</b>`,
  array_length: (a) => `Expected <code>${escapeHtml(a.path)}</code> to have length <b>${escapeHtml(a.expected)}</b>`,
  array_none_equals: (a) => `Expected no item in <code>${escapeHtml(a.path)}</code> to have <code>${escapeHtml(a.checkField)}</code> = <code>${escapeHtml(String(a.expected))}</code>`,
  array_deep_none_equals: (a) => `Expected no nested <code>${escapeHtml(a.key)}</code> under <code>${escapeHtml(a.path)}${a.subPath ? `.${a.subPath}` : ''}</code> to equal <code>${escapeHtml(String(a.expected))}</code>`,
  header_exists: (a) => `Expected header <code>${escapeHtml(a.header)}</code> to exist`,
  header_equals: (a) => `Expected header <code>${escapeHtml(a.header)}</code> to equal <code>${escapeHtml(String(a.expected))}</code>`,
  http_status: (a) => `Expected status <b>${escapeHtml(a.expected)}</b>, got <b>${escapeHtml(a.actual)}</b>`,
};

// step.error_message is either a JSON array of failed-assertion objects (see
// flowExecutor.checkAssertions) or, for ERROR steps, a plain exception
// message string — handle both instead of dumping raw JSON in the alert.
function formatErrorMessage(errorMessage) {
  if (!errorMessage) return null;
  try {
    const parsed = JSON.parse(errorMessage);
    if (Array.isArray(parsed)) {
      return parsed
        .map((a) => (ASSERTION_LABELS[a.type] ? ASSERTION_LABELS[a.type](a) : escapeHtml(JSON.stringify(a))))
        .map((line) => `   ↳ ${line}`)
        .join('\n');
    }
  } catch {
    // not JSON — fall through to plain text below
  }
  return `   ↳ ${escapeHtml(String(errorMessage)).slice(0, 300)}`;
}

const SCHEMA_DIFF_LABELS = {
  type_changed: (d) => `<code>${escapeHtml(d.path)}</code>: type changed <b>${escapeHtml(d.from)}</b> → <b>${escapeHtml(d.to)}</b>`,
  field_removed: (d) => `<code>${escapeHtml(d.path)}</code>: field removed`,
  field_added: (d) => `<code>${escapeHtml(d.path)}</code>: field added`,
};

function formatSchemaDiffs(diffs) {
  if (!diffs || !diffs.length) return null;
  return diffs
    .map((d) => (SCHEMA_DIFF_LABELS[d.change] ? SCHEMA_DIFF_LABELS[d.change](d) : escapeHtml(JSON.stringify(d))))
    .map((line) => `   ↳ ${line}`)
    .join('\n');
}

function formatStep(step, index) {
  const emoji = STATUS_EMOJI[step.status] || '•';
  const lines = [
    `${emoji} <b>${index + 1}. ${escapeHtml(step.name || 'Unnamed step')}</b> — ${step.status}`,
    `🔗 <code>${escapeHtml(step.request_method || '?')} ${escapeHtml(resourcePath(step.request_url || ''))}</code>`,
  ];

  if (step.status === 'ERROR') {
    lines.push('📡 No response received (connection/timeout error)');
  } else {
    lines.push(`📶 Status: <b>${step.response_status_code ?? '-'}</b>  ⏱ Duration: <b>${step.response_time_ms ?? '-'}ms</b>`);
  }

  if (step.request_id) lines.push(`🆔 Request ID: <code>${escapeHtml(step.request_id)}</code>`);

  const errorLines = formatErrorMessage(step.error_message);
  if (errorLines) lines.push(`🧭 Reason:\n${errorLines}`);

  const diffLines = formatSchemaDiffs(step.schema_diffs);
  if (diffLines) lines.push(`🧩 Schema changes:\n${diffLines}`);

  const requestBlock = formatJsonBlock(step.request_body);
  if (requestBlock) lines.push(`📤 <b>Request</b>\n${requestBlock}`);

  const responseBlock = formatJsonBlock(step.response_body);
  if (responseBlock) lines.push(`📥 <b>Response</b>\n${responseBlock}`);

  return lines.join('\n');
}

/**
 * Format a detailed alert for a flow run: header (status/flow/env/trigger/
 * time), then a full breakdown of every step that didn't PASS — request,
 * outcome, and the specific reason (assertion failures, schema diffs, or
 * the raw exception for a network-level ERROR).
 */
// Telegram hard-caps messages at 4096 chars — if request/response bodies push
// past that, trim from the end (rather than fail to send) and say so.
const MAX_MESSAGE_LEN = 4000;

function formatFlowAlertMessage(flowRun) {
  const emoji = STATUS_EMOJI[flowRun.status] || 'ℹ️';
  const problemSteps = (flowRun.steps || []).filter((s) => s.status !== 'PASS');
  const totalSteps = (flowRun.steps || []).length;
  const ranAt = flowRun.created_at ? new Date(flowRun.created_at) : new Date();
  const divider = '─'.repeat(24);

  const header = [
    `${emoji} <b>${flowRun.status}</b> — ${escapeHtml(flowRun.flow_name)}`,
    divider,
    `🌐 Environment: <b>${escapeHtml(flowRun.environment_name)}</b>`,
    `👤 Triggered by: ${escapeHtml(flowRun.triggered_by || 'manual')}`,
    `🕒 Time: ${ranAt.toLocaleString()}`,
    `📊 Steps: <b>${problemSteps.length}</b> of ${totalSteps} did not pass`,
  ].join('\n');

  const body = problemSteps.map((s, i) => formatStep(s, i)).join(`\n${divider}\n`);

  const footerParts = [`✅ Run #${flowRun.id}`];
  if (APP_BASE_URL) footerParts.push(`🔗 <a href="${APP_BASE_URL}">Open Dashboard</a>`);

  let message = [header, body, footerParts.join('   ')].filter(Boolean).join('\n\n');
  if (message.length > MAX_MESSAGE_LEN) {
    message = `${message.slice(0, MAX_MESSAGE_LEN)}\n\n✂️ <i>Message truncated — see the Dashboard for full detail.</i>`;
  }
  return message;
}

const BAD_STATUSES = ['FAIL', 'ERROR', 'SCHEMA_DRIFT'];

function formatRecoveryMessage(flowRun, previousStatus) {
  const ranAt = flowRun.created_at ? new Date(flowRun.created_at) : new Date();
  return [
    `✅ <b>RECOVERED</b> — ${escapeHtml(flowRun.flow_name)}`,
    `🌐 Environment: <b>${escapeHtml(flowRun.environment_name)}</b>`,
    `🕒 Time: ${ranAt.toLocaleString()}`,
    `<i>Run #${flowRun.id} passed, after the previous run was ${escapeHtml(previousStatus)}.</i>`,
  ].join('\n');
}

async function sendPdfReport(flowRun) {
  const { buffer, filename } = buildRunResultPdf(flowRun);
  await sendTelegramDocument(buffer, filename, `${flowRun.status}: ${flowRun.flow_name}`);
}

/**
 * Notify about a flow run result. Rules:
 *  - status is bad (FAIL/ERROR/SCHEMA_DRIFT) → always alert, even if the
 *    previous run failed the exact same way — a flaky/still-broken endpoint
 *    should keep reminding whoever's watching, not go quiet after the first
 *    alert.
 *  - status recovered to PASS after a bad previous run → send one recovery
 *    notice, then go quiet again
 *  - PASS following PASS (or no prior run) → nothing to say
 */
async function notifyFlowIfNeeded(flowRun, previousStatus = null) {
  const isBad = BAD_STATUSES.includes(flowRun.status);
  const wasBad = BAD_STATUSES.includes(previousStatus);

  let message;
  if (isBad) {
    message = formatFlowAlertMessage(flowRun);
  } else if (!isBad && wasBad) {
    message = formatRecoveryMessage(flowRun, previousStatus);
  } else {
    return;
  }

  let logStatus = 'sent';
  const settingRow = await pool.query(`SELECT value FROM settings WHERE key='telegram_notifications_enabled'`);
  // Missing row = default (enabled) — see DEFAULTS in routes/settings.js.
  const enabled = settingRow.rows[0] ? settingRow.rows[0].value === true : true;
  if (!enabled) {
    logStatus = 'skipped';
  } else {
    try {
      await sendTelegramMessage(message);
    } catch (err) {
      logStatus = 'failed';
      console.error('[telegramNotifier] failed to send:', err.message);
    }

    // A failed/erroring run also gets its full PDF report attached (to the
    // doc bot/topic, same as a manual "Share to Telegram") — not just the
    // short text alert above. Fired without awaiting it (own try/catch
    // inside) — notifyFlowIfNeeded is itself awaited by the flow-run request
    // (and the scheduler loop), so awaiting a second Telegram round-trip
    // here would add its full network latency to every failing run.
    if (isBad) {
      sendPdfReport(flowRun).catch((err) => {
        console.error('[telegramNotifier] failed to send PDF report:', err.message);
      });
    }
  }

  await pool.query(
    `INSERT INTO notifications_log (flow_run_id, channel, status) VALUES ($1, 'telegram', $2)`,
    [flowRun.id, logStatus]
  );
}

module.exports = { sendTelegramMessage, sendTelegramDocument, notifyFlowIfNeeded, formatFlowAlertMessage };
