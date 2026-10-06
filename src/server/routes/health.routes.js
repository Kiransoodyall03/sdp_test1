'use strict';

/**
 * Health route. Trivial handler (no business logic) used as a liveness probe
 * and to verify the API is reachable from the client shell.
 */

const express = require('express');

const router = express.Router();

// GET /api/health
router.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'repo-analysis-tool',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
