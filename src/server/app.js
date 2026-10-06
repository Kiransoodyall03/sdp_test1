'use strict';

/**
 * Express application factory.
 *
 * Kept separate from index.js (the bootstrap) so tests can create an app
 * instance and bind it to an ephemeral port without touching the network.
 */

const express = require('express');
const config = require('../../config');
const { createApiRouter } = require('./routes');

function createApp(options = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // JSON API
  app.use('/api', createApiRouter(options));

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
    let status = err.status || 500;
    let message = err.message || 'Internal server error';

    // Malformed JSON bodies surface as an ugly parser error; normalise them to
    // a clean 400 so the client always receives the same envelope shape.
    if (err.type === 'entity.parse.failed') {
      status = 400;
      message = 'Request body is not valid JSON';
    } else if (err.type === 'entity.too.large') {
      status = 413;
      message = 'Request body is too large';
    }

    // Expected client errors are returned but do not pollute server logs.
    if (config.env !== 'test' && status >= 500) {
      // eslint-disable-next-line no-console
      console.error('[RAT] error:', err);
      message = 'Internal server error';
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
