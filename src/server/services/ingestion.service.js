'use strict';

/**
 * Repository ingestion orchestration.
 *
 * Clone work happens outside SQLite transactions. Parsed history is persisted
 * in bounded batches so large repositories do not accumulate in memory or
 * leave a transaction open while waiting on a child process. Any failure
 * removes partial facts but retains the repository row with status=error.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../../../config');
const git = require('./git.service');

const BATCH_CHANGE_LIMIT = 2000;
const BATCH_COMMIT_LIMIT = 1000;
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'ssh:', 'git:', 'file:']);
const SCP_STYLE_URL = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/;

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

function validateCloneUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError('url is required');
  }

  const sourceUrl = value.trim();
  if (sourceUrl.length > 2048 || /[\u0000-\u001f\u007f]/.test(sourceUrl)) {
    throw new ValidationError('url is invalid');
  }

  if (SCP_STYLE_URL.test(sourceUrl)) return sourceUrl;

  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new ValidationError(
      'url must use http, https, ssh, git, file, or git@host:path syntax'
    );
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new ValidationError(`unsupported repository URL protocol: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new ValidationError('repository URLs containing credentials are not accepted');
  }
  if (parsed.protocol !== 'file:' && !parsed.hostname) {
    throw new ValidationError('repository URL must include a host');
  }

  return sourceUrl;
}

function deriveRepositoryName(sourceUrl) {
  const withoutQuery = sourceUrl.split(/[?#]/, 1)[0];
  const slashOrColon = Math.max(
    withoutQuery.lastIndexOf('/'),
    withoutQuery.lastIndexOf(':')
  );
  let name = withoutQuery.slice(slashOrColon + 1).replace(/\.git$/i, '');
  try {
    name = decodeURIComponent(name);
  } catch {
    // Keep the literal URL segment if percent-encoding is malformed.
  }
  return name.trim() || 'Repository';
}

function validateName(value, sourceUrl) {
  const name = value === undefined ? deriveRepositoryName(sourceUrl) : value;
  if (typeof name !== 'string' || !name.trim()) {
    throw new ValidationError('name must be a non-empty string');
  }
  if (name.trim().length > 120) {
    throw new ValidationError('name must be 120 characters or fewer');
  }
  return name.trim();
}

function publicRepositoryRow(db, repoId, counts = {}) {
  const row = db
    .prepare(
      `SELECT id, name, source_type, source_origin, head_commit, status,
              error_message, created_at, archived_at
       FROM repositories WHERE id = ?`
    )
    .get(repoId);

  return {
    id: row.id,
    name: row.name,
    sourceType: row.source_type,
    sourceOrigin: row.source_origin,
    headCommit: row.head_commit,
    status: row.status,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
    commitCount: counts.commitCount || 0,
    authorCount: counts.authorCount || 0,
    fileChangeCount: counts.fileChangeCount || 0,
  };
}

function createBatchWriter(db, repoId) {
  const insertAuthor = db.prepare(
    `INSERT OR IGNORE INTO authors (repo_id, name, email)
     VALUES (?, ?, ?)`
  );
  const findAuthor = db.prepare(
    'SELECT id FROM authors WHERE repo_id = ? AND name = ? AND email = ?'
  );
  const insertCommit = db.prepare(
    `INSERT INTO commits
      (repo_id, hash, parent_hash, author_id, committer_date, subject)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insertChange = db.prepare(
    `INSERT INTO file_changes
      (repo_id, commit_id, path, added, removed, is_binary, is_rename, old_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const authorCache = new Map();

  function authorIdFor(commit) {
    const key = `${commit.authorName}\x00${commit.authorEmail}`;
    if (authorCache.has(key)) return authorCache.get(key);

    insertAuthor.run(repoId, commit.authorName, commit.authorEmail);
    const row = findAuthor.get(repoId, commit.authorName, commit.authorEmail);
    authorCache.set(key, row.id);
    return row.id;
  }

  const write = db.transaction((commits, changes) => {
    for (const commit of commits) {
      commit.databaseId = insertCommit.run(
        repoId,
        commit.hash,
        commit.parentHash,
        authorIdFor(commit),
        commit.committerDate,
        commit.subject
      ).lastInsertRowid;
    }

    for (const { commit, change } of changes) {
      insertChange.run(
        repoId,
        commit.databaseId,
        change.path,
        change.added,
        change.removed,
        change.isBinary ? 1 : 0,
        change.isRename ? 1 : 0,
        change.oldPath
      );
    }
  });

  return { write, authorCache };
}

function cleanPartialFacts(db, repoId, message) {
  const clean = db.transaction(() => {
    db.prepare('DELETE FROM file_changes WHERE repo_id = ?').run(repoId);
    db.prepare('DELETE FROM commits WHERE repo_id = ?').run(repoId);
    db.prepare('DELETE FROM author_merges WHERE repo_id = ?').run(repoId);
    db.prepare('DELETE FROM authors WHERE repo_id = ?').run(repoId);
    db.prepare(
      `UPDATE repositories
       SET status = 'error', error_message = ?, head_commit = NULL
       WHERE id = ?`
    ).run(message, repoId);
  });
  clean();
}

function safeErrorMessage(error) {
  const message = error && error.message ? error.message : 'Repository ingestion failed';
  return message.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 2000);
}

async function ingestRepository(options) {
  const {
    db,
    sourceType,
    sourceOrigin,
    repositoryName,
    prepareStorage,
    repoStoreDir = config.paths.repoStoreDir,
    gitService = git,
    gitOptions = {},
  } = options;

  if (!db) throw new Error('A database connection is required');
  if (!['clone', 'zip'].includes(sourceType)) {
    throw new Error(`Unsupported ingestion source type: ${sourceType}`);
  }
  if (typeof prepareStorage !== 'function') {
    throw new Error('A storage preparation function is required');
  }

  fs.mkdirSync(repoStoreDir, { recursive: true });
  const storagePath = path.join(repoStoreDir, `${crypto.randomUUID()}.git`);
  const repoId = db
    .prepare(
      `INSERT INTO repositories
        (name, source_type, source_origin, storage_path, status)
       VALUES (?, ?, ?, ?, 'pending')`
    )
    .run(repositoryName, sourceType, sourceOrigin, storagePath).lastInsertRowid;

  db.prepare(
    `UPDATE repositories SET status = 'processing', error_message = NULL
     WHERE id = ?`
  ).run(repoId);

  const writer = createBatchWriter(db, repoId);
  let commits = [];
  let changes = [];
  let changeWeight = 0;
  let commitCount = 0;
  let fileChangeCount = 0;

  function flushBatch() {
    if (!commits.length) return;
    writer.write(commits, changes);
    commitCount += commits.length;
    fileChangeCount += changes.length;
    commits = [];
    changes = [];
    changeWeight = 0;
  }

  try {
    await prepareStorage(storagePath);
    const headCommit = await gitService.resolveHead(storagePath, gitOptions);

    await gitService.streamHistory(
      storagePath,
      {
        onCommit(commit) {
          if (
            changeWeight >= BATCH_CHANGE_LIMIT ||
            commits.length >= BATCH_COMMIT_LIMIT
          ) {
            flushBatch();
          }
          commits.push(commit);
          return commit;
        },
        onChange(change, commit) {
          changes.push({ commit, change });
          changeWeight += 1;
        },
      },
      gitOptions
    );
    flushBatch();

    db.prepare(
      `UPDATE repositories
       SET status = 'ready', error_message = NULL, head_commit = ?
       WHERE id = ?`
    ).run(headCommit, repoId);

    return publicRepositoryRow(db, repoId, {
      commitCount,
      authorCount: writer.authorCache.size,
      fileChangeCount,
    });
  } catch (error) {
    const message = safeErrorMessage(error);
    cleanPartialFacts(db, repoId, message);
    try {
      fs.rmSync(storagePath, { recursive: true, force: true });
    } catch {
      // The error row remains useful even if OS-level cleanup is unavailable.
    }

    error.status = error.status || 422;
    error.repositoryId = repoId;
    throw error;
  }
}

async function ingestClone(options) {
  const {
    url,
    name,
    gitService = git,
    gitOptions = {},
  } = options;
  const sourceUrl = validateCloneUrl(url);
  const repositoryName = validateName(name, sourceUrl);

  return ingestRepository({
    ...options,
    sourceType: 'clone',
    sourceOrigin: sourceUrl,
    repositoryName,
    gitService,
    gitOptions,
    prepareStorage: (storagePath) =>
      gitService.cloneBare(sourceUrl, storagePath, gitOptions),
  });
}

module.exports = {
  ValidationError,
  validateCloneUrl,
  deriveRepositoryName,
  validateName,
  ingestRepository,
  ingestClone,
};
