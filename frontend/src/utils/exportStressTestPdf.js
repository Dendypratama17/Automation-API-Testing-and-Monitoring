import { jsPDF } from 'jspdf';

// Colors lifted straight from the k6-reporter dashboard style (purple
// gradient header, colored metric cards) — this is a static PDF page, not an
// interactive HTML report, so gradients are simulated with thin vertical
// stripes rather than a CSS linear-gradient.
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

// `context` is { endpoint, environment, credentialName, config: {total_requests,
// concurrency}, result } — result is exactly what POST /stress-test returns.
function buildStressTestPdf(context) {
  const { endpoint, environment, credentialName, config, result } = context;
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

  // Simulates a CSS-style linear-gradient fill with N thin vertical stripes,
  // interpolating between the two colors left to right — jsPDF has no native
  // gradient fill, so this is the standard workaround.
  const drawGradientRect = (x, top, w, h, [from, to], radius = 0) => {
    const steps = Math.max(12, Math.round(w / 4));
    const stripeW = w / steps;
    if (radius > 0) {
      // Clip to a rounded-rect shape first so the stripes don't spill past
      // rounded corners, then paint stripes inside it.
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
    const w = doc.getTextWidth(text) + 16;
    const h = 15;
    doc.setFillColor(...color);
    doc.roundedRect(x, top, w, h, 7, 7, 'F');
    doc.setTextColor(255, 255, 255);
    doc.text(text, x + 8, top + h / 2 + 3);
    return w;
  };

  // A labelled horizontal bar chart — `rows` is [{ label, value, valueLabel,
  // color }]. Bar length is proportional to `value` against the largest one
  // in the set (or `maxValue` if given, e.g. total_requests so a status
  // code's bar reads as its share of the whole run, not just relative to
  // the other codes).
  const drawBarChart = (rows, { barHeight = 14, gap = 8, labelWidth = 90, valueWidth = 90, maxValue } = {}) => {
    const chartWidth = maxWidth - labelWidth - valueWidth;
    const max = maxValue ?? Math.max(...rows.map((r) => r.value), 1);
    rows.forEach((row) => {
      ensureSpace(barHeight + gap);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(...INK);
      const labelLines = doc.splitTextToSize(row.label, labelWidth - 8);
      doc.text(labelLines[0], margin, y + barHeight - 4);
      doc.setFillColor(...BOX_BORDER);
      doc.roundedRect(margin + labelWidth, y, chartWidth, barHeight, 3, 3, 'F');
      const barW = Math.max(3, (row.value / max) * chartWidth);
      doc.setFillColor(...row.color);
      doc.roundedRect(margin + labelWidth, y, barW, barHeight, 3, 3, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(...INK);
      doc.text(row.valueLabel, margin + labelWidth + chartWidth + 8, y + barHeight - 4);
      y += barHeight + gap;
    });
  };

  // One k6-reporter-style "metric card" — a gradient-filled rounded box with
  // a big bold number and an uppercase label, in a row of `count` cards.
  const drawMetricCards = (cards, top, height = 64) => {
    const gap = 12;
    const cardWidth = (maxWidth - gap * (cards.length - 1)) / cards.length;
    cards.forEach((card, i) => {
      const x = margin + i * (cardWidth + gap);
      drawGradientRect(x, top, cardWidth, height, GRADIENTS[card.tone], 8);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(255, 255, 255);
      doc.text(card.label.toUpperCase(), x + 12, top + 20);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(19);
      doc.text(card.value, x + 12, top + 44);
      if (card.subtext) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.5);
        doc.setTextColor(255, 255, 255);
        doc.text(card.subtext, x + 12, top + 56);
      }
    });
    return height;
  };

  // ---- Header band (gradient) ----
  drawGradientRect(0, 0, pageWidth, 58, GRADIENTS.header);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(255, 255, 255);
  doc.text('QA Toolkit', margin, 32);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(230, 224, 250);
  doc.text('Stress Test Report', margin, 47);
  y = 58 + 20;

  // ---- Endpoint / config line ----
  ensureSpace(56);
  doc.setFillColor(...BOX_BG);
  doc.setDrawColor(...BOX_BORDER);
  doc.roundedRect(margin, y, maxWidth, 56, 6, 6, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(...INK);
  doc.text(`${endpoint.method} ${endpoint.name}`, margin + 14, y + 22);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  doc.text(`Environment: ${environment.name}  •  Credential: ${credentialName || 'None'}`, margin + 14, y + 40);
  doc.text(`${config.total_requests} requests  •  ${config.concurrency} concurrency`, pageWidth - margin - 14, y + 22, { align: 'right' });
  doc.text(new Date().toLocaleString(), pageWidth - margin - 14, y + 40, { align: 'right' });
  y += 56 + 20;

  // ---- Metric cards ----
  ensureSpace(64);
  drawMetricCards([
    { tone: 'primary', label: 'Total Requests', value: String(result.total_requests) },
    { tone: 'success', label: 'Passed', value: String(result.pass_count) },
    { tone: result.fail_count > 0 ? 'danger' : 'success', label: 'Failed', value: String(result.fail_count) },
    { tone: 'warning', label: 'Throughput', value: `${result.requests_per_sec}`, subtext: 'req/sec' },
  ], y);
  y += 64 + 24;

  // ---- Latency breakdown chart ----
  addText('Latency Breakdown', { size: 11, style: 'bold', color: INK });
  y += 6;
  drawBarChart([
    { label: 'Min', value: result.min_ms, valueLabel: `${result.min_ms}ms`, color: [109, 106, 246] },
    { label: 'Avg', value: result.avg_ms, valueLabel: `${result.avg_ms}ms`, color: [130, 128, 248] },
    { label: 'p95', value: result.p95_ms, valueLabel: `${result.p95_ms}ms`, color: [154, 152, 250] },
    { label: 'Max', value: result.max_ms, valueLabel: `${result.max_ms}ms`, color: [178, 176, 252] },
  ]);

  // ---- Status codes chart ----
  const codes = Object.entries(result.status_counts);
  ensureSpace(50);
  addText('Status Codes', { size: 11, style: 'bold', color: INK, gapBefore: 16 });
  y += 6;
  drawBarChart(
    codes.map(([code, count]) => ({
      label: code,
      value: count,
      valueLabel: `${count} request${count === 1 ? '' : 's'}`,
      color: (code === 'ERROR' || Number(code) >= 400) ? STATUS_COLORS.FAIL : STATUS_COLORS.PASS,
    })),
    { maxValue: result.total_requests }
  );

  // ---- Error samples ----
  if (result.error_samples && result.error_samples.length > 0) {
    addText('Sample Errors', { size: 9.5, style: 'bold', color: MUTED, gapBefore: 10 });
    for (const msg of result.error_samples) {
      ensureSpace(20);
      const lines = doc.splitTextToSize(msg, maxWidth - 16);
      const boxHeight = lines.length * 11 + 10;
      doc.setFillColor(...BOX_BG);
      doc.setDrawColor(...BOX_BORDER);
      doc.roundedRect(margin, y, maxWidth, boxHeight, 4, 4, 'FD');
      doc.setFont('courier', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(60, 62, 68);
      let ty = y + 10;
      for (const line of lines) {
        doc.text(line, margin + 8, ty);
        ty += 11;
      }
      y += boxHeight + 8;
    }
  }

  // ---- Footer ----
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

  return { doc, filename: `stress-test-${endpoint.id}-${Date.now()}.pdf` };
}

export function exportStressTestToPdf(context) {
  const { doc, filename } = buildStressTestPdf(context);
  doc.save(filename);
}

export function getStressTestPdfBase64(context) {
  const { doc, filename } = buildStressTestPdf(context);
  const dataUri = doc.output('datauristring');
  const base64 = dataUri.slice(dataUri.indexOf(',') + 1);
  return { base64, filename };
}
