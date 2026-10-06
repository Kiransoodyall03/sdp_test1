'use strict';

/**
 * Authors panel: per-repository manual identity merging. Lists canonical
 * authors and active merges, and creates/removes alias -> canonical mappings.
 * Merges never rewrite ingested commits; they resolve at read time.
 */

import { api } from './api.js';

const els = {
  error: document.getElementById('author-error'),
  status: document.getElementById('author-action-status'),
  repoSelect: document.getElementById('merge-repo-select'),
  sourceSelect: document.getElementById('merge-source'),
  targetSelect: document.getElementById('merge-target'),
  mergeForm: document.getElementById('merge-form'),
  mergeSubmit: document.getElementById('merge-submit'),
  mergeBody: document.getElementById('merge-table-body'),
};

let authors = [];
let onChange = () => {};

function setError(message) {
  els.error.textContent = message || '';
  els.error.classList.toggle('hidden', !message);
}

function setStatus(message) {
  els.status.textContent = message || '';
}

function label(author) {
  return `${author.name} <${author.email}>`;
}

function fillSelect(select, options, placeholder) {
  const fragment = new DocumentFragment();
  if (placeholder) {
    const node = document.createElement('option');
    node.value = '';
    node.textContent = placeholder;
    fragment.appendChild(node);
  }
  for (const option of options) {
    const node = document.createElement('option');
    node.value = String(option.id);
    node.textContent = option.text;
    fragment.appendChild(node);
  }
  select.replaceChildren(fragment);
  select.disabled = !options.length;
}

function renderMerges() {
  const merges = authors.filter((author) => author.isMerged);
  els.mergeBody.replaceChildren();

  if (!merges.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 3;
    cell.className = 'table-note';
    cell.textContent = 'No manual merges yet.';
    row.appendChild(cell);
    els.mergeBody.appendChild(row);
    return;
  }

  const byId = new Map(authors.map((author) => [author.id, author]));
  for (const alias of merges) {
    const target = byId.get(alias.canonicalAuthorId);
    const row = document.createElement('tr');

    const aliasCell = document.createElement('th');
    aliasCell.scope = 'row';
    aliasCell.textContent = label(alias);
    row.appendChild(aliasCell);

    const targetCell = document.createElement('td');
    targetCell.textContent = target ? label(target) : `#${alias.canonicalAuthorId}`;
    row.appendChild(targetCell);

    const actionCell = document.createElement('td');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn--secondary';
    button.textContent = 'Unmerge';
    button.addEventListener('click', () => unmerge(alias.id));
    actionCell.appendChild(button);
    row.appendChild(actionCell);

    els.mergeBody.appendChild(row);
  }
}

function renderSelectors() {
  // Source candidates: authors that are not already merged (aliases).
  const sources = authors
    .filter((author) => !author.isMerged)
    .map((author) => ({ id: author.id, text: label(author) }));
  // Target candidates: canonical authors that do not receive a merge already
  // is enforced server-side; the UI lists every canonical author.
  const targets = authors
    .filter((author) => !author.isMerged)
    .map((author) => ({ id: author.id, text: label(author) }));

  fillSelect(els.sourceSelect, sources, sources.length ? 'Select alias…' : 'No authors');
  fillSelect(els.targetSelect, targets, targets.length ? 'Select canonical…' : 'No authors');
  els.mergeSubmit.disabled = sources.length < 1 || targets.length < 2;
}

async function loadAuthors(repositoryId) {
  if (!repositoryId) {
    authors = [];
    renderSelectors();
    renderMerges();
    return;
  }
  const data = await api.authors(repositoryId);
  authors = data.authors;
  renderSelectors();
  renderMerges();
}

async function refresh() {
  setError(null);
  const repositoryId = els.repoSelect.value;
  try {
    await loadAuthors(repositoryId);
    setStatus(repositoryId ? `${authors.length} authors loaded.` : 'Select a repository.');
  } catch (error) {
    authors = [];
    renderSelectors();
    renderMerges();
    setError(error.message);
  }
}

async function submitMerge(event) {
  event.preventDefault();
  setError(null);
  const repositoryId = els.repoSelect.value;
  const sourceId = Number(els.sourceSelect.value);
  const targetId = Number(els.targetSelect.value);
  if (!repositoryId || !sourceId || !targetId) {
    setError('Select a repository, an alias, and a canonical author.');
    return;
  }
  if (sourceId === targetId) {
    setError('An author cannot be merged into itself.');
    return;
  }
  els.mergeSubmit.disabled = true;
  setStatus('Merging…');
  try {
    await api.mergeAuthor(repositoryId, sourceId, targetId);
    setStatus('Merge created.');
    await refresh();
    onChange();
  } catch (error) {
    setStatus('');
    setError(error.message);
  } finally {
    els.mergeSubmit.disabled = false;
  }
}

async function unmerge(sourceId) {
  setError(null);
  const repositoryId = els.repoSelect.value;
  setStatus('Removing merge…');
  try {
    await api.unmergeAuthor(repositoryId, sourceId);
    setStatus('Merge removed.');
    await refresh();
    onChange();
  } catch (error) {
    setStatus('');
    setError(error.message);
  }
}

export function populateRepositories(repositories) {
  const previous = els.repoSelect.value;
  const ready = repositories.filter((repo) => repo.status === 'ready' && !repo.archivedAt);
  fillSelect(
    els.repoSelect,
    ready.map((repo) => ({ id: repo.id, text: repo.name })),
    ready.length ? 'Select repository…' : 'No ready repositories'
  );
  if (previous && ready.some((repo) => String(repo.id) === previous)) {
    els.repoSelect.value = previous;
  }
}

export function activateAuthorsView() {
  refresh();
}

export function initAuthorsView({ authorsChanged }) {
  onChange = authorsChanged || (() => {});
  els.repoSelect.addEventListener('change', refresh);
  els.mergeForm.addEventListener('submit', submitMerge);
}
