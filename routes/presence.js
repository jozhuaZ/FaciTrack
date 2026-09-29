const express = require('express');
const router = express.Router();
const PresenceController = require('../controllers/PresenceController');

/**
 * The BLE scanners talk to these routes. They are devices on the campus
 * network with no session, so they authenticate with the shared secret in
 * PRESENCE_INGEST_KEY — which is why this router is mounted above the role
 * guards in app.js.
 */
router.get('/health', PresenceController.health);
router.post('/ingest', PresenceController.ingest);
// What a scanner cached while its Wi-Fi was down, sent once it reconnects
router.post('/backfill', PresenceController.backfill);

module.exports = router;
