const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType } = require('docx');

function sanitizeString(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeExportPayload(body) {
  const title = sanitizeString(body?.title || 'Report');
  const subtitle = sanitizeString(body?.subtitle || '');
  const meta = Array.isArray(body?.meta) ? body.meta.map(sanitizeString).filter(Boolean).slice(0, 6) : [];
  const columns = Array.isArray(body?.columns) ? body.columns.map(sanitizeString).filter(Boolean).slice(0, 30) : [];
  const rows = Array.isArray(body?.rows) ? body.rows.map(r => (Array.isArray(r) ? r.map(sanitizeString) : [])).slice(0, 5000) : [];

  // Ensure all rows match columns length (pad/truncate)
  const colLen = columns.length || Math.max(0, ...rows.map(r => r.length));
  const safeColumns = columns.length ? columns : Array.from({ length: colLen }, (_, i) => `Column ${i + 1}`);
  const safeRows = rows.map(r => {
    const rr = r.slice(0, safeColumns.length);
    while (rr.length < safeColumns.length) rr.push('');
    return rr;
  });

  return { title, subtitle, meta, columns: safeColumns, rows: safeRows };
}

async function buildDocxBuffer(payload) {
  const { title, subtitle, meta, columns, rows } = payload;

  const children = [];
  children.push(
    new Paragraph({
      children: [new TextRun({ text: title, bold: true, size: 30 })],
      spacing: { after: 200 },
    })
  );

  if (subtitle) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: subtitle, color: '6B7280', size: 22 })],
        spacing: { after: 200 },
      })
    );
  }

  meta.forEach((m) => {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: m, color: '6B7280', size: 20 })],
        spacing: { after: 80 },
      })
    );
  });

  children.push(new Paragraph({ text: '', spacing: { after: 160 } }));

  const headerRow = new TableRow({
    children: columns.map((c) =>
      new TableCell({
        width: { size: 100 / columns.length, type: WidthType.PERCENTAGE },
        children: [
          new Paragraph({
            children: [new TextRun({ text: c, bold: true })],
          }),
        ],
      })
    ),
  });

  const dataRows = rows.map(
    (r) =>
      new TableRow({
        children: r.map((cell) =>
          new TableCell({
            width: { size: 100 / columns.length, type: WidthType.PERCENTAGE },
            children: [new Paragraph({ text: cell })],
          })
        ),
      })
  );

  const table = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...dataRows],
  });

  const doc = new Document({
    sections: [
      {
        properties: {},
        children: [...children, table],
      },
    ],
  });

  return await Packer.toBuffer(doc);
}

async function buildXlsxBuffer(payload) {
  const { title, columns, rows } = payload;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'FaciTrack';
  wb.created = new Date();
  const ws = wb.addWorksheet(title.slice(0, 31) || 'Report');

  ws.columns = columns.map((c) => ({
    header: c,
    key: c,
    width: Math.min(45, Math.max(12, Math.round(c.length * 1.2))),
  }));

  rows.forEach((r) => {
    const obj = {};
    columns.forEach((c, i) => (obj[c] = r[i] ?? ''));
    ws.addRow(obj);
  });

  // Header style
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: 'middle' };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  // Auto-size-ish based on content (bounded)
  ws.columns.forEach((col, idx) => {
    let max = (col.header || '').toString().length;
    for (let i = 0; i < Math.min(rows.length, 200); i++) {
      const v = (rows[i]?.[idx] ?? '').toString();
      if (v.length > max) max = v.length;
    }
    col.width = Math.min(55, Math.max(12, max + 2));
  });

  return await wb.xlsx.writeBuffer();
}

function buildPdfBuffer(payload) {
  const { title, subtitle, meta, columns, rows } = payload;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 40, bottom: 40, left: 40, right: 40 },
      bufferPages: true,
    });

    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    // Header
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#111827').text(title, { width: pageWidth });
    if (subtitle) {
      doc.moveDown(0.25);
      doc.font('Helvetica').fontSize(10).fillColor('#6B7280').text(subtitle, { width: pageWidth });
    }
    meta.forEach((m) => {
      doc.moveDown(0.1);
      doc.font('Helvetica').fontSize(9).fillColor('#6B7280').text(m, { width: pageWidth });
    });
    doc.moveDown(0.8);

    // Table layout (simple, production-ish)
    const colCount = columns.length || 1;
    const colWidth = pageWidth / colCount;
    const rowHeight = 18;
    const headerHeight = 20;

    function drawRow(y, cells, isHeader) {
      const bg = isHeader ? '#F3F4F6' : null;
      if (bg) {
        doc.save();
        doc.rect(doc.page.margins.left, y, pageWidth, headerHeight).fill(bg);
        doc.restore();
      }
      doc.strokeColor('#E5E7EB').lineWidth(1);
      doc.rect(doc.page.margins.left, y, pageWidth, isHeader ? headerHeight : rowHeight).stroke();
      for (let i = 0; i < colCount; i++) {
        const x = doc.page.margins.left + i * colWidth;
        if (i > 0) doc.moveTo(x, y).lineTo(x, y + (isHeader ? headerHeight : rowHeight)).stroke();
        doc
          .font(isHeader ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(isHeader ? 9 : 8.5)
          .fillColor(isHeader ? '#374151' : '#111827')
          .text(cells[i] ?? '', x + 4, y + 5, { width: colWidth - 8, height: (isHeader ? headerHeight : rowHeight) - 6, ellipsis: true });
      }
    }

    function ensureSpace(nextHeight) {
      const bottomY = doc.page.height - doc.page.margins.bottom;
      if (doc.y + nextHeight > bottomY) {
        doc.addPage();
        doc.y = doc.page.margins.top;
        drawRow(doc.y, columns, true);
        doc.y += headerHeight;
      }
    }

    // Draw table header
    drawRow(doc.y, columns, true);
    doc.y += headerHeight;

    if (!rows.length) {
      doc.moveDown(1);
      doc.font('Helvetica').fontSize(10).fillColor('#6B7280').text('No records found.', { width: pageWidth });
    } else {
      rows.forEach((r) => {
        ensureSpace(rowHeight);
        drawRow(doc.y, r, false);
        doc.y += rowHeight;
      });
    }

    // Footer page numbers
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const pageNo = i - range.start + 1;
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor('#9CA3AF')
        .text(`Page ${pageNo} of ${range.count}`, doc.page.margins.left, doc.page.height - doc.page.margins.bottom + 15, {
          width: pageWidth,
          align: 'right',
        });
    }

    doc.end();
  });
}

module.exports = {
  normalizeExportPayload,
  buildPdfBuffer,
  buildDocxBuffer,
  buildXlsxBuffer,
};

