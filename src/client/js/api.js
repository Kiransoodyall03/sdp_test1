'use strict';

const BATCH_SIZE = 6;

export async function fetchJson(path) {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!response.ok) {
    const message = body?.error?.message || `Request failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  return body;
}

export function buildQuery(params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `?${text}` : '';
}

export const api = {
  repositories(includeArchived = false) {
    return fetchJson(`/api/repos${buildQuery({ includeArchived })}`);
  },

  authors(repositoryId) {
    return fetchJson(`/api/repos/${repositoryId}/authors`);
  },

  objects(repositoryId, type) {
    return fetchJson(`/api/repos/${repositoryId}/objects${buildQuery({ type })}`);
  },

  metrics(repositoryId, filters) {
    return fetchJson(`/api/repos/${repositoryId}/metrics${buildQuery(filters)}`);
  },

  authorMetrics(repositoryId, filters) {
    return fetchJson(`/api/repos/${repositoryId}/authors/metrics${buildQuery(filters)}`);
  },

  commits(repositoryId, filters) {
    return fetchJson(`/api/repos/${repositoryId}/commits${buildQuery(filters)}`);
  },
};

export async function fetchMetricsBatches(repositoryId, scopes, filters) {
  const results = new Map();
  for (let index = 0; index < scopes.length; index += BATCH_SIZE) {
    const batch = scopes.slice(index, index + BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map(async (scope) => ({
        scope,
        report: await api.metrics(repositoryId, { ...filters, ...scope }),
      }))
    );

    for (const result of settled) {
      if (result.status === 'fulfilled') {
        results.set(result.value.scope.path, result.value.report);
      } else {
        throw result.reason;
      }
    }
  }
  return results;
}
