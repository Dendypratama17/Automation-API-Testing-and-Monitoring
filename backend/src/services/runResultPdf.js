const { jsPDF } = require('jspdf');
const { describeAssertionParts } = require('./assertionDescriptions');

// Backend port of frontend/src/utils/exportRunResultPdf.js's buildRunResultPdf
// — same visual report, generated server-side (no browser/DOM available)
// so it can be attached to the automatic Telegram alert on a failed run,
// not just the manual "Share to Telegram" click from the browser. Kept in
// sync by hand; a change to one report's look should mirror in the other.

// Filesystem-safe stand-in for the flow's name — mirrors the frontend copy
// in exportRunResultPdf.js, so a downloaded/shared file reads with the
// flow's name in it instead of just the bare run id.
function slugifyForFilename(name) {
  return (name || '')
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function sanitizeBody(body) {
  if (Array.isArray(body)) return body.map(sanitizeBody);
  if (body && typeof body === 'object') {
    if (body.__file__) {
      const bytes = body.data ? Math.round((body.data.length * 3) / 4) : 0;
      return { __file__: true, name: body.name, mimeType: body.mimeType, data: `<${bytes} bytes omitted>` };
    }
    const out = {};
    for (const [k, v] of Object.entries(body)) out[k] = sanitizeBody(v);
    return out;
  }
  return body;
}

// Backend port of frontend/src/utils/tupleBodyDisplay.js — same reasoning:
// a form-data body is an array of [key, value] tuples (see
// FormDataEditor.jsx's formRowsToBody), and plain JSON.stringify renders
// that as literal nested arrays instead of the compact object-like text the
// in-app viewer (JsonBlock.jsx) shows. Kept in sync by hand, same as the
// rest of this file's relationship to exportRunResultPdf.js.
function containsFileMarker(value) {
  if (Array.isArray(value)) return value.some(containsFileMarker);
  if (value && typeof value === 'object') {
    if (value.__file__ || value.__file_url__) return true;
    return Object.values(value).some(containsFileMarker);
  }
  return false;
}

function isTupleShaped(value) {
  return Array.isArray(value) && value.length > 0
    && value.every((el) => Array.isArray(el) && el.length === 2 && typeof el[0] === 'string');
}

function isTupleArray(value, loose) {
  if (!isTupleShaped(value)) return false;
  return loose || value.some(([, v]) => containsFileMarker(v));
}

function stringifyBodyForDisplay(value, indent = 0, loose = false) {
  const pad = '  '.repeat(indent);
  const childPad = '  '.repeat(indent + 1);
  if (isTupleArray(value, loose)) {
    const lines = value.map(([k, v]) => `${childPad}${JSON.stringify(k)}: ${stringifyBodyForDisplay(v, indent + 1, loose)}`);
    return `{\n${lines.join(',\n')}\n${pad}}`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const lines = value.map((v) => `${childPad}${stringifyBodyForDisplay(v, indent + 1, loose)}`);
    return `[\n${lines.join(',\n')}\n${pad}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    const lines = keys.map((k) => `${childPad}${JSON.stringify(k)}: ${stringifyBodyForDisplay(value[k], indent + 1, loose)}`);
    return `{\n${lines.join(',\n')}\n${pad}}`;
  }
  return JSON.stringify(value);
}

const STATUS_COLORS = {
  PASS: [22, 163, 74],
  FAIL: [220, 38, 38],
  ERROR: [147, 51, 234],
  SCHEMA_DRIFT: [217, 119, 6],
};
const statusColor = (s) => STATUS_COLORS[s] || [110, 110, 110];

const INK = [40, 42, 48];
const MUTED = [120, 124, 134];
const BOX_BG = [244, 245, 248];
const BOX_BORDER = [222, 225, 231];
const RULE = [228, 230, 235];

/**
 * Renders a flow run (steps, assertions, extracted variables, request /
 * response bodies) into a styled, multi-page PDF report. `flowRun` is the
 * flat shape already used by notifyFlowIfNeeded: { id, status, created_at,
 * flow_name, environment_name, steps }. Returns { buffer, filename } — a
 * plain Node Buffer, ready for sendTelegramDocument.
 */
function buildRunResultPdf(flowRun) {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 40;
  const maxWidth = pageWidth - margin * 2;
  const footerZone = 30;
  const bottomLimit = pageHeight - margin - footerZone;
  let y = margin;

  const ensureSpace = (needed) => {
    if (y + needed > bottomLimit) {
      doc.addPage();
      y = margin;
    }
  };

  const addText = (text, { size = 10, font = 'helvetica', style = 'normal', color = INK, lineGap = 13, gapBefore = 0, indent = 0 } = {}) => {
    if (gapBefore) y += gapBefore;
    doc.setFont(font, style);
    doc.setFontSize(size);
    doc.setTextColor(...color);
    const lines = doc.splitTextToSize(String(text), maxWidth - indent);
    for (const line of lines) {
      ensureSpace(lineGap);
      doc.text(line, margin + indent, y);
      y += lineGap;
    }
  };

  const drawStatusDot = (cx, cy, passed) => {
    doc.setFillColor(...(passed ? STATUS_COLORS.PASS : STATUS_COLORS.FAIL));
    doc.circle(cx, cy, 4.5, 'F');
    doc.setDrawColor(255, 255, 255);
    doc.setLineWidth(1);
    if (passed) {
      doc.line(cx - 2, cy, cx - 0.5, cy + 1.8);
      doc.line(cx - 0.5, cy + 1.8, cx + 2.3, cy - 2.2);
    } else {
      doc.line(cx - 1.8, cy - 1.8, cx + 1.8, cy + 1.8);
      doc.line(cx - 1.8, cy + 1.8, cx + 1.8, cy - 1.8);
    }
  };

  const drawBadge = (text, x, top, color) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    const w = doc.getTextWidth(text) + 16;
    const h = 15;
    doc.setFillColor(...color);
    doc.roundedRect(x, top, w, h, 7, 7, 'F');
    doc.setTextColor(255, 255, 255);
    doc.text(text, x + 8, top + h / 2 + 3);
    return w;
  };

  const drawCodeBlock = (label, text) => {
    addText(label, { size: 9.5, style: 'bold', color: MUTED, gapBefore: 10 });
    const innerWidth = maxWidth - 16;
    const lineGap = 10.5;
    doc.setFont('courier', 'normal');
    doc.setFontSize(8);
    const lines = doc.splitTextToSize(text, innerWidth);
    let i = 0;
    while (i < lines.length) {
      const available = bottomLimit - y;
      const linesThatFit = Math.max(1, Math.floor((available - 16) / lineGap));
      if (available < lineGap + 16) {
        doc.addPage();
        y = margin;
        continue;
      }
      const chunk = lines.slice(i, i + linesThatFit);
      const boxHeight = chunk.length * lineGap + 16;
      doc.setFillColor(...BOX_BG);
      doc.setDrawColor(...BOX_BORDER);
      doc.roundedRect(margin, y, maxWidth, boxHeight, 4, 4, 'FD');
      doc.setFont('courier', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(60, 62, 68);
      let ty = y + 12;
      for (const line of chunk) {
        doc.text(line, margin + 8, ty);
        ty += lineGap;
      }
      y += boxHeight + 10;
      i += linesThatFit;
    }
  };

  // ---- Header band (first page only) ----
  doc.setFillColor(10, 12, 17);
  doc.rect(0, 0, pageWidth, 54, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(255, 255, 255);
  doc.text('QA Toolkit', margin, 30);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(180, 184, 196);
  doc.text('Flow Run Report', margin, 44);
  y = 54 + 24;

  // ---- Summary card ----
  const steps = flowRun.steps || [];
  const counts = steps.reduce((acc, s) => { acc[s.status] = (acc[s.status] || 0) + 1; return acc; }, {});
  const countsLine = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join('  •  ');

  const summaryHeight = 74;
  ensureSpace(summaryHeight);
  doc.setFillColor(...BOX_BG);
  doc.setDrawColor(...BOX_BORDER);
  doc.roundedRect(margin, y, maxWidth, summaryHeight, 6, 6, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(...INK);
  doc.text(flowRun.flow_name || 'Flow', margin + 14, y + 24);
  drawBadge(flowRun.status, margin + 14, y + 34, statusColor(flowRun.status));
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  doc.text(`Run #${flowRun.id}  •  ${new Date(flowRun.created_at).toLocaleString()}`, margin + 14, y + 62);
  doc.text(countsLine || 'No steps', pageWidth - margin - 14, y + 62, { align: 'right' });
  y += summaryHeight + 22;

  // ---- Steps ----
  steps.forEach((step, idx) => {
    ensureSpace(46);

    doc.setFillColor(...statusColor(step.status));
    doc.circle(margin + 8, y - 3, 9, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(255, 255, 255);
    doc.text(String(idx + 1), margin + 8, y, { align: 'center' });

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12.5);
    doc.setTextColor(...INK);
    doc.text(step.name, margin + 22, y);
    drawBadge(step.status, margin + 22 + doc.getTextWidth(step.name) + 10, y - 11, statusColor(step.status));
    y += 18;

    addText(`${step.request_method}  ${step.request_url}`, { size: 9, font: 'courier', color: MUTED, indent: 22 });
    addText(
      `Status: ${step.response_status_code ?? '-'}   Duration: ${step.response_time_ms}ms   Request ID: ${step.request_id || '-'}`,
      { size: 8.5, color: MUTED, indent: 22 }
    );

    if (Array.isArray(step.assertion_results) && step.assertion_results.length > 0) {
      addText('Assertions', { size: 9.5, style: 'bold', color: MUTED, gapBefore: 8, indent: 22 });
      for (const a of step.assertion_results) {
        const parts = describeAssertionParts(a);
        ensureSpace(14);
        drawStatusDot(margin + 27, y - 3, a.passed);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(...INK);
        const text = `${parts.label} ${parts.value}`.trim();
        const lines = doc.splitTextToSize(text, maxWidth - 40);
        doc.text(lines[0], margin + 38, y);
        y += 13;
        for (let li = 1; li < lines.length; li++) {
          ensureSpace(13);
          doc.text(lines[li], margin + 38, y);
          y += 13;
        }
      }
    }

    const extracted = step.extracted_variables || {};
    if (Object.keys(extracted).length > 0) {
      addText('Extracted Variables', { size: 9.5, style: 'bold', color: MUTED, gapBefore: 8, indent: 22 });
      for (const [key, value] of Object.entries(extracted)) {
        addText(`${key} = ${value}`, { size: 8.5, font: 'courier', indent: 22 });
      }
    }

    if (step.request_body != null) drawCodeBlock('Request Body', stringifyBodyForDisplay(sanitizeBody(step.request_body), 0, true));
    if (step.response_body != null) drawCodeBlock('Response Body', stringifyBodyForDisplay(sanitizeBody(step.response_body), 0, false));

    if (idx < steps.length - 1) {
      ensureSpace(20);
      y += 8;
      doc.setDrawColor(...RULE);
      doc.line(margin, y, pageWidth - margin, y);
      y += 18;
    }
  });

  // ---- Footer (page numbers, every page) ----
  const totalPages = doc.internal.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setDrawColor(...RULE);
    doc.line(margin, pageHeight - footerZone, pageWidth - margin, pageHeight - footerZone);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text('Generated by QA Toolkit', margin, pageHeight - footerZone + 12);
    doc.text(`Page ${p} of ${totalPages}`, pageWidth - margin, pageHeight - footerZone + 12, { align: 'right' });
  }

  const buffer = Buffer.from(doc.output('arraybuffer'));
  const nameSlug = slugifyForFilename(flowRun.flow_name);
  return { buffer, filename: `flow-run-${nameSlug ? `${nameSlug}-` : ''}${flowRun.id}.pdf` };
}

module.exports = { buildRunResultPdf };
