'use strict';

/**
 * Repository routes. Handlers delegate directly to the controller; no git or
 * persistence business logic belongs in this layer.
 */

const express = require('express');
const { createReposController } = require('../controllers/repos.controller');

function createReposRouter(options = {}) {
  const router = express.Router();
  const controller = createReposController(options);

  // POST /api/repos { "url": "https://host/owner/repo.git", "name"?: "..." }
  router.post('/', controller.createFromClone);

  return router;
}

module.exports = { createReposRouter };
