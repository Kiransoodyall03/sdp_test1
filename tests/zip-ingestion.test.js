'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { createApp } = require('../src/server/app');
const { openDatabase } = require('../src/server/db/connection');
const {
  ZipValidationError,
  extractZipSafely,
  ingestZip,
} = require('../src/server/services/zip.service');
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

function zipRepository(source, output, root = 'project') {
  const zip = new AdmZip();
  zip.addLocalFolder(source, root);
  zip.writeZip(output);
}

test('multipart zip upload finds a nested .git directory and reuses ingestion', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rat-zip-test-'));
  const source = path.join(tempRoot, 'source');
  const zipPath = path.join(tempRoot, 'fixture.zip');
  const uploadDir = path.join(tempRoot, 'uploads');
  const repoStoreDir = path.join(tempRoot, 'repos');
  const fixture = createHistoryFixture(source);
  zipRepository(source, zipPath);

  const db = openDatabase(':memory:');
  const server = await startServer({ database: db, uploadTmpDir: uploadDir, repoStoreDir });

  try {
    const form = new FormData();
    form.append('name', 'Uploaded Fixture');
    form.append(
      'repository',
      new Blob([fs.readFileSync(zipPath)], { type: 'application/zip' }),
      'fixture.zip'
    );

    const response = await fetch(`${server.url}/api/repos/upload`, {
      method: 'POST',
      body: form,
    });
    assert.strictEqual(response.status, 201);
    const body = await response.json();
    assert.strictEqual(body.repository.sourceType, 'zip');
    assert.strictEqual(body.repository.sourceOrigin, 'fixture.zip');
    assert.strictEqual(body.repository.name, 'Uploaded Fixture');
    assert.strictEqual(body.repository.headCommit, fixture.deleteHash);
    assert.strictEqual(body.repository.commitCount, 5);
    assert.strictEqual(body.repository.fileChangeCount, 7);

    const stored = db
      .prepare('SELECT storage_path FROM repositories WHERE id = ?')
      .get(body.repository.id);
    assert.ok(fs.existsSync(path.join(stored.storage_path, 'HEAD')));
    assert.deepStrictEqual(fs.readdirSync(uploadDir), [], 'temporary upload is removed');
  } finally {
    await server.close();
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('zip ingestion supports a repository represented by a .git pointer file', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rat-gitfile-test-'));
  const source = path.join(tempRoot, 'source');
  const zipPath = path.join(tempRoot, 'worktree.zip');
  const fixture = createHistoryFixture(source);

  const zip = new AdmZip();
  zip.addLocalFolder(path.join(source, '.git'), 'bundle/git-data');
  zip.addFile('bundle/worktree/.git', Buffer.from('gitdir: ../git-data\n'));
  zip.writeZip(zipPath);

  const db = openDatabase(':memory:');
  try {
    const result = await ingestZip({
      db,
      uploadPath: zipPath,
      originalName: 'worktree.zip',
      uploadTmpDir: path.join(tempRoot, 'uploads'),
      repoStoreDir: path.join(tempRoot, 'repos'),
    });
    assert.strictEqual(result.status, 'ready');
    assert.strictEqual(result.headCommit, fixture.deleteHash);
    assert.strictEqual(result.commitCount, 5);
  } finally {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('safe extraction rejects oversized, traversal and symbolic-link entries', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rat-zip-safe-'));
  try {
    const oversizedPath = path.join(tempRoot, 'oversized.zip');
    const oversized = new AdmZip();
    oversized.addFile('project/.git/large', Buffer.alloc(32));
    oversized.writeZip(oversizedPath);

    assert.throws(
      () =>
        extractZipSafely(oversizedPath, path.join(tempRoot, 'large-out'), {
          maxZipEntries: 10,
          maxZipDepth: 10,
          maxExtractedBytes: 16,
        }),
      (error) => error instanceof ZipValidationError && error.status === 413
    );

    const traversalPath = path.join(tempRoot, 'traversal.zip');
    const traversal = new AdmZip();
    const traversalEntry = traversal.addFile('escape.txt', Buffer.from('escape'));
    traversalEntry.entryName = '../escape.txt';
    traversal.writeZip(traversalPath);

    assert.throws(
      () =>
        extractZipSafely(traversalPath, path.join(tempRoot, 'traversal-out'), {
          maxZipEntries: 10,
          maxZipDepth: 10,
          maxExtractedBytes: 1024,
        }),
      /Unsafe zip entry path/
    );
    assert.ok(!fs.existsSync(path.join(tempRoot, 'escape.txt')));

    const linkPath = path.join(tempRoot, 'link.zip');
    const links = new AdmZip();
    const linkEntry = links.addFile('project/.git', Buffer.from('../outside'));
    linkEntry.attr = (0o120777 << 16) >>> 0;
    links.writeZip(linkPath);

    assert.throws(
      () =>
        extractZipSafely(linkPath, path.join(tempRoot, 'link-out'), {
          maxZipEntries: 10,
          maxZipDepth: 10,
          maxExtractedBytes: 1024,
        }),
      /Symbolic links are not allowed/
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
