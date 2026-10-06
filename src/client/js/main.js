import { api, fetchJson } from './api.js';
import { renderEmptyChart, renderOwnershipChart } from './charts.js';

const OBJECT_ROW_LIMIT = 50;

const elements = {
  healthBadge: document.getElementById('health-badge'),
  filterForm: document.getElementById('filter-form'),
  filterStatus: document.getElementById('filter-status'),
  dashboardError: document.getElementById('dashboard-error'),
  repositorySelect: document.getElementById('repository-select'),
  scopeSelect: document.getElementById('scope-select'),
  pathField: document.getElementById('path-field'),
  pathLabel: document.getElementById('path-label'),
  pathSelect: document.getElementById('path-select'),
  authorSelect: document.getElementById('author-select'),
  fromDate: document.getElementById('from-date'),
  toDate: document.getElementById('to-date'),
  manualFields: document.getElementById('manual-fields'),
  commitSearch: document.getElementById('commit-search'),
  commitPicker: document.getElementById('commit-picker'),
  commitCount: document.getElementById('commit-count'),
  clearCommits: document.getElementById('clear-commits'),
  resetFilters: document.getElementById('reset-filters'),
  repositoryStatus: document.getElementById('repository-status'),
  objectCaption: document.getElementById('object-table-caption'),
  objectBody: document.getElementById('object-table-body'),
  authorBody: document.getElementById('author-table-body'),
  ownershipChart: document.getElementById('ownership-chart'),
  summary: {
    commits: document.getElementById('summary-commits'),
    added: document.getElementById('summary-added'),
    removed: document.getElementById('summary-removed'),
    growth: document.getElementById('summary-growth'),
    churn: document.getElementById('summary-churn'),
    modifications: document.getElementById('summary-modifications'),
    modificationFrequency: document.getElementById('summary-modification-frequency'),
    churnRate: document.getElementById('summary-churn-rate'),
  },
};

const state = {
  repositories: [],
  selectedRepository: null,
  authors: [],
  objects: { file: [], directory: [] },
  selectedPaths: { file: '', directory: '' },
  selectedCommitLabels: new Map(),
  commitMode: 'time',
  commitOffset: 0,
  commitSearch: '',
  searchTimer: null,
};

const numberFormatter = new Intl.NumberFormat();

function formatNumber(value) {
  return numberFormatter.format(Number(value) || 0);
}

function formatRate(value) {
  return (Number(value) || 0).toFixed(3);
}

function formatPercent(value) {
  return `${((Number(value) || 0) * 100).toFixed(1)}%`;
}

function formatDate(isoDate) {
  return isoDate ? isoDate.slice(0, 10) : '';
}

function setError(message) {
  elements.dashboardError.textContent = message || '';
  elements.dashboardError.classList.toggle('hidden', !message);
}

function setFilterStatus(message) {
  elements.filterStatus.textContent = message;
}

function setRepositoryStatus(repository) {
  const badge = elements.repositoryStatus;
  badge.classList.remove('badge--muted', 'badge--success', 'badge--error', 'badge--warning');

  if (!repository) {
    badge.textContent = 'No repository';
    badge.classList.add('badge--muted');
    return;
  }
  if (repository.status === 'ready') {
    badge.textContent = 'Ready';
    badge.classList.add('badge--success');
  } else if (repository.status === 'error') {
    badge.textContent = repository.errorMessage || 'Error';
    badge.classList.add('badge--error');
  } else {
    badge.textContent = repository.status;
    badge.classList.add('badge--warning');
  }
}

function clearDynamicViews() {
  for (const node of Object.values(elements.summary)) node.textContent = '0';
  elements.objectBody.replaceChildren();
  elements.authorBody.replaceChildren();
  renderEmptyChart(elements.ownershipChart, 'Select a ready repository.');
}

function currentScopeLabel() {
  const scope = elements.scopeSelect.value;
  if (scope === 'repository') return 'repository root';
  const path = state.selectedPaths[scope];
  return `${scope} ${path || '(root)'}`;
}

function baseFilters() {
  const filters = {};
  if (elements.authorSelect.value) filters.author = elements.authorSelect.value;

  if (state.commitMode === 'time') {
    if (elements.fromDate.value) filters.from = `${elements.fromDate.value}T00:00:00Z`;
    if (elements.toDate.value) {
      const exclusiveEnd = new Date(`${elements.toDate.value}T00:00:00Z`);
      exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1);
      filters.to = exclusiveEnd.toISOString();
    }
  } else {
    filters.commits = [...state.selectedCommitLabels.keys()].join(',');
  }

  return filters;
}

function scopeFilters() {
  const scope = elements.scopeSelect.value;
  if (scope === 'repository') return {};
  return { type: scope, path: state.selectedPaths[scope] };
}

function renderSummary(report) {
  const { metrics, selection } = report;
  elements.summary.commits.textContent = formatNumber(selection.commitCount);
  elements.summary.added.textContent = formatNumber(metrics.added);
  elements.summary.removed.textContent = formatNumber(metrics.removed);
  elements.summary.growth.textContent = formatNumber(metrics.growth);
  elements.summary.churn.textContent = formatNumber(metrics.churn);
  elements.summary.modifications.textContent = formatNumber(metrics.modifications);
  elements.summary.modificationFrequency.textContent = formatRate(metrics.modificationFrequency);
  elements.summary.churnRate.textContent = formatRate(metrics.churnRate);
}

function objectRow(label, report) {
  const row = document.createElement('tr');
  const name = document.createElement('th');
  name.scope = 'row';
  name.textContent = label;
  row.appendChild(name);

  const values = report
    ? [
        report.metrics.added,
        report.metrics.removed,
        report.metrics.growth,
        report.metrics.churn,
        report.metrics.modifications,
      ]
    : ['—', '—', '—', '—', '—'];

  for (const value of values) {
    const cell = document.createElement('td');
    cell.className = 'num';
    cell.textContent = typeof value === 'number' ? formatNumber(value) : value;
    row.appendChild(cell);
  }
  return row;
}

function childScopes() {
  const scope = elements.scopeSelect.value;
  const selected = state.selectedPaths[scope];
  const prefix = selected ? `${selected}/` : '';
  const childNames = new Set();

  for (const file of state.objects.file) {
    if (prefix && !file.startsWith(prefix)) continue;
    const remainder = prefix ? file.slice(prefix.length) : file;
    childNames.add(remainder.split('/', 1)[0]);
  }

  for (const directory of state.objects.directory) {
    if (!directory) continue;
    if (prefix && !directory.startsWith(prefix)) continue;
    const remainder = prefix ? directory.slice(prefix.length) : directory;
    if (!remainder || remainder.includes('/')) continue;
    childNames.add(remainder);
  }

  return [...childNames]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => {
      const path = `${prefix}${name}`;
      return {
        label: path,
        path,
        type: state.objects.directory.includes(path) ? 'directory' : 'file',
      };
    });
}

async function loadObjectTable(filters) {
  const scope = elements.scopeSelect.value;
  elements.objectCaption.textContent =
    scope === 'repository'
      ? 'Immediate children of the repository root.'
      : `Immediate children of ${currentScopeLabel()}.`;

  if (scope === 'file') {
    const path = state.selectedPaths.file;
    try {
      const report = await api.metrics(state.selectedRepository.id, {
        ...filters,
        type: 'file',
        path,
      });
      elements.objectBody.replaceChildren(objectRow(path, report));
    } catch {
      elements.objectBody.replaceChildren(objectRow(path, null));
    }
    return;
  }

  const children = childScopes();
  const visible = children.slice(0, OBJECT_ROW_LIMIT);
  if (!visible.length) {
    elements.objectBody.replaceChildren();
    return;
  }

  const results = await Promise.all(
    visible.map(async (child) => {
      try {
        return objectRow(
          child.label,
          await api.metrics(state.selectedRepository.id, {
            ...filters,
            type: child.type,
            path: child.path,
          })
        );
      } catch {
        return objectRow(child.label, null);
      }
    })
  );

  if (children.length > visible.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.className = 'table-note';
    cell.textContent = `Showing the first ${visible.length} of ${children.length} immediate objects.`;
    row.appendChild(cell);
    results.push(row);
  }

  elements.objectBody.replaceChildren(...results);
}

async function loadAuthorViews(filters) {
  const authorMetricsFilters = { ...filters, ...scopeFilters() };
  delete authorMetricsFilters.author;

  const report = await api.authorMetrics(state.selectedRepository.id, authorMetricsFilters);
  renderOwnershipChart(elements.ownershipChart, report.authors, currentScopeLabel());

  const rows = report.authors.map((author) => {
    const row = document.createElement('tr');
    const name = document.createElement('th');
    name.scope = 'row';
    name.textContent = `${author.name} <${author.email}>`;
    row.appendChild(name);

    for (const value of [author.commitCount, author.modifications, author.churn]) {
      const cell = document.createElement('td');
      cell.className = 'num';
      cell.textContent = formatNumber(value);
      row.appendChild(cell);
    }

    const ownership = document.createElement('td');
    ownership.className = 'num';
    ownership.textContent = formatPercent(author.ownership);
    row.appendChild(ownership);
    return row;
  });
  elements.authorBody.replaceChildren(...rows);
}

function isRepositoryReady() {
  return Boolean(state.selectedRepository && state.selectedRepository.status === 'ready');
}

function validateFilters() {
  if (!state.selectedRepository) return 'Select a repository.';
  if (!isRepositoryReady()) {
    return `${state.selectedRepository.name} is ${state.selectedRepository.status}; metrics are unavailable.`;
  }

  const scope = elements.scopeSelect.value;
  if (scope !== 'repository' && !state.selectedPaths[scope]) {
    return `Select a ${scope}.`;
  }
  if (
    state.commitMode === 'time' &&
    elements.fromDate.value &&
    elements.toDate.value &&
    elements.fromDate.value >= elements.toDate.value
  ) {
    return 'The inclusive start date must be earlier than the exclusive end date.';
  }
  return null;
}

async function refreshDashboard() {
  setError(null);
  const validationError = validateFilters();
  if (validationError) {
    clearDynamicViews();
    setFilterStatus(validationError);
    return;
  }

  const filters = { ...baseFilters(), ...scopeFilters() };
  setFilterStatus('Loading metrics…');
  try {
    const report = await api.metrics(state.selectedRepository.id, filters);
    renderSummary(report);
    await Promise.all([loadObjectTable(filters), loadAuthorViews(filters)]);
    setFilterStatus(`Updated ${currentScopeLabel()}.`);
  } catch (error) {
    clearDynamicViews();
    setError(error.message);
    setFilterStatus('Metrics unavailable.');
  }
}

function populateSelect(select, options, currentValue) {
  const fragment = new DocumentFragment();
  for (const option of options) {
    const node = document.createElement('option');
    node.value = option.value;
    node.textContent = option.label;
    fragment.appendChild(node);
  }
  select.replaceChildren(fragment);
  if (currentValue && options.some((option) => option.value === currentValue)) {
    select.value = currentValue;
  }
}

async function loadRepositoryOptions() {
  const data = await api.repositories();
  state.repositories = data.repositories;
  const options = state.repositories.map((repository) => ({
    value: String(repository.id),
    label: `${repository.name} (${repository.status})`,
  }));
  populateSelect(elements.repositorySelect, options, String(state.selectedRepository?.id || ''));
  elements.repositorySelect.disabled = !options.length;

  if (!options.length) {
    state.selectedRepository = null;
    setRepositoryStatus(null);
    setFilterStatus('No repositories are available.');
    clearDynamicViews();
    return;
  }

  await selectRepository(Number(elements.repositorySelect.value));
}

async function loadAuthors(repositoryId) {
  const data = await api.authors(repositoryId);
  state.authors = data.authors;
  populateSelect(elements.authorSelect, [
    { value: '', label: 'All canonical authors' },
    ...state.authors
      .filter((author) => !author.isMerged)
      .map((author) => ({
        value: String(author.id),
        label: `${author.name} <${author.email}>`,
      })),
  ]);
}

async function loadObjects(repositoryId) {
  const [files, directories] = await Promise.all([
    api.objects(repositoryId, 'file'),
    api.objects(repositoryId, 'directory'),
  ]);
  state.objects.file = files.paths;
  state.objects.directory = directories.paths;
}

function updatePathField() {
  const scope = elements.scopeSelect.value;
  elements.pathField.classList.toggle('hidden', scope === 'repository');
  if (scope === 'repository') return;

  const isFile = scope === 'file';
  elements.pathLabel.textContent = isFile ? 'File' : 'Directory';
  const paths = isFile ? state.objects.file : state.objects.directory;
  populateSelect(
    elements.pathSelect,
    paths.map((path) => ({
      value: path,
      label: !isFile && path === '' ? '(repository root)' : path,
    })),
    state.selectedPaths[scope]
  );
  state.selectedPaths[scope] = elements.pathSelect.value || '';
}

function createCommitOption(commit, checked) {
  const label = document.createElement('label');
  label.className = 'commit-option';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.value = commit.hash;
  checkbox.checked = checked;

  const text = document.createElement('span');
  text.className = 'commit-option__text';
  text.textContent = `${commit.hash.slice(0, 7)} · ${formatDate(commit.date)} · ${commit.subject} · ${commit.author.name}`;

  label.append(checkbox, text);
  return label;
}

function updateCommitCount() {
  elements.commitCount.textContent = `${state.selectedCommitLabels.size} selected`;
}

function renderCommitPicker(commits, total, offset, append) {
  if (!append) elements.commitPicker.replaceChildren();

  const listed = new Set(commits.map((commit) => commit.hash));
  const orphaned = [...state.selectedCommitLabels.entries()].filter(
    ([hash]) => !listed.has(hash)
  );
  if (orphaned.length) {
    const heading = document.createElement('p');
    heading.className = 'commit-picker__heading';
    heading.textContent = 'Selected outside current search';
    elements.commitPicker.appendChild(heading);

    for (const [hash, label] of orphaned) {
      elements.commitPicker.appendChild(
        createCommitOption({ hash, date: '', subject: label, author: { name: '' } }, true)
      );
    }
  }

  for (const commit of commits) {
    elements.commitPicker.appendChild(
      createCommitOption(commit, state.selectedCommitLabels.has(commit.hash))
    );
  }

  if (!commits.length && !append && !orphaned.length) {
    const empty = document.createElement('p');
    empty.className = 'placeholder-note';
    empty.textContent = 'No commits match the current search.';
    elements.commitPicker.appendChild(empty);
  }

  if (offset + commits.length < total) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'btn btn--secondary commit-picker__more';
    more.dataset.offset = String(offset + commits.length);
    more.textContent = `Load ${Math.min(100, total - offset - commits.length)} more`;
    elements.commitPicker.appendChild(more);
  }
  updateCommitCount();
}

async function loadCommits({ append = false } = {}) {
  if (!isRepositoryReady()) return;
  const offset = append ? state.commitOffset : 0;
  const data = await api.commits(state.selectedRepository.id, {
    search: state.commitSearch,
    limit: 100,
    offset,
  });
  state.commitOffset = data.offset;
  renderCommitPicker(data.commits, data.total, data.offset, append);
}

async function selectRepository(repositoryId) {
  const repository = state.repositories.find((item) => item.id === repositoryId) || null;
  state.selectedRepository = repository;
  setRepositoryStatus(repository);
  state.selectedPaths = { file: '', directory: '' };
  state.selectedCommitLabels.clear();
  state.commitSearch = '';
  state.commitOffset = 0;
  elements.commitSearch.value = '';
  elements.commitPicker.replaceChildren();
  updateCommitCount();

  if (!repository) return;
  if (!isRepositoryReady()) {
    clearDynamicViews();
    setFilterStatus(`${repository.name} is ${repository.status}.`);
    return;
  }

  try {
    setFilterStatus('Loading repository metadata…');
    await Promise.all([loadAuthors(repository.id), loadObjects(repository.id)]);
    updatePathField();
    if (state.commitMode === 'manual') await loadCommits();
    await refreshDashboard();
  } catch (error) {
    clearDynamicViews();
    setError(error.message);
    setFilterStatus('Repository metadata unavailable.');
  }
}

function updateCommitMode() {
  const manual = elements.filterForm.elements['commit-mode'].value === 'manual';
  state.commitMode = manual ? 'manual' : 'time';
  elements.manualFields.classList.toggle('hidden', !manual);
  elements.fromDate.disabled = manual;
  elements.toDate.disabled = manual;
}

async function initHealthBadge() {
  try {
    const data = await fetchJson('/api/health');
    const healthy = data.status === 'ok';
    elements.healthBadge.textContent = healthy ? 'API online' : 'API degraded';
    elements.healthBadge.classList.add(healthy ? 'badge--success' : 'badge--error');
  } catch {
    elements.healthBadge.textContent = 'API offline';
    elements.healthBadge.classList.add('badge--error');
  }
}

elements.filterForm.addEventListener('submit', (event) => {
  event.preventDefault();
  refreshDashboard();
});

elements.repositorySelect.addEventListener('change', (event) => {
  selectRepository(Number(event.target.value));
});

elements.scopeSelect.addEventListener('change', () => {
  updatePathField();
  refreshDashboard();
});

elements.pathSelect.addEventListener('change', (event) => {
  state.selectedPaths[elements.scopeSelect.value] = event.target.value;
  refreshDashboard();
});

async function refreshCommitScopedData() {
  if (state.commitMode === 'manual') await loadCommits();
  await refreshDashboard();
}

elements.authorSelect.addEventListener('change', refreshCommitScopedData);
elements.fromDate.addEventListener('change', refreshDashboard);
elements.toDate.addEventListener('change', refreshDashboard);

elements.filterForm.addEventListener('change', (event) => {
  if (event.target.name !== 'commit-mode') return;
  updateCommitMode();
  refreshCommitScopedData().catch(setError);
});

elements.commitSearch.addEventListener('input', (event) => {
  state.commitSearch = event.target.value;
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => loadCommits().catch(setError), 250);
});

elements.commitPicker.addEventListener('change', (event) => {
  const checkbox = event.target;
  if (checkbox.type !== 'checkbox') return;

  const text = checkbox.closest('.commit-option')?.querySelector('.commit-option__text')?.textContent || '';
  if (checkbox.checked) {
    state.selectedCommitLabels.set(checkbox.value, text.slice(0, 80));
  } else {
    state.selectedCommitLabels.delete(checkbox.value);
  }
  updateCommitCount();
  refreshDashboard();
});

elements.commitPicker.addEventListener('click', (event) => {
  const button = event.target.closest('.commit-picker__more');
  if (!button) return;
  state.commitOffset = Number(button.dataset.offset);
  loadCommits({ append: true }).catch(setError);
});

elements.clearCommits.addEventListener('click', () => {
  state.selectedCommitLabels.clear();
  for (const checkbox of elements.commitPicker.querySelectorAll('input[type="checkbox"]')) {
    checkbox.checked = false;
  }
  updateCommitCount();
  refreshDashboard();
});

elements.resetFilters.addEventListener('click', () => {
  elements.authorSelect.value = '';
  elements.fromDate.value = '';
  elements.toDate.value = '';
  elements.scopeSelect.value = 'repository';
  elements.filterForm.elements['commit-mode'].value = 'time';
  state.selectedCommitLabels.clear();
  state.commitSearch = '';
  state.commitOffset = 0;
  elements.commitSearch.value = '';
  updateCommitMode();
  updatePathField();
  updateCommitCount();
  refreshDashboard();
});

initHealthBadge();
loadRepositoryOptions().catch((error) => {
  setError(error.message);
  setFilterStatus('Unable to load repositories.');
});
