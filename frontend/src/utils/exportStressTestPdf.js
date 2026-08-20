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
// A generous, consistent unit for section-to-section breathing room — every
// gap between major blocks below is a multiple of this instead of one-off
// numbers, so the page doesn't end up with everything jammed together.
const SECTION_GAP = 26;
const CARD_PADDING = 18;

// `context` is { endpoint, environment, credentialName, config: {total_requests,
// concurrency}, result } — result is exactly what POST /stress-test returns.
function buildStressTestPdf(context) {
  const { endpoint, environment, credentialName, config, result } = context;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
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
    const w = doc.getTextWidth(text) + 18;
    const h = 17;
    doc.setFillColor(...color);
    doc.roundedRect(x, top, w, h, 8.5, 8.5, 'F');
    doc.setTextColor(255, 255, 255);
    doc.text(text, x + 9, top + h / 2 + 3);
    return w;
  };

  // A labelled horizontal bar chart, drawn inset within a card of its own
  // (`x`/`width` are the card's own inner content area, not the full page
  // margin) — `rows` is [{ label, value, valueLabel, color }]. Bar length is
  // proportional to `value` against the largest one in the set (or
  // `maxValue`, e.g. total_requests, so a status code's bar reads as its
  // share of the whole run rather than just relative to the other codes).
  const drawBarChart = (rows, { x, width, barHeight = 16, gap = 11, labelWidth = 92, valueWidth = 96, maxValue }) => {
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

  // A titled, padded card wrapping a bar chart — height is precomputed from
  // the row count so the background box and its rounded corners are drawn
  // correctly in one shot before the chart itself renders on top of it.
  const drawChartCard = (title, rows, opts = {}) => {
    const barHeight = opts.barHeight ?? 16;
    const gap = opts.gap ?? 11;
    const titleBlock = 34;
    const bottomPad = 6; // absorbs the last row's trailing gap
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

  // One k6-reporter-style "metric card" — a gradient-filled rounded box with
  // a big bold number and an uppercase label, in a row of `count` cards.
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
  doc.text('Stress Test Report', margin, 52);
  const overallPassed = result.fail_count === 0;
  const overallBadgeWidth = doc.getTextWidth(overallPassed ? 'ALL PASSED' : 'SOME FAILED') + 18;
  drawBadge(
    overallPassed ? 'ALL PASSED' : 'SOME FAILED',
    pageWidth - margin - overallBadgeWidth,
    headerHeight / 2 - 8,
    overallPassed ? STATUS_COLORS.PASS : STATUS_COLORS.FAIL
  );
  y = headerHeight + SECTION_GAP;

  // ---- Endpoint / config card ----
  const infoCardHeight = 70;
  ensureSpace(infoCardHeight);
  doc.setFillColor(...BOX_BG);
  doc.setDrawColor(...BOX_BORDER);
  doc.roundedRect(margin, y, maxWidth, infoCardHeight, 9, 9, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(...INK);
  doc.text(`${endpoint.method} ${endpoint.name}`, margin + CARD_PADDING, y + 27);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(...MUTED);
  doc.text(`Environment: ${environment.name}  •  Credential: ${credentialName || 'None'}`, margin + CARD_PADDING, y + 49);
  doc.text(`${config.total_requests} requests  •  ${config.concurrency} concurrency`, pageWidth - margin - CARD_PADDING, y + 27, { align: 'right' });
  doc.text(new Date().toLocaleString(), pageWidth - margin - CARD_PADDING, y + 49, { align: 'right' });
  y += infoCardHeight + SECTION_GAP;

  // ---- Metric cards ----
  const metricCardHeight = 76;
  ensureSpace(metricCardHeight);
  drawMetricCards([
    { tone: 'primary', label: 'Total Requests', value: String(result.total_requests) },
    { tone: 'success', label: 'Passed', value: String(result.pass_count) },
    { tone: result.fail_count > 0 ? 'danger' : 'success', label: 'Failed', value: String(result.fail_count) },
    { tone: 'warning', label: 'Throughput', value: `${result.requests_per_sec}`, subtext: 'req/sec' },
  ], y, metricCardHeight);
  y += metricCardHeight + SECTION_GAP;

  // ---- Latency breakdown ----
  drawChartCard('Latency Breakdown', [
    { label: 'Min', value: result.min_ms, valueLabel: `${result.min_ms}ms`, color: [109, 106, 246] },
    { label: 'Avg', value: result.avg_ms, valueLabel: `${result.avg_ms}ms`, color: [130, 128, 248] },
    { label: 'p95', value: result.p95_ms, valueLabel: `${result.p95_ms}ms`, color: [154, 152, 250] },
    { label: 'Max', value: result.max_ms, valueLabel: `${result.max_ms}ms`, color: [178, 176, 252] },
  ]);

  // ---- Status codes ----
  const codes = Object.entries(result.status_counts);
  drawChartCard(
    'Status Codes',
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
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...INK);
    ensureSpace(20);
    doc.text('Sample Errors', margin, y);
    y += 20;
    for (const msg of result.error_samples) {
      const lines = doc.splitTextToSize(msg, maxWidth - CARD_PADDING * 2);
      const boxHeight = lines.length * 12 + CARD_PADDING * 2 - 6;
      ensureSpace(boxHeight + 12);
      doc.setFillColor(...BOX_BG);
      doc.setDrawColor(...BOX_BORDER);
      doc.roundedRect(margin, y, maxWidth, boxHeight, 6, 6, 'FD');
      doc.setFont('courier', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(60, 62, 68);
      let ty = y + CARD_PADDING - 2;
      for (const line of lines) {
        doc.text(line, margin + CARD_PADDING, ty);
        ty += 12;
      }
      y += boxHeight + 12;
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
    doc.text('Generated by QA Toolkit', margin, pageHeight - footerZone + 16);
    doc.text(`Page ${p} of ${totalPages}`, pageWidth - margin, pageHeight - footerZone + 16, { align: 'right' });
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
