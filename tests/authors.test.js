'use strict';

/** Author tests cover manual identity merges and ownership derived from churn. */

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
  listAuthors,
  createAuthorMerge,
  deleteAuthorMerge,
} = require('../src/server/services/authors.service');
const {
  getMetrics,
  getAuthorMetrics,
} = require('../src/server/services/metrics.service');
const { createHistoryFixture } = require('./helpers/git-fixture');

async function createIngestedFixture() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rat-authors-test-'));
  const source = path.join(tempRoot, 'source');
  const fixture = createHistoryFixture(source);
  const db = openDatabase(':memory:');

  try {
    const repository = await ingestClone({
      db,
      url: pathToFileURL(source).href,
      name: 'Authors Fixture',
      repoStoreDir: path.join(tempRoot, 'repos'),
    });
    const authorRows = db
      .prepare('SELECT id, email FROM authors WHERE repo_id = ?')
      .all(repository.id);
    const authorIds = Object.fromEntries(
      authorRows.map((author) => [author.email, author.id])
    );
    return { tempRoot, fixture, db, repository, authorIds };
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

function byEmail(report, email) {
  return report.authors.find((author) => author.email === email);
}

test('author metrics calculate modifications, churn and ownership', async () => {
  const context = await createIngestedFixture();
  const { db, fixture, repository } = context;

  try {
    const report = getAuthorMetrics(db, repository.id);
    assert.strictEqual(report.selection.commitCount, 5);
    assert.strictEqual(report.totalChurn, 26);
    assert.strictEqual(report.authors.length, 3);

    assert.deepStrictEqual(byEmail(report, fixture.canonical.email), {
      id: context.authorIds[fixture.canonical.email],
      name: fixture.canonical.name,
      email: fixture.canonical.email,
      commitCount: 1,
      modifications: 1,
      churn: 11,
      ownership: 11 / 26,
    });
    assert.deepStrictEqual(byEmail(report, fixture.second.email), {
      id: context.authorIds[fixture.second.email],
      name: fixture.second.name,
      email: fixture.second.email,
      commitCount: 3,
      modifications: 2,
      churn: 14,
      ownership: 14 / 26,
    });
    assert.deepStrictEqual(byEmail(report, fixture.feature.email), {
      id: context.authorIds[fixture.feature.email],
      name: fixture.feature.name,
      email: fixture.feature.email,
      commitCount: 1,
      modifications: 1,
      churn: 1,
      ownership: 1 / 26,
    });
  } finally {
    cleanFixture(context);
  }
});

test('manual merges reattribute author metrics and author filters without rewriting commits', async () => {
  const context = await createIngestedFixture();
  const { db, fixture, repository, authorIds } = context;
  const sourceId = authorIds[fixture.canonical.email];
  const targetId = authorIds[fixture.second.email];

  try {
    const first = createAuthorMerge(db, repository.id, sourceId, targetId);
    assert.strictEqual(first.created, true);
    assert.strictEqual(first.merge.source.id, sourceId);
    assert.strictEqual(first.merge.target.id, targetId);

    const duplicate = createAuthorMerge(db, repository.id, sourceId, targetId);
    assert.strictEqual(duplicate.created, false, 'an identical merge is idempotent');

    const listed = listAuthors(db, repository.id);
    const source = byEmail(listed, fixture.canonical.email);
    const target = byEmail(listed, fixture.second.email);
    assert.deepStrictEqual(
      {
        canonicalAuthorId: source.canonicalAuthorId,
        effectiveCommitCount: source.effectiveCommitCount,
        isMerged: source.isMerged,
      },
      { canonicalAuthorId: targetId, effectiveCommitCount: 0, isMerged: true }
    );
    assert.strictEqual(target.effectiveCommitCount, 4);

    const report = getAuthorMetrics(db, repository.id);
    assert.strictEqual(report.authors.length, 2);
    assert.deepStrictEqual(byEmail(report, fixture.second.email), {
      id: targetId,
      name: fixture.second.name,
      email: fixture.second.email,
      commitCount: 4,
      modifications: 3,
      churn: 25,
      ownership: 25 / 26,
    });

    const filteredByAlias = getMetrics(db, repository.id, { author: sourceId });
    const filteredByCanonical = getMetrics(db, repository.id, { author: targetId });
    assert.strictEqual(filteredByAlias.selection.authorId, targetId);
    assert.strictEqual(filteredByAlias.selection.commitCount, 4);
    assert.deepStrictEqual(filteredByAlias.metrics, filteredByCanonical.metrics);
    assert.strictEqual(filteredByAlias.metrics.churn, 25);

    assert.strictEqual(
      db.prepare('SELECT count(*) AS count FROM commits WHERE author_id = ?').get(sourceId)
        .count,
      1,
      'merge resolution leaves immutable ingested commit facts intact'
    );

    deleteAuthorMerge(db, repository.id, sourceId);
    assert.strictEqual(getAuthorMetrics(db, repository.id).authors.length, 3);
  } finally {
    cleanFixture(context);
  }
});

test('author merge API rejects self, reassigned and chained mappings', async () => {
  const context = await createIngestedFixture();
  const { db, fixture, repository, authorIds } = context;
  const canonicalId = authorIds[fixture.canonical.email];
  const secondId = authorIds[fixture.second.email];
  const featureId = authorIds[fixture.feature.email];
  const server = await startServer({ database: db });

  async function postMerge(sourceAuthorId, targetAuthorId) {
    return fetch(`${server.url}/api/repos/${repository.id}/author-merges`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceAuthorId, targetAuthorId }),
    });
  }

  try {
    const self = await postMerge(canonicalId, canonicalId);
    assert.strictEqual(self.status, 400);
    assert.match((await self.json()).error.message, /itself/);

    const created = await postMerge(canonicalId, secondId);
    assert.strictEqual(created.status, 201);
    assert.strictEqual((await created.json()).merge.target.id, secondId);

    const duplicate = await postMerge(canonicalId, secondId);
    assert.strictEqual(duplicate.status, 200);
    assert.strictEqual((await duplicate.json()).created, false);

    const reassigned = await postMerge(canonicalId, featureId);
    assert.strictEqual(reassigned.status, 409);
    assert.match((await reassigned.json()).error.message, /already merged/);

    const sourceHasAliases = await postMerge(secondId, featureId);
    assert.strictEqual(sourceHasAliases.status, 409);
    assert.match((await sourceHasAliases.json()).error.message, /chained merges/);

    const targetIsAlias = await postMerge(featureId, canonicalId);
    assert.strictEqual(targetIsAlias.status, 409);
    assert.match((await targetIsAlias.json()).error.message, /chained merges/);

    const authors = await fetch(`${server.url}/api/repos/${repository.id}/authors`);
    assert.strictEqual(authors.status, 200);
    assert.strictEqual((await authors.json()).authors.length, 3);

    const scoped = await fetch(
      `${server.url}/api/repos/${repository.id}/authors/metrics?type=directory&path=src`
    );
    assert.strictEqual(scoped.status, 200);
    const scopedReport = await scoped.json();
    assert.strictEqual(scopedReport.totalChurn, 24);
    assert.strictEqual(byEmail(scopedReport, fixture.second.email).ownership, 1);

    const invalidFilter = await fetch(
      `${server.url}/api/repos/${repository.id}/authors/metrics?author=${secondId}`
    );
    assert.strictEqual(invalidFilter.status, 400);

    const removed = await fetch(
      `${server.url}/api/repos/${repository.id}/author-merges/${canonicalId}`,
      { method: 'DELETE' }
    );
    assert.strictEqual(removed.status, 204);

    const missing = await fetch(
      `${server.url}/api/repos/${repository.id}/author-merges/${canonicalId}`,
      { method: 'DELETE' }
    );
    assert.strictEqual(missing.status, 404);
  } finally {
    await server.close();
    cleanFixture(context);
  }
});
