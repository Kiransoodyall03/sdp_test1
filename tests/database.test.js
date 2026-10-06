'use strict';

/**
 * Database tests use an in-memory or temporary database, never the development
 * database. They exercise migrations, constraints, persistence and archiving.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../src/server/db/connection');
const {
  CURRENT_SCHEMA_VERSION,
  getSchemaVersion,
} = require('../src/server/db/migrate');

function insertRepository(db, overrides = {}) {
  const row = {
    name: 'Fixture repo',
    sourceType: 'clone',
    sourceOrigin: 'https://example.test/fixture.git',
    storagePath: '/tmp/rat-fixture.git',
    ...overrides,
  };

  return db
    .prepare(
      `INSERT INTO repositories (name, source_type, source_origin, storage_path)
       VALUES (@name, @sourceType, @sourceOrigin, @storagePath)`
    )
    .run(row).lastInsertRowid;
}

test('migration creates every table, index and schema version', () => {
  const db = openDatabase(':memory:');
  try {
    assert.strictEqual(getSchemaVersion(db), CURRENT_SCHEMA_VERSION);

    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`
      )
      .all()
      .map((row) => row.name);

    assert.deepStrictEqual(tables, [
      'author_merges',
      'authors',
      'commits',
      'file_changes',
      'repositories',
    ]);

    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND name LIKE 'idx_%'`
      )
      .all();
    assert.ok(indexes.length >= 8, 'expected metric query indexes');
  } finally {
    db.close();
  }
});

test('schema enforces fixed values, uniqueness and foreign keys', () => {
  const db = openDatabase(':memory:');
  try {
    assert.throws(
      () =>
        insertRepository(db, {
          sourceType: 'folder',
          storagePath: '/tmp/invalid-source.git',
        }),
      /CHECK constraint failed/
    );

    const repoId = insertRepository(db);
    const insertAuthor = db.prepare(
      'INSERT INTO authors (repo_id, name, email) VALUES (?, ?, ?)'
    );
    const authorId = insertAuthor.run(
      repoId,
      'Ada Lovelace',
      'ada@example.test'
    ).lastInsertRowid;

    assert.throws(
      () => insertAuthor.run(repoId, 'Ada Lovelace', 'ada@example.test'),
      /UNIQUE constraint failed/
    );
    assert.throws(
      () => insertAuthor.run(9999, 'Grace Hopper', 'grace@example.test'),
      /FOREIGN KEY constraint failed/
    );

    const otherRepoId = insertRepository(db, {
      name: 'Other repo',
      sourceOrigin: 'https://example.test/other.git',
      storagePath: '/tmp/other-fixture.git',
    });
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO commits
              (repo_id, hash, author_id, committer_date)
             VALUES (?, ?, ?, ?)`
          )
          .run(otherRepoId, 'abcdef1234567890', authorId, 1_700_000_000),
      /FOREIGN KEY constraint failed/,
      'an author cannot be attached to a commit in another repository'
    );
  } finally {
    db.close();
  }
});

test('file changes store atomic facts and reject invalid derived inputs', () => {
  const db = openDatabase(':memory:');
  try {
    const repoId = insertRepository(db);
    const authorId = db
      .prepare('INSERT INTO authors (repo_id, name, email) VALUES (?, ?, ?)')
      .run(repoId, 'Linus Torvalds', 'linus@example.test').lastInsertRowid;
    const commitId = db
      .prepare(
        `INSERT INTO commits
          (repo_id, hash, author_id, committer_date, subject)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(repoId, '1234567890abcdef', authorId, 1_700_000_000, 'fixture')
      .lastInsertRowid;

    const insertChange = db.prepare(
      `INSERT INTO file_changes
        (repo_id, commit_id, path, added, removed, is_binary, is_rename, old_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insertChange.run(repoId, commitId, 'src/new.js', 8, 3, 0, 1, 'src/old.js');

    const change = db
      .prepare('SELECT * FROM file_changes WHERE commit_id = ?')
      .get(commitId);
    assert.strictEqual(change.added - change.removed, 5, 'derived growth');
    assert.strictEqual(change.added + change.removed, 11, 'derived churn');

    const columns = db.prepare('PRAGMA table_info(file_changes)').all();
    assert.ok(!columns.some((column) => column.name === 'growth'));
    assert.ok(!columns.some((column) => column.name === 'churn'));

    assert.throws(
      () =>
        insertChange.run(repoId, commitId, 'bad.js', -1, 0, 0, 0, null),
      /CHECK constraint failed/
    );
    assert.throws(
      () =>
        insertChange.run(repoId, commitId, 'binary.dat', 1, 0, 1, 0, null),
      /CHECK constraint failed/
    );
  } finally {
    db.close();
  }
});

test('archive keeps the repository row viewable', () => {
  const db = openDatabase(':memory:');
  try {
    const repoId = insertRepository(db);
    const archivedAt = '2026-01-02T03:04:05.000Z';
    db.prepare('UPDATE repositories SET archived_at = ? WHERE id = ?').run(
      archivedAt,
      repoId
    );

    const row = db
      .prepare('SELECT id, archived_at FROM repositories WHERE id = ?')
      .get(repoId);
    assert.deepStrictEqual(row, { id: repoId, archived_at: archivedAt });
  } finally {
    db.close();
  }
});

test('a file database and parent directory are created automatically', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rat-db-test-'));
  const filename = path.join(tempRoot, 'nested', 'rat.sqlite');
  let db;

  try {
    db = openDatabase(filename);
    const repoId = insertRepository(db, {
      storagePath: '/tmp/persisted-fixture.git',
    });
    db.close();
    db = null;

    assert.ok(fs.existsSync(filename), 'database file should exist');

    db = openDatabase(filename);
    const row = db
      .prepare('SELECT name FROM repositories WHERE id = ?')
      .get(repoId);
    assert.strictEqual(row.name, 'Fixture repo');
  } finally {
    if (db && db.open) db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
