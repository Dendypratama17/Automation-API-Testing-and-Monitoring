import { jsPDF } from 'jspdf';
import { describeAssertionParts } from './assertionDescriptions.js';

// A base64 file blob would dump megabytes of unreadable text into the PDF —
// same idea as the backend's sanitizeBodyForStorage / the JSON-tab preview.
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
 * Renders a flow run result (steps, assertions, extracted variables, request
 * / response bodies) into a styled, multi-page PDF report and triggers a
 * browser download. Built from structured data (not a DOM screenshot) so
 * pagination and text wrapping stay clean regardless of how long the JSON
 * bodies are.
 */
export function exportRunResultToPdf(runResult) {
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

  // Small filled circle with a hand-drawn check/x mark — avoids relying on
  // unicode glyphs, which the standard PDF fonts don't reliably render.
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

  // Rounded, filled pill with white bold text — used for step/flow status.
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

  // A labelled, shaded monospace box — paginates itself by drawing a fresh
  // box on the next page if the content doesn't fit in what's left of the
  // current one, instead of assuming it always fits in one piece.
  const drawCodeBlock = (label, text) => {
    addText(label, { size: 9.5, style: 'bold', color: MUTED, gapBefore: 10 });
    const innerWidth = maxWidth - 16;
    const lineGap = 10.5;
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
  const flowRun = runResult.flow_run;
  const counts = runResult.steps.reduce((acc, s) => { acc[s.status] = (acc[s.status] || 0) + 1; return acc; }, {});
  const countsLine = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join('  •  ');

  const summaryHeight = 74;
  ensureSpace(summaryHeight);
  doc.setFillColor(...BOX_BG);
  doc.setDrawColor(...BOX_BORDER);
  doc.roundedRect(margin, y, maxWidth, summaryHeight, 6, 6, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(...INK);
  doc.text(runResult.flow_name || 'Flow', margin + 14, y + 24);
  drawBadge(flowRun.status, margin + 14, y + 34, statusColor(flowRun.status));
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  doc.text(`Run #${flowRun.id}  •  ${new Date(flowRun.created_at).toLocaleString()}`, margin + 14, y + 62);
  doc.text(countsLine || 'No steps', pageWidth - margin - 14, y + 62, { align: 'right' });
  y += summaryHeight + 22;

  // ---- Steps ----
  runResult.steps.forEach((step, idx) => {
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

    if (step.request_body != null) drawCodeBlock('Request Body', JSON.stringify(sanitizeBody(step.request_body), null, 2));
    if (step.response_body != null) drawCodeBlock('Response Body', JSON.stringify(sanitizeBody(step.response_body), null, 2));

    if (idx < runResult.steps.length - 1) {
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

  doc.save(`flow-run-${flowRun.id}.pdf`);
}
