'use strict';

/**
 * API router. Mounts all sub-routers under /api.
 * Later slices add: /repos, /repos/:id/metrics, /authors.
 */

const express = require('express');
const healthRouter = require('./health.routes');
const { createReposRouter } = require('./repos.routes');

function createApiRouter(options = {}) {
  const router = express.Router();

  router.use('/health', healthRouter);
  router.use('/repos', createReposRouter(options));

  return router;
}

module.exports = { createApiRouter };
