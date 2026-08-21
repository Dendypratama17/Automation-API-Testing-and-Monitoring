import { jsPDF } from 'jspdf';
import { buildRepeatBatchRunResultPdf } from './exportRunResultPdf.js';

// A second, k6-reporter-styled report alongside the plain detailed PDF
// (exportRunResultPdf.js's repeat-batch report) — that one is a full
// per-repeat/per-step dump, this one is a visual, at-a-glance summary: pass
// rate per flow as a chart, plus a short written explanation per flow
// (pass ratio, average duration, and what actually went wrong when it
// failed) instead of having to read every repeat's raw steps to see the
// pattern.
const GRADIENTS = {
  header: [[124, 58, 237], [91, 33, 182]], // #7c3aed -> #5b21b6
  primary: [[102, 126, 234], [118, 75, 162]], // #667eea -> #764ba2
  success: [[104, 211, 145], [72, 187, 120]], // #68d391 -> #48bb78
  danger: [[252, 129, 129], [245, 101, 101]], // #fc8181 -> #f56565
  warning: [[246, 173, 85], [237, 137, 54]], // #f6ad55 -> #ed8936
};
const STATUS_COLORS = { PASS: [22, 163, 74], FAIL: [220, 38, 38] };
const INK = [40, 42, 48];
const MUTED = [120, 124, 134];
const BOX_BG = [244, 245, 248];
const BOX_BORDER = [222, 225, 231];
const RULE = [228, 230, 235];
const SECTION_GAP = 26;
const CARD_PADDING = 18;

function slugifyForFilename(name) {
  return (name || '')
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// One row of per-flow stats across every repeat pass — passCount/failCount,
// average total duration (summed across that flow's own steps), and up to 3
// distinct reasons it failed when it did (the first non-PASS step's name +
// status per failing repeat, deduped) — enough to explain "why" without
// dumping every repeat's full step list.
function collectFlowStats(repeatResults) {
  const stats = new Map();
  for (const rr of repeatResults) {
    if (!rr.result) continue;
    for (const r of rr.result.results) {
      const key = r.flow_id;
      if (!stats.has(key)) {
        stats.set(key, { name: r.flow_name || `Flow #${r.flow_id}`, passCount: 0, failCount: 0, durations: [], reasons: new Set() });
      }
      const stat = stats.get(key);
      const isPass = !r.error && r.flow_run?.status === 'PASS';
      if (isPass) stat.passCount += 1; else stat.failCount += 1;
      if (Array.isArray(r.steps) && r.steps.length > 0) {
        stat.durations.push(r.steps.reduce((sum, s) => sum + (s.response_time_ms || 0), 0));
        if (!isPass) {
          const badStep = r.steps.find((s) => s.status !== 'PASS');
          if (badStep) stat.reasons.add(`${badStep.name}: ${badStep.status}`);
        }
      } else if (r.error) {
        stat.reasons.add(r.error);
      }
    }
  }
  return [...stats.values()];
}

// `opts.doc`/`opts.skipFooter`: same reasoning as buildRepeatBatchRunResultPdf
// in exportRunResultPdf.js — lets buildRepeatCombinedPdf below append this
// summary onto a shared document instead of creating its own, so both
// sections land in ONE downloadable file (two doc.save() calls back-to-back
// get the second one silently blocked by the browser).
function buildRepeatSummaryPdf(repeatResults, totalRepeats, opts = {}) {
  const doc = opts.doc || new jsPDF({ unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 46;
  const maxWidth = pageWidth - margin * 2;
  const footerZone = 34;
  const bottomLimit = pageHeight - margin - footerZone;
  let y = margin;

  const ensureSpace = (needed) => {
    if (y + needed > bottomLimit) {
      doc.addPage();
      y = margin;
    }
  };

  const drawGradientRect = (x, top, w, h, [from, to], radius = 0) => {
    const steps = Math.max(12, Math.round(w / 4));
    const stripeW = w / steps;
    if (radius > 0) {
      doc.saveGraphicsState();
      doc.roundedRect(x, top, w, h, radius, radius, null);
      doc.clip();
      doc.discardPath();
    }
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1 || 1);
      const r = Math.round(from[0] + (to[0] - from[0]) * t);
      const g = Math.round(from[1] + (to[1] - from[1]) * t);
      const b = Math.round(from[2] + (to[2] - from[2]) * t);
      doc.setFillColor(r, g, b);
      doc.rect(x + i * stripeW, top, stripeW + 0.75, h, 'F');
    }
    if (radius > 0) doc.restoreGraphicsState();
  };

  const drawBadge = (text, x, top, color) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    const w = doc.getTextWidth(text) + 18;
    const h = 17;
    doc.setFillColor(...color);
    doc.roundedRect(x, top, w, h, 8.5, 8.5, 'F');
    doc.setTextColor(255, 255, 255);
    doc.text(text, x + 9, top + h / 2 + 3);
    return w;
  };

  const drawBarChart = (rows, { x, width, barHeight = 16, gap = 11, labelWidth = 140, valueWidth = 96, maxValue }) => {
    const chartWidth = width - labelWidth - valueWidth;
    const max = maxValue ?? Math.max(...rows.map((r) => r.value), 1);
    rows.forEach((row) => {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9.5);
      doc.setTextColor(...INK);
      const labelLines = doc.splitTextToSize(row.label, labelWidth - 8);
      doc.text(labelLines[0], x, y + barHeight - 4.5);
      doc.setFillColor(...BOX_BORDER);
      doc.roundedRect(x + labelWidth, y, chartWidth, barHeight, 4, 4, 'F');
      const barW = Math.max(4, (row.value / max) * chartWidth);
      doc.setFillColor(...row.color);
      doc.roundedRect(x + labelWidth, y, barW, barHeight, 4, 4, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9.5);
      doc.setTextColor(...INK);
      doc.text(row.valueLabel, x + labelWidth + chartWidth + 10, y + barHeight - 4.5);
      y += barHeight + gap;
    });
  };

  const drawChartCard = (title, rows, opts = {}) => {
    const barHeight = opts.barHeight ?? 16;
    const gap = opts.gap ?? 11;
    const titleBlock = 34;
    const bottomPad = 6;
    const contentHeight = rows.length * (barHeight + gap) - gap;
    const boxHeight = CARD_PADDING * 2 + titleBlock + contentHeight + bottomPad;
    ensureSpace(boxHeight + SECTION_GAP);
    const boxTop = y;
    doc.setFillColor(...BOX_BG);
    doc.setDrawColor(...BOX_BORDER);
    doc.roundedRect(margin, boxTop, maxWidth, boxHeight, 9, 9, 'FD');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(...INK);
    doc.text(title, margin + CARD_PADDING, boxTop + CARD_PADDING + 8);
    y = boxTop + CARD_PADDING + titleBlock;
    drawBarChart(rows, {
      x: margin + CARD_PADDING,
      width: maxWidth - CARD_PADDING * 2,
      barHeight,
      gap,
      labelWidth: opts.labelWidth,
      valueWidth: opts.valueWidth,
      maxValue: opts.maxValue,
    });
    y = boxTop + boxHeight + SECTION_GAP;
  };

  const drawMetricCards = (cards, top, height) => {
    const gap = 16;
    const cardWidth = (maxWidth - gap * (cards.length - 1)) / cards.length;
    cards.forEach((card, i) => {
      const x = margin + i * (cardWidth + gap);
      drawGradientRect(x, top, cardWidth, height, GRADIENTS[card.tone], 10);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(255, 255, 255);
      doc.text(card.label.toUpperCase(), x + 16, top + 24);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(21);
      doc.text(card.value, x + 16, top + 52);
      if (card.subtext) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(255, 255, 255);
        doc.text(card.subtext, x + 16, top + 65);
      }
    });
  };

  const flowStats = collectFlowStats(repeatResults);
  const passedRepeats = repeatResults.filter((rr) => !!rr.result && !rr.error && rr.result.results.every((r) => !r.error && r.flow_run?.status === 'PASS')).length;
  const overallPassed = passedRepeats === repeatResults.length;
  const totalFlowRuns = flowStats.reduce((sum, s) => sum + s.passCount + s.failCount, 0);
  const totalFlowPasses = flowStats.reduce((sum, s) => sum + s.passCount, 0);
  const overallPassRate = totalFlowRuns > 0 ? Math.round((totalFlowPasses / totalFlowRuns) * 100) : 0;

  // ---- Header band (gradient) ----
  const headerHeight = 72;
  drawGradientRect(0, 0, pageWidth, headerHeight, GRADIENTS.header);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(17);
  doc.setTextColor(255, 255, 255);
  doc.text('QA Toolkit', margin, 34);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(230, 224, 250);
  doc.text('Repeated Batch Run Summary', margin, 52);
  const overallBadgeWidth = doc.getTextWidth(overallPassed ? 'ALL PASSED' : 'SOME FAILED') + 18;
  drawBadge(
    overallPassed ? 'ALL PASSED' : 'SOME FAILED',
    pageWidth - margin - overallBadgeWidth,
    headerHeight / 2 - 8,
    overallPassed ? STATUS_COLORS.PASS : STATUS_COLORS.FAIL
  );
  y = headerHeight + SECTION_GAP;

  // ---- Info card ----
  const infoCardHeight = 54;
  ensureSpace(infoCardHeight);
  doc.setFillColor(...BOX_BG);
  doc.setDrawColor(...BOX_BORDER);
  doc.roundedRect(margin, y, maxWidth, infoCardHeight, 9, 9, 'FD');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(...MUTED);
  const flowNames = flowStats.map((s) => s.name).join(', ');
  doc.text(doc.splitTextToSize(`Flows: ${flowNames || '-'}`, maxWidth - CARD_PADDING * 2)[0], margin + CARD_PADDING, y + 24);
  doc.text(new Date().toLocaleString(), pageWidth - margin - CARD_PADDING, y + 24, { align: 'right' });
  y += infoCardHeight + SECTION_GAP;

  // ---- Metric cards ----
  const metricCardHeight = 76;
  ensureSpace(metricCardHeight);
  drawMetricCards([
    { tone: 'primary', label: 'Repeats', value: String(repeatResults.length), subtext: `of ${totalRepeats}x requested` },
    { tone: overallPassed ? 'success' : 'warning', label: 'Fully Passed', value: `${passedRepeats}/${repeatResults.length}` },
    { tone: 'primary', label: 'Flows', value: String(flowStats.length) },
    { tone: overallPassRate === 100 ? 'success' : 'danger', label: 'Pass Rate', value: `${overallPassRate}%` },
  ], y, metricCardHeight);
  y += metricCardHeight + SECTION_GAP;

  // ---- Pass rate per flow (chart) ----
  if (flowStats.length > 0) {
    drawChartCard('Pass Rate per Flow', flowStats.map((s) => {
      const total = s.passCount + s.failCount;
      const rate = total > 0 ? Math.round((s.passCount / total) * 100) : 0;
      return {
        label: s.name,
        value: rate,
        valueLabel: `${s.passCount}/${total} (${rate}%)`,
        color: rate === 100 ? STATUS_COLORS.PASS : (rate === 0 ? STATUS_COLORS.FAIL : [237, 137, 54]),
      };
    }), { maxValue: 100 });
  }

  // ---- Per-flow explanation ----
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12.5);
  doc.setTextColor(...INK);
  ensureSpace(24);
  doc.text('Per-Flow Breakdown', margin, y);
  y += 22;

  flowStats.forEach((s) => {
    const total = s.passCount + s.failCount;
    const rate = total > 0 ? Math.round((s.passCount / total) * 100) : 0;
    const avgDuration = s.durations.length > 0 ? Math.round(s.durations.reduce((a, b) => a + b, 0) / s.durations.length) : null;
    const reasons = [...s.reasons].slice(0, 3);

    const explanation = rate === 100
      ? `Passed in all ${total} run${total === 1 ? '' : 's'}.`
      : rate === 0
        ? `Failed in every one of ${total} run${total === 1 ? '' : 's'}.`
        : `Passed in ${s.passCount} of ${total} runs (${rate}%), failed in ${s.failCount}.`;

    const lines = [explanation];
    if (avgDuration != null) lines.push(`Average duration: ${avgDuration}ms.`);
    if (reasons.length > 0) lines.push(`Failure${reasons.length === 1 ? '' : 's'} seen: ${reasons.join('; ')}.`);

    const textWidth = maxWidth - CARD_PADDING * 2 - 90;
    const wrapped = lines.flatMap((l) => doc.splitTextToSize(l, textWidth));
    const cardHeight = CARD_PADDING * 2 + 20 + wrapped.length * 12.5;
    ensureSpace(cardHeight + 12);
    doc.setFillColor(...BOX_BG);
    doc.setDrawColor(...BOX_BORDER);
    doc.roundedRect(margin, y, maxWidth, cardHeight, 8, 8, 'FD');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.setTextColor(...INK);
    doc.text(s.name, margin + CARD_PADDING, y + CARD_PADDING + 6);
    drawBadge(`${rate}%`, margin + maxWidth - CARD_PADDING - (doc.getTextWidth(`${rate}%`) + 18), y + CARD_PADDING - 4, rate === 100 ? STATUS_COLORS.PASS : (rate === 0 ? STATUS_COLORS.FAIL : [237, 137, 54]));
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(...MUTED);
    let ty = y + CARD_PADDING + 24;
    wrapped.forEach((line) => { doc.text(line, margin + CARD_PADDING, ty); ty += 12.5; });
    y += cardHeight + 12;
  });

  // ---- Footer ----
  if (!opts.skipFooter) {
    const totalPages = doc.internal.getNumberOfPages();
    for (let p = 1; p <= totalPages; p++) {
      doc.setPage(p);
      doc.setDrawColor(...RULE);
      doc.line(margin, pageHeight - footerZone, pageWidth - margin, pageHeight - footerZone);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(...MUTED);
      doc.text('Generated by QA Toolkit', margin, pageHeight - footerZone + 16);
      doc.text(`Page ${p} of ${totalPages}`, pageWidth - margin, pageHeight - footerZone + 16, { align: 'right' });
    }
  }

  const nameSlug = flowStats.map((s) => slugifyForFilename(s.name)).filter(Boolean).join('_').slice(0, 80);
  return { doc, filename: `repeat-summary-${nameSlug ? `${nameSlug}-` : ''}x${repeatResults.length}.pdf` };
}

// Combines this summary report with the detailed per-repeat report
// (exportRunResultPdf.js) into ONE document — summary pages first, then a
// page break into the full detail — so "Download PDF" only ever triggers
// a single browser download instead of two the browser might block one of.
export function buildRepeatCombinedPdf(repeatResults, totalRepeats) {
  const { doc } = buildRepeatSummaryPdf(repeatResults, totalRepeats, { skipFooter: true });
  buildRepeatBatchRunResultPdf(repeatResults, totalRepeats, { doc, skipFooter: true });

  // One footer pass at the end, covering every page from both sections —
  // drawFooter-style loop reads the page count fresh, so it doesn't matter
  // which section added which pages.
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 46;
  const footerZone = 34;
  const totalPages = doc.internal.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setDrawColor(...RULE);
    doc.line(margin, pageHeight - footerZone, pageWidth - margin, pageHeight - footerZone);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text('Generated by QA Toolkit', margin, pageHeight - footerZone + 16);
    doc.text(`Page ${p} of ${totalPages}`, pageWidth - margin, pageHeight - footerZone + 16, { align: 'right' });
  }

  const flowStats = collectFlowStats(repeatResults);
  const nameSlug = flowStats.map((s) => slugifyForFilename(s.name)).filter(Boolean).join('_').slice(0, 80);
  return { doc, filename: `repeat-report-${nameSlug ? `${nameSlug}-` : ''}x${repeatResults.length}.pdf` };
}

export function exportRepeatCombinedToPdf(repeatResults, totalRepeats) {
  const { doc, filename } = buildRepeatCombinedPdf(repeatResults, totalRepeats);
  doc.save(filename);
}

export function getRepeatCombinedPdfBase64(repeatResults, totalRepeats) {
  const { doc, filename } = buildRepeatCombinedPdf(repeatResults, totalRepeats);
  const dataUri = doc.output('datauristring');
  const base64 = dataUri.slice(dataUri.indexOf(',') + 1);
  return { base64, filename };
}

export function exportRepeatSummaryToPdf(repeatResults, totalRepeats) {
  const { doc, filename } = buildRepeatSummaryPdf(repeatResults, totalRepeats);
  doc.save(filename);
}

export function getRepeatSummaryPdfBase64(repeatResults, totalRepeats) {
  const { doc, filename } = buildRepeatSummaryPdf(repeatResults, totalRepeats);
  const dataUri = doc.output('datauristring');
  const base64 = dataUri.slice(dataUri.indexOf(',') + 1);
  return { base64, filename };
}
