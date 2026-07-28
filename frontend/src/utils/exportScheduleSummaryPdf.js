import { jsPDF } from 'jspdf';
import { describeAssertionParts } from './assertionDescriptions.js';

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
 * Renders every run of one schedule into a single PDF — per run, per step:
 * endpoint name, status, and which validations (assertions) ran and whether
 * they passed. Deliberately omits method/url/duration/request id and the
 * request/response bodies (unlike exportRunResultToPdf's single-run report)
 * so a schedule with many runs stays a skimmable summary rather than a dump.
 */
export function exportScheduleSummaryToPdf(schedule, runs) {
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
  doc.text('Schedule Summary Report', margin, 44);
  y = 54 + 24;

  // ---- Summary card ----
  const totalRuns = runs.length;
  const runCounts = runs.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
  const runCountsLine = Object.entries(runCounts).map(([k, v]) => `${v} ${k}`).join('  •  ');

  const summaryHeight = 74;
  ensureSpace(summaryHeight);
  doc.setFillColor(...BOX_BG);
  doc.setDrawColor(...BOX_BORDER);
  doc.roundedRect(margin, y, maxWidth, summaryHeight, 6, 6, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(...INK);
  doc.text(schedule.name || 'Schedule', margin + 14, y + 24);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  doc.text(`Flow: ${schedule.flow_name || '-'}   •   Env: ${schedule.environment_name || '-'}`, margin + 14, y + 42);
  doc.text(`${totalRuns} run${totalRuns === 1 ? '' : 's'}`, margin + 14, y + 62);
  doc.text(runCountsLine || 'No runs', pageWidth - margin - 14, y + 62, { align: 'right' });
  y += summaryHeight + 22;

  // ---- Runs ----
  runs.forEach((run, runIdx) => {
    ensureSpace(30);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.setTextColor(...INK);
    doc.text(`Run #${run.id}`, margin, y);
    drawBadge(run.status, margin + doc.getTextWidth(`Run #${run.id}`) + 10, y - 11, statusColor(run.status));
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...MUTED);
    doc.text(new Date(run.created_at).toLocaleString(), pageWidth - margin, y, { align: 'right' });
    y += 20;

    const steps = run.steps || [];
    if (steps.length === 0) {
      addText('No step detail available for this run.', { size: 9, color: MUTED, indent: 14 });
    }

    steps.forEach((step, idx) => {
      ensureSpace(30);
      doc.setFillColor(...statusColor(step.status));
      doc.circle(margin + 8 + 14, y - 3, 8, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(255, 255, 255);
      doc.text(String(idx + 1), margin + 8 + 14, y, { align: 'center' });

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(...INK);
      doc.text(step.name, margin + 32, y);
      drawBadge(step.status, margin + 32 + doc.getTextWidth(step.name) + 10, y - 10, statusColor(step.status));
      y += 16;

      if (Array.isArray(step.assertion_results) && step.assertion_results.length > 0) {
        for (const a of step.assertion_results) {
          const parts = describeAssertionParts(a);
          ensureSpace(13);
          drawStatusDot(margin + 42, y - 3, a.passed);
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(8.5);
          doc.setTextColor(...INK);
          const text = `${parts.label} ${parts.value}`.trim();
          const lines = doc.splitTextToSize(text, maxWidth - 54);
          doc.text(lines[0], margin + 52, y);
          y += 12.5;
          for (let li = 1; li < lines.length; li++) {
            ensureSpace(12.5);
            doc.text(lines[li], margin + 52, y);
            y += 12.5;
          }
        }
      } else {
        addText('No validations recorded for this step.', { size: 8.5, color: MUTED, indent: 32, lineGap: 12.5 });
      }
      y += 6;
    });

    if (runIdx < runs.length - 1) {
      ensureSpace(20);
      y += 6;
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

  doc.save(`schedule-${schedule.id}-summary.pdf`);
}
