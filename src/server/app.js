'use strict';

/**
 * Express application factory.
 *
 * Kept separate from index.js (the bootstrap) so tests can create an app
 * instance and bind it to an ephemeral port without touching the network.
 */

const express = require('express');
const config = require('../../config');
const apiRouter = require('./routes');

function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // JSON API
  app.use('/api', apiRouter);

  // Static assets. Styles live in their own folder (/src/styles) per the
  // separation rules, so they are mounted under /css; the client under /.
  app.use('/css', express.static(config.paths.stylesDir));
  app.use(express.static(config.paths.clientDir));

  // Unknown API route -> JSON 404 envelope (consistent error shape).
  app.use('/api', (req, res) => {
    res.status(404).json({
      error: { message: `Not found: ${req.method} ${req.originalUrl}` },
    });
  });

  // Central error handler. JSON for /api, plain text otherwise.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    const message = err.message || 'Internal server error';
    if (config.env !== 'test') {
      // eslint-disable-next-line no-console
      console.error('[RAT] error:', err);
    }
    if (req.originalUrl.startsWith('/api')) {
      res.status(status).json({ error: { message } });
    } else {
      res.status(status).send(message);
    }
  });

  return app;
}

module.exports = { createApp };
