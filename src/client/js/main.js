'use strict';

/**
 * Client bootstrap. For now it verifies the API is reachable and reflects the
 * result in the header health badge. Later slices add filters and metric views.
 */
(function initHealthBadge() {
  const badge = document.getElementById('health-badge');
  if (!badge) return;

  const setState = (label, variant) => {
    badge.textContent = label;
    badge.classList.remove('badge--muted', 'badge--success', 'badge--error');
    badge.classList.add(variant);
  };

  fetch('/api/health')
    .then((res) =>
      res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))
    )
    .then((data) =>
      setState(
        data.status === 'ok' ? 'API online' : 'API degraded',
        data.status === 'ok' ? 'badge--success' : 'badge--error'
      )
    )
    .catch(() => setState('API offline', 'badge--error'));
})();
