'use strict';

/**
 * Slice 1 smoke tests: verify the app boots, serves the shell, exposes the
 * health endpoint, and returns a consistent JSON 404 envelope. These exercise
 * real HTTP behaviour against an ephemeral port (no fixed ports, no network).
 */

const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server/app');

/** Start the app on an ephemeral port; resolve with { url, close }. */
function startServer() {
  return new Promise((resolve) => {
    const app = createApp();
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test('GET /api/health reports ok', async () => {
  const { url, close } = await startServer();
  try {
    const res = await fetch(`${url}/api/health`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.status, 'ok');
    assert.strictEqual(body.service, 'repo-analysis-tool');
    assert.strictEqual(typeof body.timestamp, 'string');
  } finally {
    await close();
  }
});

test('GET / serves the dashboard shell', async () => {
  const { url, close } = await startServer();
  try {
    const res = await fetch(`${url}/`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    const html = await res.text();
    assert.match(html, /Repo Analysis Tool/);
    assert.match(html, /id="health-badge"/);
  } finally {
    await close();
  }
});

test('GET /css/variables.css serves the design tokens', async () => {
  const { url, close } = await startServer();
  try {
    const res = await fetch(`${url}/css/variables.css`);
    assert.strictEqual(res.status, 200);
    const css = await res.text();
    assert.match(css, /--color-primary:\s*#4285f4/i);
  } finally {
    await close();
  }
});

test('unknown API route returns a JSON 404 envelope', async () => {
  const { url, close } = await startServer();
  try {
    const res = await fetch(`${url}/api/does-not-exist`);
    assert.strictEqual(res.status, 404);
    const body = await res.json();
    assert.ok(body.error, 'expected an error envelope');
    assert.strictEqual(typeof body.error.message, 'string');
  } finally {
    await close();
  }
});
