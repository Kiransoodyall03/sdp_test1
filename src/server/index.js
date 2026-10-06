'use strict';

/**
 * Server bootstrap: creates the app and listens on the configured port.
 */

const config = require('../../config');
const { createApp } = require('./app');
const { getDatabase, closeDatabase } = require('./db/connection');

function main() {
  // Opening the connection applies committed migrations and creates the
  // database file automatically on first run.
  getDatabase();

  const app = createApp();

  const server = app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[RAT] listening on http://localhost:${config.port} (${config.env})`
    );
  });

  const shutdown = (signal) => {
    // eslint-disable-next-line no-console
    console.log(`[RAT] ${signal} received, closing server`);
    server.close(() => {
      closeDatabase();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
