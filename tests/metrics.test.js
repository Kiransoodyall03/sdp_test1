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
