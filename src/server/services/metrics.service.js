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

    const merge = db
      .prepare(
        `SELECT target_author_id FROM author_merges
         WHERE repo_id = ? AND source_author_id = ?`
      )
      .get(repoId, filters.authorId);
    if (merge) filters.authorId = merge.target_author_id;
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
    clauses.push('COALESCE(am.target_author_id, c.author_id) = @authorId');
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
         LEFT JOIN author_merges am
           ON am.repo_id = c.repo_id AND am.source_author_id = c.author_id
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

function getAuthorMetrics(db, repoIdValue, input = {}) {
  const repoId = parsePositiveInteger(repoIdValue, 'repository id');
  const repository = requireReadyRepository(db, repoId);
  const filters = parseMetricsFilters(input);
  if (filters.authorId !== null) {
    throw new MetricsInputError('author metrics do not accept an author filter');
  }
  validateFilterReferences(db, repoId, filters);

  const selection = buildSelection(repoId, filters);
  const pathJoin = buildPathJoin(filters, selection.params);
  const rows = db
    .prepare(
      `WITH selected_commits AS (
         SELECT c.id, COALESCE(am.target_author_id, c.author_id) AS author_id
         FROM commits c
         LEFT JOIN author_merges am
           ON am.repo_id = c.repo_id AND am.source_author_id = c.author_id
         WHERE ${selection.where}
       ), per_commit AS (
         SELECT sc.id, sc.author_id,
                COALESCE(SUM(CASE WHEN fc.is_binary = 0 THEN fc.added ELSE 0 END), 0) AS added,
                COALESCE(SUM(CASE WHEN fc.is_binary = 0 THEN fc.removed ELSE 0 END), 0) AS removed
         FROM selected_commits sc
         LEFT JOIN file_changes fc
           ON fc.commit_id = sc.id
          AND fc.repo_id = @repoId
          ${pathJoin}
         GROUP BY sc.id, sc.author_id
       ), author_totals AS (
         SELECT author_id, count(*) AS commit_count,
                COALESCE(SUM(added), 0) AS added,
                COALESCE(SUM(removed), 0) AS removed,
                COALESCE(SUM(CASE WHEN added + removed > 0 THEN 1 ELSE 0 END), 0)
                  AS modifications
         FROM per_commit
         GROUP BY author_id
       ), selection_total AS (
         SELECT count(*) AS commit_count,
                COALESCE(SUM(added + removed), 0) AS churn
         FROM per_commit
       )
       SELECT a.id, a.name, a.email,
              COALESCE(author_totals.commit_count, 0) AS commit_count,
              COALESCE(author_totals.added, 0) AS added,
              COALESCE(author_totals.removed, 0) AS removed,
              COALESCE(author_totals.modifications, 0) AS modifications,
              selection_total.commit_count AS selection_commit_count,
              selection_total.churn AS total_churn
       FROM authors a
       LEFT JOIN author_merges merged
         ON merged.repo_id = a.repo_id AND merged.source_author_id = a.id
       LEFT JOIN author_totals ON author_totals.author_id = a.id
       CROSS JOIN selection_total
       WHERE a.repo_id = @repoId AND merged.id IS NULL
       ORDER BY lower(a.name), lower(a.email), a.id`
    )
    .all(selection.params);

  const totalChurn = rows.length ? Number(rows[0].total_churn) : 0;
  return {
    repository: { id: repository.id, name: repository.name },
    selection: {
      commitCount: rows.length ? Number(rows[0].selection_commit_count) : 0,
      from: filters.from,
      to: filters.to,
      commits: filters.hashes,
    },
    scope: { type: filters.scopeType, path: filters.path },
    totalChurn,
    authors: rows.map((row) => {
      const added = Number(row.added);
      const removed = Number(row.removed);
      const churn = added + removed;
      return {
        id: row.id,
        name: row.name,
        email: row.email,
        commitCount: Number(row.commit_count),
        modifications: Number(row.modifications),
        churn,
        ownership: totalChurn ? churn / totalChurn : 0,
      };
    }),
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

/**
 * Compute metrics for many object scopes in a single request. The dashboard
 * object table needs one report per immediate child; batching collapses N HTTP
 * round-trips into one. Shared commit-set filters are applied to every scope.
 * A scope that fails validation is reported inline so the rest still render.
 */
function getMetricsBatch(db, repoIdValue, input = {}) {
  const repoId = parsePositiveInteger(repoIdValue, 'repository id');
  const repository = requireReadyRepository(db, repoId);

  const scopes = Array.isArray(input.scopes) ? input.scopes : null;
  if (!scopes) {
    throw new MetricsInputError('scopes must be an array of { type, path } objects');
  }
  if (scopes.length > 200) {
    throw new MetricsInputError('at most 200 scopes may be requested in one batch');
  }

  const { scopes: _ignored, ...sharedFilters } = input;
  const results = scopes.map((scope, index) => {
    const descriptor = scope && typeof scope === 'object' ? scope : {};
    try {
      const report = getMetrics(db, repoId, {
        ...sharedFilters,
        type: descriptor.type,
        path: descriptor.path,
      });
      return { index, scope: report.scope, metrics: report.metrics };
    } catch (error) {
      return {
        index,
        scope: { type: descriptor.type || null, path: descriptor.path || null },
        error: error.message || 'unable to compute metrics',
      };
    }
  });

  return {
    repository: { id: repository.id, name: repository.name },
    count: results.length,
    results,
  };
}

module.exports = {
  MetricsInputError,
  parseMetricsFilters,
  getMetrics,
  getMetricsBatch,
  getAuthorMetrics,
  listObjects,
};
