import { jsPDF } from 'jspdf';

const STATUS_COLORS = {
  PASS: [22, 163, 74],
  FAIL: [220, 38, 38],
};
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

  // ---- Header band ----
  doc.setFillColor(10, 12, 17);
  doc.rect(0, 0, pageWidth, 54, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(255, 255, 255);
  doc.text('QA Toolkit', margin, 30);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(180, 184, 196);
  doc.text('Stress Test Report', margin, 44);
  y = 54 + 24;

  // ---- Summary card ----
  const overallPassed = result.fail_count === 0;
  const summaryHeight = 92;
  ensureSpace(summaryHeight);
  doc.setFillColor(...BOX_BG);
  doc.setDrawColor(...BOX_BORDER);
  doc.roundedRect(margin, y, maxWidth, summaryHeight, 6, 6, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(...INK);
  doc.text(`${endpoint.method} ${endpoint.name}`, margin + 14, y + 24);
  drawBadge(overallPassed ? 'ALL PASSED' : 'SOME FAILED', margin + 14, y + 34, overallPassed ? STATUS_COLORS.PASS : STATUS_COLORS.FAIL);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  doc.text(`Environment: ${environment.name}`, margin + 14, y + 62);
  doc.text(`Credential: ${credentialName || 'None'}`, margin + 14, y + 76);
  doc.text(`${config.total_requests} requests  •  ${config.concurrency} concurrency`, pageWidth - margin - 14, y + 62, { align: 'right' });
  doc.text(new Date().toLocaleString(), pageWidth - margin - 14, y + 76, { align: 'right' });
  y += summaryHeight + 22;

  // ---- Result metrics ----
  addText('Results', { size: 11, style: 'bold', color: INK });
  y += 4;
  const metrics = [
    [`${result.pass_count} / ${result.total_requests}`, 'Passed'],
    [`${result.avg_ms}ms`, 'Avg Latency'],
    [`${result.min_ms}ms`, 'Min'],
    [`${result.max_ms}ms`, 'Max'],
    [`${result.p95_ms}ms`, 'p95'],
    [`${result.requests_per_sec}`, 'Req/sec'],
  ];
  const colWidth = maxWidth / metrics.length;
  ensureSpace(50);
  const metricsTop = y;
  metrics.forEach(([value, label], i) => {
    const x = margin + i * colWidth;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    doc.setTextColor(...INK);
    doc.text(value, x, metricsTop + 20);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(...MUTED);
    doc.text(label, x, metricsTop + 34);
  });
  y = metricsTop + 50;

  // ---- Status codes ----
  ensureSpace(30);
  addText('Status Codes', { size: 9.5, style: 'bold', color: MUTED, gapBefore: 10 });
  const codes = Object.entries(result.status_counts);
  for (const [code, count] of codes) {
    ensureSpace(14);
    const isError = code === 'ERROR' || Number(code) >= 400;
    doc.setFillColor(...(isError ? STATUS_COLORS.FAIL : STATUS_COLORS.PASS));
    doc.circle(margin + 4, y - 3, 3.5, 'F');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(...INK);
    doc.text(`${code}: ${count} request${count === 1 ? '' : 's'}`, margin + 14, y);
    y += 14;
  }

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
