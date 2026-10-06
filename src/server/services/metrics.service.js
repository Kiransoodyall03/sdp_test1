'use strict';

/**
 * Metric calculation over a selected commit set H.
 *
 * Only atomic added/removed facts are stored. Every derived metric in the
 * assessment is calculated here at read time, with binary rows contributing
 * zero. Time ranges are [from, to), matching H_i,j in the specification.
 */

class MetricsInputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'MetricsInputError';
    this.status = status;
  }
}

function parsePositiveInteger(value, label) {
  const text = String(value);
  if (!/^\d+$/.test(text) || Number(text) < 1 || !Number.isSafeInteger(Number(text))) {
    throw new MetricsInputError(`${label} must be a positive integer`);
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

function parseCommitHashes(value) {
  if (value === undefined || value === null) return null;
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const hashes = [...new Set(raw.map((item) => String(item).trim()).filter(Boolean))];
  if (hashes.length > 500) {
    throw new MetricsInputError('at most 500 commits may be selected manually');
  }
  for (const hash of hashes) {
    if (!/^[0-9a-fA-F]{7,64}$/.test(hash)) {
      throw new MetricsInputError(`invalid commit hash: ${hash}`);
    }
  }
  return hashes;
}

function normalizeObjectPath(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new MetricsInputError('path must be a non-empty repository-relative path');
  }
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.includes('\0') ||
    normalized.split('/').some((segment) => !segment || segment === '..')
  ) {
    throw new MetricsInputError('path must be a safe repository-relative path');
  }
  return normalized;
}

function parseMetricsFilters(query = {}) {
  const scopeType = query.path === undefined ? 'repository' : query.type;
  if (!['repository', 'file', 'directory'].includes(scopeType)) {
    throw new MetricsInputError('type must be file or directory when path is supplied');
  }
  if (scopeType === 'repository' && query.path !== undefined) {
    throw new MetricsInputError('repository metrics do not accept a path');
  }

  const from = parseTimestamp(query.from, 'from');
  const to = parseTimestamp(query.to, 'to');
  if (from !== null && to !== null && from >= to) {
    throw new MetricsInputError('from must be earlier than to');
  }

  return {
    scopeType,
    path: scopeType === 'repository' ? null : normalizeObjectPath(query.path),
    authorId:
      query.author === undefined || query.author === ''
        ? null
        : parsePositiveInteger(query.author, 'author'),
    from,
    to,
    hashes: parseCommitHashes(query.commits),
  };
}

function requireReadyRepository(db, repoId) {
  const repository = db
    .prepare('SELECT id, name, status FROM repositories WHERE id = ?')
    .get(repoId);
  if (!repository) throw new MetricsInputError('repository not found', 404);
  if (repository.status !== 'ready') {
    throw new MetricsInputError(
      `repository metrics are unavailable while status is ${repository.status}`,
      409
    );
  }
  return repository;
}

function validateFilterReferences(db, repoId, filters) {
  if (filters.authorId !== null) {
    const author = db
      .prepare('SELECT 1 FROM authors WHERE id = ? AND repo_id = ?')
      .get(filters.authorId, repoId);
    if (!author) throw new MetricsInputError('author not found in repository', 404);
  }

  if (filters.hashes && filters.hashes.length) {
    const placeholders = filters.hashes.map(() => '?').join(', ');
    const count = db
      .prepare(
        `SELECT count(*) AS count FROM commits
         WHERE repo_id = ? AND hash IN (${placeholders})`
      )
      .get(repoId, ...filters.hashes).count;
    if (count !== filters.hashes.length) {
      throw new MetricsInputError('one or more selected commits were not found', 404);
    }
  }

  if (filters.scopeType !== 'repository') {
    let found;
    if (filters.scopeType === 'file') {
      found = db
        .prepare(
          `SELECT 1 FROM file_changes
           WHERE repo_id = ? AND (path = ? OR old_path = ?) LIMIT 1`
        )
        .get(repoId, filters.path, filters.path);
    } else {
      const prefix = `${filters.path}/`;
      found = db
        .prepare(
          `SELECT 1 FROM file_changes
           WHERE repo_id = ?
             AND (substr(path, 1, length(?)) = ?
                  OR substr(old_path, 1, length(?)) = ?)
           LIMIT 1`
        )
        .get(repoId, prefix, prefix, prefix, prefix);
    }
    if (!found) throw new MetricsInputError('path not found in repository', 404);
  }
}

function buildSelection(repoId, filters) {
  const clauses = ['c.repo_id = @repoId'];
  const params = { repoId };

  if (filters.authorId !== null) {
    clauses.push('c.author_id = @authorId');
    params.authorId = filters.authorId;
  }
  if (filters.from !== null) {
    clauses.push('c.committer_date >= @fromDate');
    params.fromDate = filters.from;
  }
  if (filters.to !== null) {
    clauses.push('c.committer_date < @toDate');
    params.toDate = filters.to;
  }
  if (filters.hashes !== null) {
    if (!filters.hashes.length) {
      clauses.push('0 = 1');
    } else {
      const names = filters.hashes.map((hash, index) => {
        const key = `hash${index}`;
        params[key] = hash;
        return `@${key}`;
      });
      clauses.push(`c.hash IN (${names.join(', ')})`);
    }
  }

  return { where: clauses.join(' AND '), params };
}

function buildPathJoin(filters, params) {
  if (filters.scopeType === 'repository') return '';
  if (filters.scopeType === 'file') {
    params.objectPath = filters.path;
    return 'AND fc.path = @objectPath';
  }
  params.pathPrefix = `${filters.path}/`;
  return 'AND substr(fc.path, 1, length(@pathPrefix)) = @pathPrefix';
}

function toMetrics(row) {
  const commitCount = Number(row.commit_count || 0);
  const added = Number(row.added || 0);
  const removed = Number(row.removed || 0);
  const churn = added + removed;
  const modifications = Number(row.modifications || 0);

  return {
    added,
    removed,
    growth: added - removed,
    churn,
    modifications,
    modificationFrequency: commitCount ? modifications / commitCount : 0,
    churnRate: commitCount ? churn / commitCount : 0,
  };
}

function getMetrics(db, repoIdValue, input = {}) {
  const repoId = parsePositiveInteger(repoIdValue, 'repository id');
  const repository = requireReadyRepository(db, repoId);
  const filters = parseMetricsFilters(input);
  validateFilterReferences(db, repoId, filters);

  const selection = buildSelection(repoId, filters);
  const pathJoin = buildPathJoin(filters, selection.params);
  const row = db
    .prepare(
      `WITH selected_commits AS (
         SELECT c.id
         FROM commits c
         WHERE ${selection.where}
       ), per_commit AS (
         SELECT sc.id,
                COALESCE(SUM(CASE WHEN fc.is_binary = 0 THEN fc.added ELSE 0 END), 0) AS added,
                COALESCE(SUM(CASE WHEN fc.is_binary = 0 THEN fc.removed ELSE 0 END), 0) AS removed
         FROM selected_commits sc
         LEFT JOIN file_changes fc
           ON fc.commit_id = sc.id
          AND fc.repo_id = @repoId
          ${pathJoin}
         GROUP BY sc.id
       )
       SELECT count(*) AS commit_count,
              COALESCE(SUM(added), 0) AS added,
              COALESCE(SUM(removed), 0) AS removed,
              COALESCE(SUM(CASE WHEN added + removed > 0 THEN 1 ELSE 0 END), 0)
                AS modifications
       FROM per_commit`
    )
    .get(selection.params);

  return {
    repository: { id: repository.id, name: repository.name },
    selection: {
      commitCount: Number(row.commit_count || 0),
      authorId: filters.authorId,
      from: filters.from,
      to: filters.to,
      commits: filters.hashes,
    },
    scope: { type: filters.scopeType, path: filters.path },
    metrics: toMetrics(row),
  };
}

function listObjects(db, repoIdValue, typeValue) {
  const repoId = parsePositiveInteger(repoIdValue, 'repository id');
  requireReadyRepository(db, repoId);
  const type = typeValue || 'file';
  if (!['file', 'directory'].includes(type)) {
    throw new MetricsInputError('type must be file or directory');
  }

  const rows = db
    .prepare(
      `SELECT path FROM file_changes WHERE repo_id = ?
       UNION
       SELECT old_path AS path FROM file_changes
       WHERE repo_id = ? AND old_path IS NOT NULL
       ORDER BY path`
    )
    .all(repoId, repoId);

  if (type === 'file') {
    return { repositoryId: repoId, type, paths: rows.map((row) => row.path) };
  }

  const directories = new Set(['']);
  for (const { path: filePath } of rows) {
    const parts = filePath.split('/');
    for (let depth = 1; depth < parts.length; depth += 1) {
      directories.add(parts.slice(0, depth).join('/'));
    }
  }
  return {
    repositoryId: repoId,
    type,
    paths: [...directories].sort(),
  };
}

module.exports = {
  MetricsInputError,
  parseMetricsFilters,
  getMetrics,
  listObjects,
};
