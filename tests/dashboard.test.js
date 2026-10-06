'use strict';

/**
 * Dashboard tests cover the Slice 7 API surface (repository listing, commit
 * listing with pagination/search/date filters) and verify that all referenced
 * static assets are served correctly.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createApp } = require('../src/server/app');
const { openDatabase } = require('../src/server/db/connection');
const { ingestClone } = require('../src/server/services/ingestion.service');
const { createAuthorMerge } = require('../src/server/services/authors.service');
const { createHistoryFixture } = require('./helpers/git-fixture');

async function createIngestedFixture(name = 'Dashboard Fixture') {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rat-dashboard-test-'));
  const source = path.join(tempRoot, 'source');
  const fixture = createHistoryFixture(source);
  const db = openDatabase(':memory:');

  try {
    const repository = await ingestClone({
      db,
      url: pathToFileURL(source).href,
      name,
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

// ---------------------------------------------------------------------------
// GET /api/repos
// ---------------------------------------------------------------------------

test('GET /api/repos returns ready repositories with counts', async () => {
  const context = await createIngestedFixture();
  try {
    const { url, close } = await startServer({ database: context.db });
    try {
      const res = await fetch(`${url}/api/repos`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body.repositories));
      assert.strictEqual(body.repositories.length, 1);
      const repo = body.repositories[0];
      assert.strictEqual(repo.name, 'Dashboard Fixture');
      assert.strictEqual(repo.status, 'ready');
      assert.ok(repo.commitCount >= 5);
      assert.ok(repo.authorCount >= 3);
      assert.strictEqual(body.includeArchived, false);
    } finally {
      await close();
    }
  } finally {
    cleanFixture(context);
  }
});

test('GET /api/repos excludes archived repositories by default', async () => {
  const context = await createIngestedFixture();
  try {
    context.db
      .prepare('UPDATE repositories SET archived_at = ? WHERE id = ?')
      .run(new Date().toISOString(), context.repository.id);

    const { url, close } = await startServer({ database: context.db });
    try {
      const res = await fetch(`${url}/api/repos`);
      const body = await res.json();
      assert.strictEqual(body.repositories.length, 0);

      const resAll = await fetch(`${url}/api/repos?includeArchived=true`);
      const bodyAll = await resAll.json();
      assert.strictEqual(bodyAll.repositories.length, 1);
      assert.strictEqual(bodyAll.includeArchived, true);
    } finally {
      await close();
    }
  } finally {
    cleanFixture(context);
  }
});

// ---------------------------------------------------------------------------
// GET /api/repos/:repoId/commits
// ---------------------------------------------------------------------------

test('GET /api/repos/:repoId/commits returns paginated commits newest-first', async () => {
  const context = await createIngestedFixture();
  try {
    const { url, close } = await startServer({ database: context.db });
    try {
      const repoId = context.repository.id;

      const res = await fetch(`${url}/api/repos/${repoId}/commits?limit=2&offset=0`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.limit, 2);
      assert.strictEqual(body.offset, 0);
      assert.ok(body.total >= 5);
      assert.strictEqual(body.commits.length, 2);
      assert.strictEqual(body.repository.id, repoId);

      // Newest first
      assert.ok(body.commits[0].unixDate >= body.commits[1].unixDate);
      assert.ok(body.commits[0].hash);
      assert.ok(body.commits[0].subject);
      assert.ok(body.commits[0].author.name);
      assert.ok(body.commits[0].date);

      // Page 2
      const res2 = await fetch(`${url}/api/repos/${repoId}/commits?limit=2&offset=2`);
      const body2 = await res2.json();
      assert.strictEqual(body2.offset, 2);
      assert.strictEqual(body2.commits.length, 2);
      assert.notStrictEqual(body2.commits[0].hash, body.commits[0].hash);
    } finally {
      await close();
    }
  } finally {
    cleanFixture(context);
  }
});

test('GET /api/repos/:repoId/commits filters by date range', async () => {
  const context = await createIngestedFixture();
  try {
    const { url, close } = await startServer({ database: context.db });
    try {
      const repoId = context.repository.id;
      // Fixture commits span 2024-01-01 to 2024-01-06
      const res = await fetch(
        `${url}/api/repos/${repoId}/commits?from=2024-01-03T00:00:00Z&to=2024-01-05T00:00:00Z`
      );
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      // from is inclusive, to is exclusive → Jan 3 and Jan 4
      assert.ok(body.commits.length >= 1);
      for (const commit of body.commits) {
        assert.ok(commit.unixDate >= Date.parse('2024-01-03T00:00:00Z') / 1000);
        assert.ok(commit.unixDate < Date.parse('2024-01-05T00:00:00Z') / 1000);
      }
    } finally {
      await close();
    }
  } finally {
    cleanFixture(context);
  }
});

test('GET /api/repos/:repoId/commits filters by canonical author', async () => {
  const context = await createIngestedFixture();
  try {
    const { url, close } = await startServer({ database: context.db });
    try {
      const repoId = context.repository.id;
      const secondId = context.authorIds['second@example.test'];

      const res = await fetch(`${url}/api/repos/${repoId}/commits?author=${secondId}`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.ok(body.commits.length >= 1);
      for (const commit of body.commits) {
        assert.strictEqual(commit.author.email, 'second@example.test');
      }
    } finally {
      await close();
    }
  } finally {
    cleanFixture(context);
  }
});

test('GET /api/repos/:repoId/commits search escapes LIKE wildcards', async () => {
  const context = await createIngestedFixture();
  try {
    const { url, close } = await startServer({ database: context.db });
    try {
      const repoId = context.repository.id;

      // Search with a percent sign should not match everything
      const res = await fetch(`${url}/api/repos/${repoId}/commits?search=%25`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.commits.length, 0);

      // Search for a known subject
      const res2 = await fetch(`${url}/api/repos/${repoId}/commits?search=rename`);
      const body2 = await res2.json();
      assert.ok(body2.commits.length >= 1);
      assert.ok(body2.commits.some((c) => c.subject.includes('rename')));
    } finally {
      await close();
    }
  } finally {
    cleanFixture(context);
  }
});

test('GET /api/repos/:repoId/commits returns 404 for unknown repo', async () => {
  const context = await createIngestedFixture();
  try {
    const { url, close } = await startServer({ database: context.db });
    try {
      const res = await fetch(`${url}/api/repos/99999/commits`);
      assert.strictEqual(res.status, 404);
    } finally {
      await close();
    }
  } finally {
    cleanFixture(context);
  }
});

test('GET /api/repos/:repoId/commits returns 400 for invalid limit', async () => {
  const context = await createIngestedFixture();
  try {
    const { url, close } = await startServer({ database: context.db });
    try {
      const res = await fetch(`${url}/api/repos/${context.repository.id}/commits?limit=abc`);
      assert.strictEqual(res.status, 400);
    } finally {
      await close();
    }
  } finally {
    cleanFixture(context);
  }
});

test('GET /api/repos/:repoId/commits shows canonical author after merge', async () => {
  const context = await createIngestedFixture();
  try {
    const repoId = context.repository.id;
    const canonicalId = context.authorIds['canonical@example.test'];
    const secondId = context.authorIds['second@example.test'];

    // Merge canonical → second
    createAuthorMerge(context.db, repoId, canonicalId, secondId);

    const { url, close } = await startServer({ database: context.db });
    try {
      // Filter by second author should now include canonical's commits
      const res = await fetch(`${url}/api/repos/${repoId}/commits?author=${secondId}`);
      const body = await res.json();
      assert.ok(body.commits.length >= 3);
      for (const commit of body.commits) {
        assert.strictEqual(commit.author.email, 'second@example.test');
      }
    } finally {
      await close();
    }
  } finally {
    cleanFixture(context);
  }
});

// ---------------------------------------------------------------------------
// Static asset serving
// ---------------------------------------------------------------------------

test('dashboard CSS and JS assets are served', async () => {
  const { url, close } = await startServer();
  try {
    const assets = [
      '/css/variables.css',
      '/css/base.css',
      '/css/components.css',
      '/css/dashboard.css',
      '/css/charts.css',
      '/js/main.js',
      '/js/api.js',
      '/js/charts.js',
    ];
    for (const asset of assets) {
      const res = await fetch(`${url}${asset}`);
      assert.strictEqual(res.status, 200, `${asset} should return 200`);
    }
  } finally {
    await close();
  }
});

test('dashboard HTML has no inline styles or style blocks', async () => {
  const { url, close } = await startServer();
  try {
    const res = await fetch(`${url}/`);
    const html = await res.text();
    assert.ok(!/<style[\s>]/i.test(html), 'HTML must not contain <style> blocks');
    assert.ok(!/style\s*=/i.test(html), 'HTML must not contain inline style attributes');
  } finally {
    await close();
  }
});

test('dashboard HTML references all required CSS and JS files', async () => {
  const { url, close } = await startServer();
  try {
    const res = await fetch(`${url}/`);
    const html = await res.text();
    assert.match(html, /href="\/css\/dashboard\.css"/);
    assert.match(html, /href="\/css\/charts\.css"/);
    assert.match(html, /src="\/js\/main\.js"/);
    assert.match(html, /type="module"/);
  } finally {
    await close();
  }
});
