const express = require('express');
const router = express.Router();
const { requireRole } = require('../middleware/auth');
const {
  normalizeExportPayload,
  buildPdfBuffer,
  buildDocxBuffer,
  buildXlsxBuffer,
} = require('../services/export-documents');

function safeBaseFilename(title) {
  const base = String(title || 'report')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return base || 'report';
}

// PROTOTYPE MODE: Disabled role check to allow free navigation
// router.use(requireRole('admin', 'dean', 'instructor', 'superadmin'));

router.post('/:format', async (req, res, next) => {
  try {
    const format = String(req.params.format || '').toLowerCase();
    if (!['pdf', 'docx', 'xlsx'].includes(format)) {
      return res.status(400).json({ error: 'Unsupported export format.' });
    }

    const payload = normalizeExportPayload(req.body);
    const filenameBase = safeBaseFilename(payload.title);

    if (format === 'pdf') {
      const buf = await buildPdfBuffer(payload);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.pdf"`);
      return res.send(buf);
    }

    if (format === 'docx') {
      const buf = await buildDocxBuffer(payload);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.docx"`);
      return res.send(buf);
    }

    const buf = await buildXlsxBuffer(payload);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.xlsx"`);
    return res.send(Buffer.from(buf));
  } catch (err) {
    next(err);
  }
});

module.exports = router;

