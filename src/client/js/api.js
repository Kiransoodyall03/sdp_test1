'use strict';

const BATCH_SIZE = 6;

export async function fetchJson(path, options) {
  const response = await fetch(path, {
    headers: { accept: 'application/json' },
    ...options,
  });
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

function postJson(path, payload) {
  return fetchJson(path, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function patchJson(path) {
  return fetchJson(path, {
    method: 'PATCH',
    headers: { accept: 'application/json' },
  });
}

function deleteRequest(path) {
  return fetchJson(path, {
    method: 'DELETE',
    headers: { accept: 'application/json' },
  });
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

  repository(repositoryId) {
    return fetchJson(`/api/repos/${repositoryId}`);
  },

  createClone(url, name) {
    return postJson('/api/repos', { url, name: name || undefined });
  },

  createZip(formData) {
    // Let the browser set the multipart boundary; only advertise accept.
    return fetchJson('/api/repos/upload', {
      method: 'POST',
      headers: { accept: 'application/json' },
      body: formData,
    });
  },

  archive(repositoryId) {
    return patchJson(`/api/repos/${repositoryId}/archive`);
  },

  restore(repositoryId) {
    return patchJson(`/api/repos/${repositoryId}/restore`);
  },

  deleteRepo(repositoryId) {
    return deleteRequest(`/api/repos/${repositoryId}`);
  },

  authors(repositoryId) {
    return fetchJson(`/api/repos/${repositoryId}/authors`);
  },

  mergeAuthor(repositoryId, sourceAuthorId, targetAuthorId) {
    return postJson(`/api/repos/${repositoryId}/author-merges`, {
      sourceAuthorId,
      targetAuthorId,
    });
  },

  unmergeAuthor(repositoryId, sourceAuthorId) {
    return deleteRequest(`/api/repos/${repositoryId}/author-merges/${sourceAuthorId}`);
  },

  objects(repositoryId, type) {
    return fetchJson(`/api/repos/${repositoryId}/objects${buildQuery({ type })}`);
  },

  metrics(repositoryId, filters) {
    return fetchJson(`/api/repos/${repositoryId}/metrics${buildQuery(filters)}`);
  },

  metricsBatch(repositoryId, scopes, filters) {
    return postJson(`/api/repos/${repositoryId}/metrics/batch`, {
      scopes,
      ...filters,
    });
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
