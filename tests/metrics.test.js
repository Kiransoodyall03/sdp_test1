'use strict';

/** Metric tests exercise the full ingestion output against deterministic history. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createApp } = require('../src/server/app');
const { openDatabase } = require('../src/server/db/connection');
const { ingestClone } = require('../src/server/services/ingestion.service');
const {
  MetricsInputError,
  getMetrics,
  getMetricsBatch,
  listObjects,
} = require('../src/server/services/metrics.service');
const { createHistoryFixture } = require('./helpers/git-fixture');

async function createIngestedFixture() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rat-metrics-test-'));
  const source = path.join(tempRoot, 'source');
  const fixture = createHistoryFixture(source);
  const db = openDatabase(':memory:');

  try {
    const repository = await ingestClone({
      db,
      url: pathToFileURL(source).href,
      name: 'Metrics Fixture',
      repoStoreDir: path.join(tempRoot, 'repos'),
    });
    return { tempRoot, fixture, db, repository };
  } catch (error) {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

function cleanFixture(context) {
  context.db.close();
  fs.rmSync(context.tempRoot, { recursive: true, force: true });
}

function startServer(options) {
  return new Promise((resolve) => {
    const server = createApp(options).listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test('repository, directory and file metrics use atomic non-binary facts', async () => {
  const context = await createIngestedFixture();
  const { db, repository } = context;

  try {
    const root = getMetrics(db, repository.id);
    assert.deepStrictEqual(root.scope, { type: 'repository', path: null });
    assert.strictEqual(root.selection.commitCount, 5);
    assert.deepStrictEqual(root.metrics, {
      added: 14,
      removed: 12,
      growth: 2,
      churn: 26,
      modifications: 4,
      modificationFrequency: 4 / 5,
      churnRate: 26 / 5,
    });

    const src = getMetrics(db, repository.id, {
      type: 'directory',
      path: 'src',
    });
    assert.deepStrictEqual(src.metrics, {
      added: 12,
      removed: 12,
      growth: 0,
      churn: 24,
      modifications: 3,
      modificationFrequency: 3 / 5,
      churnRate: 24 / 5,
    });

    const oldPath = getMetrics(db, repository.id, {
      type: 'file',
      path: 'src/app.js',
    });
    assert.deepStrictEqual(oldPath.metrics, {
      added: 10,
      removed: 0,
      growth: 10,
      churn: 10,
      modifications: 1,
      modificationFrequency: 1 / 5,
      churnRate: 2,
    });

    const newPath = getMetrics(db, repository.id, {
      type: 'file',
      path: 'src/main.js',
    });
    assert.deepStrictEqual(newPath.metrics, {
      added: 2,
      removed: 12,
      growth: -10,
      churn: 14,
      modifications: 2,
      modificationFrequency: 2 / 5,
      churnRate: 14 / 5,
    });

    const binary = getMetrics(db, repository.id, {
      type: 'file',
      path: 'assets/logo.bin',
    });
    assert.deepStrictEqual(binary.metrics, {
      added: 0,
      removed: 0,
      growth: 0,
      churn: 0,
      modifications: 0,
      modificationFrequency: 0,
      churnRate: 0,
    });
  } finally {
    cleanFixture(context);
  }
});

test('author, half-open date and manual commit filters intersect correctly', async () => {
  const context = await createIngestedFixture();
  const { db, fixture, repository } = context;

  try {
    const secondAuthor = db
      .prepare('SELECT id FROM authors WHERE repo_id = ? AND email = ?')
      .get(repository.id, fixture.second.email);

    const byAuthor = getMetrics(db, repository.id, { author: secondAuthor.id });
    assert.strictEqual(byAuthor.selection.commitCount, 3);
    assert.deepStrictEqual(byAuthor.metrics, {
      added: 2,
      removed: 12,
      growth: -10,
      churn: 14,
      modifications: 2,
      modificationFrequency: 2 / 3,
      churnRate: 14 / 3,
    });

    const byDate = getMetrics(db, repository.id, {
      from: '2024-01-02T00:00:00Z',
      to: '2024-01-06T00:00:00Z',
    });
    assert.strictEqual(byDate.selection.commitCount, 3);
    assert.deepStrictEqual(byDate.metrics, {
      added: 3,
      removed: 1,
      growth: 2,
      churn: 4,
      modifications: 2,
      modificationFrequency: 2 / 3,
      churnRate: 4 / 3,
    });

    const manuallySelected = getMetrics(db, repository.id, {
      commits: `${fixture.initialHash},${fixture.deleteHash}`,
    });
    assert.strictEqual(manuallySelected.selection.commitCount, 2);
    assert.deepStrictEqual(manuallySelected.metrics, {
      added: 11,
      removed: 11,
      growth: 0,
      churn: 22,
      modifications: 2,
      modificationFrequency: 1,
      churnRate: 11,
    });

    const intersection = getMetrics(db, repository.id, {
      author: secondAuthor.id,
      commits: [fixture.featureHash, fixture.modifyHash],
    });
    assert.strictEqual(intersection.selection.commitCount, 1);
    assert.strictEqual(intersection.metrics.churn, 3);

    const empty = getMetrics(db, repository.id, { commits: '' });
    assert.strictEqual(empty.selection.commitCount, 0);
    assert.deepStrictEqual(empty.metrics, {
      added: 0,
      removed: 0,
      growth: 0,
      churn: 0,
      modifications: 0,
      modificationFrequency: 0,
      churnRate: 0,
    });
  } finally {
    cleanFixture(context);
  }
});

test('metrics API lists historical objects and returns useful validation errors', async () => {
  const context = await createIngestedFixture();
  const { db, fixture, repository, tempRoot } = context;
  const server = await startServer({
    database: db,
    repoStoreDir: path.join(tempRoot, 'repos'),
  });

  try {
    assert.deepStrictEqual(listObjects(db, repository.id, 'file').paths, [
      '.mailmap',
      'assets/logo.bin',
      'feature.txt',
      'src/app.js',
      'src/main.js',
    ]);
    assert.deepStrictEqual(listObjects(db, repository.id, 'directory').paths, [
      '',
      'assets',
      'src',
    ]);

    const query = new URLSearchParams({
      type: 'file',
      path: 'src/main.js',
      commits: fixture.modifyHash,
    });
    const response = await fetch(
      `${server.url}/api/repos/${repository.id}/metrics?${query}`
    );
    assert.strictEqual(response.status, 200);
    const report = await response.json();
    assert.strictEqual(report.selection.commitCount, 1);
    assert.deepStrictEqual(report.metrics, {
      added: 2,
      removed: 1,
      growth: 1,
      churn: 3,
      modifications: 1,
      modificationFrequency: 1,
      churnRate: 3,
    });

    const objects = await fetch(
      `${server.url}/api/repos/${repository.id}/objects?type=directory`
    );
    assert.strictEqual(objects.status, 200);
    assert.deepStrictEqual((await objects.json()).paths, ['', 'assets', 'src']);

    const missingPath = await fetch(
      `${server.url}/api/repos/${repository.id}/metrics?type=file&path=missing.js`
    );
    assert.strictEqual(missingPath.status, 404);
    assert.match((await missingPath.json()).error.message, /path not found/);

    const invalidRange = await fetch(
      `${server.url}/api/repos/${repository.id}/metrics?from=10&to=10`
    );
    assert.strictEqual(invalidRange.status, 400);
    assert.match((await invalidRange.json()).error.message, /earlier than/);

    assert.throws(
      () => getMetrics(db, repository.id, { author: 999999 }),
      (error) => error instanceof MetricsInputError && error.status === 404
    );
  } finally {
    await server.close();
    cleanFixture(context);
  }
});

// ---------------------------------------------------------------------------
// Slice 9: batch metrics (collapse N object-table requests into one call)
// ---------------------------------------------------------------------------

test('getMetricsBatch computes many scopes and reports inline errors', async () => {
  const context = await createIngestedFixture();
  const { db, repository } = context;
  try {
    const report = getMetricsBatch(db, repository.id, {
      scopes: [
        { type: 'directory', path: 'src' },
        { type: 'directory', path: 'assets' },
        { type: 'directory', path: '__definitely_missing__' },
      ],
    });
    assert.strictEqual(report.count, 3);
    assert.strictEqual(report.repository.id, repository.id);

    const [src, assets, missing] = report.results;
    assert.strictEqual(src.index, 0);
    assert.strictEqual(src.scope.path, 'src');
    assert.ok(src.metrics && typeof src.metrics.churn === 'number');
    assert.ok(src.metrics.churn > 0);
    assert.strictEqual(assets.index, 1);
    assert.ok(assets.metrics && !assets.error);

    // The bad scope must not fail the whole batch; it carries an inline error.
    assert.strictEqual(missing.index, 2);
    assert.ok(missing.error);
    assert.match(missing.error, /path not found/);
    assert.strictEqual(missing.metrics, undefined);
  } finally {
    cleanFixture(context);
  }
});

test('getMetricsBatch honours shared filters across every scope', async () => {
  const context = await createIngestedFixture();
  const { db, fixture, repository } = context;
  try {
    const unfiltered = getMetricsBatch(db, repository.id, {
      scopes: [{ type: 'directory', path: 'src' }],
    });
    const filtered = getMetricsBatch(db, repository.id, {
      scopes: [{ type: 'directory', path: 'src' }],
      commits: fixture.modifyHash,
    });
    assert.ok(unfiltered.results[0].metrics.churn >= filtered.results[0].metrics.churn);
    assert.ok(filtered.results[0].metrics.churn > 0);
  } finally {
    cleanFixture(context);
  }
});

test('getMetricsBatch validates its input', async () => {
  const context = await createIngestedFixture();
  const { db, repository } = context;
  try {
    assert.throws(
      () => getMetricsBatch(db, repository.id, {}),
      (error) => error instanceof MetricsInputError && error.status === 400
    );
    assert.throws(
      () =>
        getMetricsBatch(db, repository.id, {
          scopes: Array.from({ length: 201 }, () => ({ type: 'repository' })),
        }),
      (error) => error instanceof MetricsInputError && /at most 200/.test(error.message)
    );
    assert.throws(
      () => getMetricsBatch(db, 999999, { scopes: [{ type: 'repository' }] }),
      (error) => error instanceof MetricsInputError && error.status === 404
    );
  } finally {
    cleanFixture(context);
  }
});

test('POST /api/repos/:repoId/metrics/batch returns per-scope results over HTTP', async () => {
  const context = await createIngestedFixture();
  const { db, repository, tempRoot } = context;
  const server = await startServer({
    database: db,
    repoStoreDir: path.join(tempRoot, 'repos'),
  });
  try {
    const response = await fetch(
      `${server.url}/api/repos/${repository.id}/metrics/batch`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scopes: [
            { type: 'directory', path: 'src' },
            { type: 'directory', path: '__definitely_missing__' },
          ],
        }),
      }
    );
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(body.count, 2);
    assert.ok(body.results[0].metrics);
    assert.ok(body.results[1].error);

    // Missing scopes array -> 400 with a clean error envelope.
    const bad = await fetch(
      `${server.url}/api/repos/${repository.id}/metrics/batch`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }
    );
    assert.strictEqual(bad.status, 400);
    assert.ok((await bad.json()).error.message);
  } finally {
    await server.close();
    cleanFixture(context);
  }
});
