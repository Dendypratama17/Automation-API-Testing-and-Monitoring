const express = require('express');
const router = express.Router();
const catchAsync = require('../utils/catchAsync');
const { sendTelegramDocument } = require('../services/telegramNotifier');

// Manual, user-triggered "Share to Telegram" — e.g. a JSON Diff PDF export.
// Distinct from the automatic flow-run alert messages sent elsewhere.
router.post('/send-document', catchAsync(async (req, res) => {
  const { filename, caption = '', fileBase64 } = req.body;
  if (!filename || !fileBase64) {
    return res.status(400).json({ error: 'filename and fileBase64 are required' });
  }
  const buffer = Buffer.from(fileBase64, 'base64');
  await sendTelegramDocument(buffer, filename, caption);
  res.json({ sent: true });
}));

module.exports = router;
