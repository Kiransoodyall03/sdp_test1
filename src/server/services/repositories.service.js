'use strict';

/** Repository listing and selectable-commit queries for the dashboard. */

const { MetricsInputError } = require('./metrics.service');

function parsePositiveInteger(value, label) {
  const text = String(value);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < 1) {
    throw new MetricsInputError(`${label} must be a positive integer`);
  }
  return Number(text);
}

function parseNonNegativeInteger(value, label, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new MetricsInputError(`${label} must be zero or a positive integer`);
  }
  return Number(text);
}

function parseTimestamp(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    if (Number.isSafeInteger(seconds)) return seconds;
  }
  const milliseconds = Date.parse(text);
  if (!Number.isNaN(milliseconds)) return Math.floor(milliseconds / 1000);
  throw new MetricsInputError(`${label} must be UNIX seconds or an ISO date`);
}

function publicRepository(row) {
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
    commitCount: Number(row.commit_count || 0),
    authorCount: Number(row.author_count || 0),
    fileChangeCount: Number(row.file_change_count || 0),
  };
}

function listRepositories(db, options = {}) {
  const includeArchived = options.includeArchived === true || options.includeArchived === 'true';

  const rows = db
    .prepare(
      `SELECT r.id, r.name, r.source_type, r.source_origin, r.head_commit,
              r.status, r.error_message, r.created_at, r.archived_at,
              (SELECT count(*) FROM commits c WHERE c.repo_id = r.id) AS commit_count,
              (SELECT count(*) FROM authors a WHERE a.repo_id = r.id) AS author_count,
              (SELECT count(*) FROM file_changes fc WHERE fc.repo_id = r.id)
                AS file_change_count
       FROM repositories r
       ${includeArchived ? '' : 'WHERE r.archived_at IS NULL'}
       ORDER BY r.archived_at IS NULL DESC, lower(r.name), r.id`
    )
    .all();

  return {
    repositories: rows.map(publicRepository),
    includeArchived,
  };
}

function listCommits(db, repoIdValue, query = {}) {
  const repoId = parsePositiveInteger(repoIdValue, 'repository id');
  const repository = db
    .prepare('SELECT id, name, status FROM repositories WHERE id = ?')
    .get(repoId);
  if (!repository) throw new MetricsInputError('repository not found', 404);
  if (repository.status !== 'ready') {
    throw new MetricsInputError(
      `commits are unavailable while repository status is ${repository.status}`,
      409
    );
  }

  const limit = parseNonNegativeInteger(query.limit, 'limit', 100);
  const offset = parseNonNegativeInteger(query.offset, 'offset', 0);
  const authorId =
    query.author === undefined || query.author === ''
      ? null
      : parsePositiveInteger(query.author, 'author');
  const from = parseTimestamp(query.from, 'from');
  const to = parseTimestamp(query.to, 'to');
  const search = typeof query.search === 'string' ? query.search.trim() : '';

  if (from !== null && to !== null && from >= to) {
    throw new MetricsInputError('from must be earlier than to');
  }

  if (authorId !== null) {
    const author = db
      .prepare('SELECT 1 FROM authors WHERE repo_id = ? AND id = ?')
      .get(repoId, authorId);
    if (!author) throw new MetricsInputError('author not found in repository', 404);
  }

  const params = { repoId };
  const clauses = ['c.repo_id = @repoId'];
  if (authorId !== null) {
    clauses.push('COALESCE(am.target_author_id, c.author_id) = @authorId');
    params.authorId = authorId;
  }
  if (from !== null) {
    clauses.push('c.committer_date >= @from');
    params.from = from;
  }
  if (to !== null) {
    clauses.push('c.committer_date < @to');
    params.to = to;
  }
  if (search) {
    clauses.push("(c.hash LIKE @search ESCAPE '\\' OR c.subject LIKE @search ESCAPE '\\')");
    params.search = `%${search.replace(/[%_\\]/g, '\\$&')}%`;
  }
  params.limit = limit;
  params.offset = offset;

  const where = clauses.join(' AND ');
  const count = db
    .prepare(
      `SELECT count(*) AS count
       FROM commits c
       LEFT JOIN author_merges am
         ON am.repo_id = c.repo_id AND am.source_author_id = c.author_id
       WHERE ${where}`
    )
    .get(params).count;

  const rows = limit === 0 ? [] : db
    .prepare(
      `SELECT c.hash, c.parent_hash, c.committer_date, c.subject,
              canonical.name AS author_name, canonical.email AS author_email
       FROM commits c
       LEFT JOIN author_merges am
         ON am.repo_id = c.repo_id AND am.source_author_id = c.author_id
       LEFT JOIN authors canonical
         ON canonical.id = COALESCE(am.target_author_id, c.author_id)
        AND canonical.repo_id = c.repo_id
       WHERE ${where}
       ORDER BY c.committer_date DESC, c.hash DESC
       LIMIT @limit OFFSET @offset`
    )
    .all(params);

  return {
    repository: { id: repository.id, name: repository.name },
    limit,
    offset,
    total: count,
    commits: rows.map((row) => ({
      hash: row.hash,
      parentHash: row.parent_hash,
      author: { name: row.author_name, email: row.author_email },
      date: new Date(row.committer_date * 1000).toISOString(),
      unixDate: row.committer_date,
      subject: row.subject,
    })),
  };
}

module.exports = {
  listRepositories,
  listCommits,
};
