'use strict';

/**
 * API router. Mounts all sub-routers under /api.
 * Later slices add: /repos, /repos/:id/metrics, /authors.
 */

const express = require('express');
const healthRouter = require('./health.routes');

const router = express.Router();

router.use('/health', healthRouter);

module.exports = router;
