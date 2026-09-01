import { jsPDF } from 'jspdf';

const INK = [40, 42, 48];
const MUTED = [120, 124, 134];
const BOX_BG = [244, 245, 248];
const BOX_BORDER = [222, 225, 231];
const RULE = [228, 230, 235];
const OLD_BG = [253, 226, 226];
const OLD_TEXT = [153, 27, 27];
const NEW_BG = [220, 252, 231];
const NEW_TEXT = [22, 101, 52];

function formatValue(value) {
  if (value === undefined) return '(missing)';
  if (typeof value === 'string') return `"${value}"`;
  return JSON.stringify(value);
}

// Filesystem-safe stand-in for the comparison's name (if it has one) — so a
// downloaded file reads as e.g. "json-diff-Billings-detail-18.pdf" instead of
// just the id, without risking path-breaking characters from a freeform name.
function slugifyForFilename(name) {
  return name
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Renders a saved JSON Diff comparison (name, saved date, ignored fields,
 * and the flat list of {path, old_value, new_value} diffs) into a styled,
 * multi-page PDF — same jsPDF-from-structured-data approach as
 * exportRunResultToPdf.js, not a DOM screenshot. Returns the built jsPDF
 * instance plus a filesystem-safe filename, shared by both the "download"
 * and "share to Telegram" entry points below so the PDF-building logic
 * itself only lives in one place.
 *
 * `includeDiff: false` skips the diff summary/list entirely and keeps just
 * JSON A/B themselves — for when the two payloads are wanted as a plain
 * reference (e.g. for notes) rather than as a comparison result.
 */
function buildJsonDiffPdf(saved, { includeDiff = true } = {}) {
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

  // A shaded, colored strip of monospace text (one prefixed old/new value) —
  // paginates itself if it doesn't fit in what's left of the current page.
  const drawValueStrip = (prefix, text, bg, textColor) => {
    const innerWidth = maxWidth - 24;
    const lineGap = 10.5;
    doc.setFont('courier', 'normal');
    doc.setFontSize(8);
    const wrapped = doc.splitTextToSize(`${prefix} ${text}`, innerWidth);
    let i = 0;
    while (i < wrapped.length) {
      const available = bottomLimit - y;
      const linesThatFit = Math.max(1, Math.floor((available - 12) / lineGap));
      if (available < lineGap + 12) {
        doc.addPage();
        y = margin;
        continue;
      }
      const chunk = wrapped.slice(i, i + linesThatFit);
      const boxHeight = chunk.length * lineGap + 12;
      doc.setFillColor(...bg);
      doc.roundedRect(margin, y, maxWidth, boxHeight, 3, 3, 'F');
      doc.setFont('courier', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(...textColor);
      let ty = y + 10;
      for (const line of chunk) {
        doc.text(line, margin + 8, ty);
        ty += lineGap;
      }
      y += boxHeight + 4;
      i += linesThatFit;
    }
  };

  // A labelled, shaded monospace box — paginates itself by drawing a fresh
  // box on the next page if the content doesn't fit in what's left of the
  // current one.
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
  doc.text(includeDiff ? 'JSON Diff Report' : 'Saved JSON (no comparison)', margin, 44);
  y = 54 + 24;

  // ---- Summary card ----
  const name = saved.name || `Comparison #${saved.id}`;
  const diffCount = saved.diffs.length;
  const summaryHeight = 62;
  ensureSpace(summaryHeight);
  doc.setFillColor(...BOX_BG);
  doc.setDrawColor(...BOX_BORDER);
  doc.roundedRect(margin, y, maxWidth, summaryHeight, 6, 6, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(...INK);
  doc.text(name, margin + 14, y + 24);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  doc.text(`Saved ${new Date(saved.created_at).toLocaleString()}`, margin + 14, y + 42);
  if (includeDiff) {
    doc.text(
      diffCount === 0 ? 'No differences' : `${diffCount} difference${diffCount === 1 ? '' : 's'}`,
      pageWidth - margin - 14, y + 42, { align: 'right' }
    );
  }
  y += summaryHeight + 22;

  if (includeDiff) {
    if (saved.ignore_paths?.length) {
      addText(`Ignored fields: ${saved.ignore_paths.join(', ')}`, { size: 8.5, color: MUTED, style: 'italic' });
      y += 6;
    }

    // ---- Diffs ----
    if (diffCount === 0) {
      addText('No differences found.', { size: 10, color: MUTED, gapBefore: 4 });
    } else {
      saved.diffs.forEach((d, idx) => {
        ensureSpace(24);
        addText(d.path, { size: 10, style: 'bold', color: INK, gapBefore: idx === 0 ? 0 : 10 });
        drawValueStrip('-', formatValue(d.old_value), OLD_BG, OLD_TEXT);
        drawValueStrip('+', formatValue(d.new_value), NEW_BG, NEW_TEXT);
      });
    }
  }

  // ---- Compared JSON (full payloads, for reference) — its own page after
  // the diff list when there is one; right under the summary card otherwise.
  if (saved.json_a !== undefined && saved.json_b !== undefined) {
    if (includeDiff) {
      doc.addPage();
      y = margin;
    }
    addText('JSON A / JSON B', { size: 12, style: 'bold', color: INK, gapBefore: includeDiff ? 0 : 4 });
    drawCodeBlock('JSON A', JSON.stringify(saved.json_a, null, 2));
    drawCodeBlock('JSON B', JSON.stringify(saved.json_b, null, 2));
  }

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

  const nameSlug = saved.name ? slugifyForFilename(saved.name) : '';
  const prefix = includeDiff ? 'json-diff' : 'json-pair';
  const filename = nameSlug ? `${prefix}-${nameSlug}-${saved.id}.pdf` : `${prefix}-${saved.id}.pdf`;
  return { doc, filename };
}

export function exportJsonDiffPdf(saved, opts) {
  const { doc, filename } = buildJsonDiffPdf(saved, opts);
  doc.save(filename);
}

// Base64 payload (no data-URI prefix) + filename, for POSTing to a backend
// endpoint (e.g. "Share to Telegram") instead of triggering a local download.
export function getJsonDiffPdfBase64(saved, opts) {
  const { doc, filename } = buildJsonDiffPdf(saved, opts);
  const dataUri = doc.output('datauristring');
  const base64 = dataUri.slice(dataUri.indexOf(',') + 1);
  return { base64, filename };
}
