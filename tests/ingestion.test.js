'use strict';

/** Clone-ingestion tests use deterministic local repositories and temp stores. */

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
  COMMIT_MARKER,
  GitLogParser,
} = require('../src/server/services/git.service');
const { createHistoryFixture } = require('./helpers/git-fixture');

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

test('NUL parser handles arbitrary chunks, tabs in paths and rename pairs', () => {
  const commits = [];
  const changes = [];
  const parser = new GitLogParser({
    onCommit(commit) {
      commits.push(commit);
      return commit.hash;
    },
    onChange(change, commitHash) {
      changes.push({ ...change, commitHash });
    },
  });

  const tokens = [
    COMMIT_MARKER,
    'abcdef1234567890',
    '',
    'A Name',
    'a@example.test',
    '1704067200',
    'subject',
    '',
    '\n2\t1\tdir/file\twith-tab.js',
    '\n0\t0\t',
    'old/name.js',
    'new/name.js',
  ];
  const bytes = Buffer.from(`${tokens.join('\0')}\0`, 'utf8');
  for (const byte of bytes) parser.push(Buffer.from([byte]));
  parser.finish();

  assert.strictEqual(commits.length, 1);
  assert.strictEqual(commits[0].parentHash, null);
  assert.strictEqual(changes[0].path, 'dir/file\twith-tab.js');
  assert.deepStrictEqual(changes[1], {
    added: 0,
    removed: 0,
    isBinary: false,
    isRename: true,
    oldPath: 'old/name.js',
    path: 'new/name.js',
    commitHash: 'abcdef1234567890',
  });
});

test('POST /api/repos deeply clones and ingests exact git facts', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rat-ingest-test-'));
  const source = path.join(tempRoot, 'source');
  const store = path.join(tempRoot, 'clones');
  const fixture = createHistoryFixture(source);
  const db = openDatabase(':memory:');
  const server = await startServer({ database: db, repoStoreDir: store });

  try {
    const response = await fetch(`${server.url}/api/repos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: pathToFileURL(source).href,
        name: 'Fixture Project',
      }),
    });
    assert.strictEqual(response.status, 201);
    const body = await response.json();

    assert.strictEqual(body.repository.name, 'Fixture Project');
    assert.strictEqual(body.repository.sourceType, 'clone');
    assert.strictEqual(body.repository.status, 'ready');
    assert.strictEqual(body.repository.headCommit, fixture.deleteHash);
    assert.strictEqual(body.repository.commitCount, 5);
    assert.strictEqual(body.repository.authorCount, 3);
    assert.strictEqual(body.repository.fileChangeCount, 7);

    const repoId = body.repository.id;
    const subjects = db
      .prepare('SELECT hash, subject FROM commits WHERE repo_id = ?')
      .all(repoId);
    assert.strictEqual(subjects.length, 5, 'all reachable non-merge commits');
    assert.ok(!subjects.some((row) => row.hash === fixture.mergeHash));

    const initial = db
      .prepare('SELECT parent_hash FROM commits WHERE hash = ?')
      .get(fixture.initialHash);
    assert.strictEqual(initial.parent_hash, null, 'root commit has an empty parent');

    const authors = db
      .prepare('SELECT name, email FROM authors WHERE repo_id = ? ORDER BY name')
      .all(repoId);
    assert.ok(
      authors.some(
        (author) =>
          author.name === fixture.canonical.name &&
          author.email === fixture.canonical.email
      ),
      '.mailmap resolves the alias to its canonical identity'
    );
    assert.ok(!authors.some((author) => author.email === 'alias@example.test'));

    const binary = db
      .prepare(
        `SELECT added, removed, is_binary FROM file_changes
         WHERE repo_id = ? AND path = 'assets/logo.bin'`
      )
      .get(repoId);
    assert.deepStrictEqual(binary, { added: 0, removed: 0, is_binary: 1 });

    const rename = db
      .prepare(
        `SELECT path, old_path, added, removed, is_rename
         FROM file_changes WHERE repo_id = ? AND is_rename = 1`
      )
      .get(repoId);
    assert.deepStrictEqual(rename, {
      path: 'src/main.js',
      old_path: 'src/app.js',
      added: 0,
      removed: 0,
      is_rename: 1,
    });

    const deletion = db
      .prepare(
        `SELECT fc.path, fc.added, fc.removed
         FROM file_changes fc
         JOIN commits c ON c.id = fc.commit_id
         WHERE c.hash = ?`
      )
      .get(fixture.deleteHash);
    assert.deepStrictEqual(deletion, {
      path: 'src/main.js',
      added: 0,
      removed: 11,
    });

    const clonedPath = db
      .prepare('SELECT storage_path FROM repositories WHERE id = ?')
      .get(repoId).storage_path;
    assert.ok(fs.existsSync(path.join(clonedPath, 'HEAD')), 'stored clone is bare');

    const invalid = await fetch(`${server.url}/api/repos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.strictEqual(invalid.status, 400);
    assert.match((await invalid.json()).error.message, /url is required/);
    assert.strictEqual(
      db.prepare('SELECT count(*) AS count FROM repositories').get().count,
      1,
      'validation errors do not create repository rows'
    );
  } finally {
    await server.close();
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('failed clone retains an error row and removes partial data', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rat-ingest-error-'));
  const db = openDatabase(':memory:');

  try {
    await assert.rejects(
      ingestClone({
        db,
        url: pathToFileURL(path.join(tempRoot, 'missing.git')).href,
        repoStoreDir: path.join(tempRoot, 'clones'),
        gitOptions: { timeoutMs: 5000 },
      }),
      /git failed/
    );

    const repository = db
      .prepare('SELECT status, error_message, storage_path FROM repositories')
      .get();
    assert.strictEqual(repository.status, 'error');
    assert.match(repository.error_message, /git failed/);
    assert.ok(!fs.existsSync(repository.storage_path));
    assert.strictEqual(db.prepare('SELECT count(*) AS n FROM commits').get().n, 0);
    assert.strictEqual(db.prepare('SELECT count(*) AS n FROM authors').get().n, 0);
  } finally {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
