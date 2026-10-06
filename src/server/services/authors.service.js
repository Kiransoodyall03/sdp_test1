'use strict';

/** Manual author identity merging without rewriting ingested commit facts. */

class AuthorsInputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'AuthorsInputError';
    this.status = status;
  }
}

function parsePositiveInteger(value, label) {
  const text = String(value);
  const number = Number(text);
  if (!/^\d+$/.test(text) || number < 1 || !Number.isSafeInteger(number)) {
    throw new AuthorsInputError(`${label} must be a positive integer`);
  }
  return number;
}

function requireReadyRepository(db, repoId) {
  const repository = db
    .prepare('SELECT id, status FROM repositories WHERE id = ?')
    .get(repoId);
  if (!repository) throw new AuthorsInputError('repository not found', 404);
  if (repository.status !== 'ready') {
    throw new AuthorsInputError(
      `authors are unavailable while repository status is ${repository.status}`,
      409
    );
  }
}

function findAuthor(db, repoId, authorId, label = 'author') {
  const author = db
    .prepare('SELECT id, name, email FROM authors WHERE repo_id = ? AND id = ?')
    .get(repoId, authorId);
  if (!author) throw new AuthorsInputError(`${label} not found in repository`, 404);
  return author;
}

function mergeRow(db, repoId, sourceAuthorId) {
  return db
    .prepare(
      `SELECT am.id, am.source_author_id, am.target_author_id, am.created_at,
              source.name AS source_name, source.email AS source_email,
              target.name AS target_name, target.email AS target_email
       FROM author_merges am
       JOIN authors source ON source.id = am.source_author_id
       JOIN authors target ON target.id = am.target_author_id
       WHERE am.repo_id = ? AND am.source_author_id = ?`
    )
    .get(repoId, sourceAuthorId);
}

function publicMerge(row) {
  return {
    id: row.id,
    source: {
      id: row.source_author_id,
      name: row.source_name,
      email: row.source_email,
    },
    target: {
      id: row.target_author_id,
      name: row.target_name,
      email: row.target_email,
    },
    createdAt: row.created_at,
  };
}

function listAuthors(db, repoIdValue) {
  const repoId = parsePositiveInteger(repoIdValue, 'repository id');
  requireReadyRepository(db, repoId);

  const rows = db
    .prepare(
      `SELECT a.id, a.name, a.email,
              count(c.id) AS observed_commit_count,
              am.target_author_id
       FROM authors a
       LEFT JOIN commits c
         ON c.repo_id = a.repo_id AND c.author_id = a.id
       LEFT JOIN author_merges am
         ON am.repo_id = a.repo_id AND am.source_author_id = a.id
       WHERE a.repo_id = ?
       GROUP BY a.id, a.name, a.email, am.target_author_id
       ORDER BY lower(a.name), lower(a.email), a.id`
    )
    .all(repoId);

  const effectiveCounts = new Map();
  for (const row of rows) {
    const canonicalId = row.target_author_id || row.id;
    effectiveCounts.set(
      canonicalId,
      (effectiveCounts.get(canonicalId) || 0) + Number(row.observed_commit_count)
    );
  }

  return {
    repositoryId: repoId,
    authors: rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      canonicalAuthorId: row.target_author_id || row.id,
      observedCommitCount: Number(row.observed_commit_count),
      effectiveCommitCount: row.target_author_id
        ? 0
        : effectiveCounts.get(row.id) || 0,
      isMerged: row.target_author_id !== null,
    })),
  };
}

function createAuthorMerge(db, repoIdValue, sourceAuthorIdValue, targetAuthorIdValue) {
  const repoId = parsePositiveInteger(repoIdValue, 'repository id');
  const sourceAuthorId = parsePositiveInteger(sourceAuthorIdValue, 'source author id');
  const targetAuthorId = parsePositiveInteger(targetAuthorIdValue, 'target author id');
  requireReadyRepository(db, repoId);

  if (sourceAuthorId === targetAuthorId) {
    throw new AuthorsInputError('an author cannot be merged into itself');
  }
  findAuthor(db, repoId, sourceAuthorId, 'source author');
  findAuthor(db, repoId, targetAuthorId, 'target author');

  const create = db.transaction(() => {
    const existing = db
      .prepare(
        `SELECT target_author_id FROM author_merges
         WHERE repo_id = ? AND source_author_id = ?`
      )
      .get(repoId, sourceAuthorId);
    if (existing) {
      if (existing.target_author_id !== targetAuthorId) {
        throw new AuthorsInputError(
          'source author is already merged; remove that merge before reassigning it',
          409
        );
      }
      return { merge: publicMerge(mergeRow(db, repoId, sourceAuthorId)), created: false };
    }

    const sourceReceivesMerges = db
      .prepare(
        `SELECT 1 FROM author_merges
         WHERE repo_id = ? AND target_author_id = ? LIMIT 1`
      )
      .get(repoId, sourceAuthorId);
    if (sourceReceivesMerges) {
      throw new AuthorsInputError(
        'source author is already canonical for another author; chained merges are not allowed',
        409
      );
    }

    const targetIsMerged = db
      .prepare(
        `SELECT 1 FROM author_merges
         WHERE repo_id = ? AND source_author_id = ? LIMIT 1`
      )
      .get(repoId, targetAuthorId);
    if (targetIsMerged) {
      throw new AuthorsInputError(
        'target author is already merged; chained merges are not allowed',
        409
      );
    }

    db.prepare(
      `INSERT INTO author_merges (repo_id, source_author_id, target_author_id)
       VALUES (?, ?, ?)`
    ).run(repoId, sourceAuthorId, targetAuthorId);

    return { merge: publicMerge(mergeRow(db, repoId, sourceAuthorId)), created: true };
  });

  return create();
}

function deleteAuthorMerge(db, repoIdValue, sourceAuthorIdValue) {
  const repoId = parsePositiveInteger(repoIdValue, 'repository id');
  const sourceAuthorId = parsePositiveInteger(sourceAuthorIdValue, 'source author id');
  requireReadyRepository(db, repoId);

  const result = db
    .prepare(
      `DELETE FROM author_merges
       WHERE repo_id = ? AND source_author_id = ?`
    )
    .run(repoId, sourceAuthorId);
  if (!result.changes) throw new AuthorsInputError('author merge not found', 404);
}

module.exports = {
  AuthorsInputError,
  listAuthors,
  createAuthorMerge,
  deleteAuthorMerge,
};
