'use strict';

/**
 * Server bootstrap: creates the app and listens on the configured port.
 */

const config = require('../../config');
const { createApp } = require('./app');

function main() {
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
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
