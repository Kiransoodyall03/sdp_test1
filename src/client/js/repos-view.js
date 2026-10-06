'use strict';

/**
 * Repositories panel: list, add (clone URL / zip upload), archive, restore and
 * delete. Kept separate from the dashboard controller so each view owns its
 * own DOM and state.
 */

import { api } from './api.js';

const els = {
  error: document.getElementById('repo-error'),
  status: document.getElementById('repo-action-status'),
  tableBody: document.getElementById('repo-table-body'),
  showArchived: document.getElementById('show-archived'),
  cloneForm: document.getElementById('clone-form'),
  cloneUrl: document.getElementById('clone-url'),
  cloneName: document.getElementById('clone-name'),
  cloneSubmit: document.getElementById('clone-submit'),
  uploadForm: document.getElementById('upload-form'),
  uploadFile: document.getElementById('upload-file'),
  uploadName: document.getElementById('upload-name'),
  uploadSubmit: document.getElementById('upload-submit'),
};

let onChange = () => {};
let lastRepositories = [];

function setError(message) {
  els.error.textContent = message || '';
  els.error.classList.toggle('hidden', !message);
}

function setStatus(message) {
  els.status.textContent = message || '';
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toISOString().slice(0, 10);
}

function statusBadge(repo) {
  const badge = document.createElement('span');
  badge.className = 'badge';
  if (repo.status === 'ready') badge.classList.add('badge--success');
  else if (repo.status === 'error') badge.classList.add('badge--error');
  else badge.classList.add('badge--warning');
  badge.textContent = repo.archivedAt ? 'archived' : repo.status;
  return badge;
}

function actionButton(label, className, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `btn ${className}`;
  button.textContent = label;
  button.addEventListener('click', handler);
  return button;
}

function renderTable(repositories) {
  els.tableBody.replaceChildren();

  if (!repositories.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 7;
    cell.className = 'table-note';
    cell.textContent = 'No repositories yet. Add one above.';
    row.appendChild(cell);
    els.tableBody.appendChild(row);
    return;
  }

  for (const repo of repositories) {
    const row = document.createElement('tr');

    const name = document.createElement('th');
    name.scope = 'row';
    name.textContent = repo.name;
    row.appendChild(name);

    const source = document.createElement('td');
    source.textContent = repo.sourceType === 'clone' ? repo.sourceOrigin : 'zip upload';
    source.className = 'mono source-cell';
    row.appendChild(source);

    const status = document.createElement('td');
    status.appendChild(statusBadge(repo));
    row.appendChild(status);

    const commits = document.createElement('td');
    commits.className = 'num';
    commits.textContent = repo.commitCount;
    row.appendChild(commits);

    const authors = document.createElement('td');
    authors.className = 'num';
    authors.textContent = repo.authorCount;
    row.appendChild(authors);

    const created = document.createElement('td');
    created.textContent = formatDate(repo.createdAt);
    row.appendChild(created);

    const actions = document.createElement('td');
    actions.className = 'repo-actions';
    if (!repo.archivedAt) {
      actions.appendChild(
        actionButton('Archive', 'btn--secondary', () => runAction(repo.id, 'archive'))
      );
    } else {
      actions.appendChild(
        actionButton('Restore', 'btn--secondary', () => runAction(repo.id, 'restore'))
      );
      actions.appendChild(
        actionButton('Delete', 'btn--danger', () => {
          if (window.confirm(`Permanently delete "${repo.name}"? This cannot be undone.`)) {
            runAction(repo.id, 'delete');
          }
        })
      );
    }
    row.appendChild(actions);

    els.tableBody.appendChild(row);
  }
}

async function refresh() {
  setError(null);
  try {
    const data = await api.repositories(els.showArchived.checked);
    lastRepositories = data.repositories;
    renderTable(lastRepositories);
  } catch (error) {
    setError(error.message);
  }
}

async function runAction(repoId, action) {
  setError(null);
  const labels = { archive: 'Archiving', restore: 'Restoring', delete: 'Deleting' };
  setStatus(`${labels[action]} repository…`);
  try {
    if (action === 'archive') await api.archive(repoId);
    else if (action === 'restore') await api.restore(repoId);
    else if (action === 'delete') await api.deleteRepo(repoId);
    setStatus(`${labels[action].replace(/ing$/, 'ed')} repository.`);
    await refresh();
    onChange();
  } catch (error) {
    setStatus('');
    setError(error.message);
  }
}

async function submitClone(event) {
  event.preventDefault();
  setError(null);
  const url = els.cloneUrl.value.trim();
  if (!url) {
    setError('A repository URL is required.');
    return;
  }
  els.cloneSubmit.disabled = true;
  setStatus('Cloning and ingesting… this can take a while for large repositories.');
  try {
    const result = await api.createClone(url, els.cloneName.value.trim());
    setStatus(`Ingested "${result.repository.name}" (${result.repository.commitCount} commits).`);
    els.cloneForm.reset();
    await refresh();
    onChange();
  } catch (error) {
    setStatus('');
    setError(error.message);
  } finally {
    els.cloneSubmit.disabled = false;
  }
}

async function submitUpload(event) {
  event.preventDefault();
  setError(null);
  const file = els.uploadFile.files && els.uploadFile.files[0];
  if (!file) {
    setError('Choose a .zip file to upload.');
    return;
  }
  const formData = new FormData();
  formData.append('repository', file);
  const name = els.uploadName.value.trim();
  if (name) formData.append('name', name);

  els.uploadSubmit.disabled = true;
  setStatus('Uploading and ingesting…');
  try {
    const result = await api.createZip(formData);
    setStatus(`Ingested "${result.repository.name}" (${result.repository.commitCount} commits).`);
    els.uploadForm.reset();
    await refresh();
    onChange();
  } catch (error) {
    setStatus('');
    setError(error.message);
  } finally {
    els.uploadSubmit.disabled = false;
  }
}

export function initRepositoriesView({ repositoriesChanged }) {
  onChange = repositoriesChanged || (() => {});
  els.showArchived.addEventListener('change', refresh);
  els.cloneForm.addEventListener('submit', submitClone);
  els.uploadForm.addEventListener('submit', submitUpload);
}

export function activateRepositoriesView() {
  refresh();
}
