'use strict';

/** Deterministic local git repository fixture; never uses the network. */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function runGit(repositoryPath, args, env = {}) {
  const result = spawnSync('git', ['-C', repositoryPath, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      ...env,
    },
  });

  if (result.status !== 0) {
    throw new Error(
      `Fixture git command failed: git ${args.join(' ')}\n${result.stderr}`
    );
  }
  return result.stdout.trim();
}

function commit(repositoryPath, message, identity, timestamp) {
  const env = {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
    GIT_AUTHOR_DATE: timestamp,
    GIT_COMMITTER_DATE: timestamp,
  };
  runGit(repositoryPath, ['commit', '-q', '-m', message], env);
  return runGit(repositoryPath, ['rev-parse', 'HEAD']);
}

function write(repositoryPath, relativePath, content) {
  const filename = path.join(repositoryPath, relativePath);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content);
}

function createHistoryFixture(repositoryPath) {
  fs.mkdirSync(repositoryPath, { recursive: true });
  runGit(repositoryPath, ['init', '-q', '-b', 'main']);
  runGit(repositoryPath, ['config', 'user.name', 'Fixture Committer']);
  runGit(repositoryPath, ['config', 'user.email', 'fixture@example.test']);

  const alias = { name: 'Alias Developer', email: 'alias@example.test' };
  const canonical = {
    name: 'Canonical Developer',
    email: 'canonical@example.test',
  };
  const second = { name: 'Second Developer', email: 'second@example.test' };
  const feature = { name: 'Feature Developer', email: 'feature@example.test' };

  write(
    repositoryPath,
    '.mailmap',
    `${canonical.name} <${canonical.email}> ${alias.name} <${alias.email}>\n`
  );
  write(
    repositoryPath,
    'src/app.js',
    Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join('\n') +
      '\n'
  );
  write(repositoryPath, 'assets/logo.bin', Buffer.from([0, 1, 2, 0, 255, 10]));
  runGit(repositoryPath, ['add', '.']);
  const initialHash = commit(
    repositoryPath,
    'initial files',
    alias,
    '2024-01-01T00:00:00Z'
  );

  runGit(repositoryPath, ['mv', 'src/app.js', 'src/main.js']);
  const renameHash = commit(
    repositoryPath,
    'rename application',
    second,
    '2024-01-02T00:00:00Z'
  );

  runGit(repositoryPath, ['checkout', '-q', '-b', 'feature']);
  write(repositoryPath, 'feature.txt', 'feature\n');
  runGit(repositoryPath, ['add', 'feature.txt']);
  const featureHash = commit(
    repositoryPath,
    'feature work',
    feature,
    '2024-01-03T00:00:00Z'
  );

  runGit(repositoryPath, ['checkout', '-q', 'main']);
  write(
    repositoryPath,
    'src/main.js',
    ['LINE 1', ...Array.from({ length: 9 }, (_, index) => `line ${index + 2}`), 'line 11'].join(
      '\n'
    ) + '\n'
  );
  runGit(repositoryPath, ['add', 'src/main.js']);
  const modifyHash = commit(
    repositoryPath,
    'modify application',
    second,
    '2024-01-04T00:00:00Z'
  );

  const mergeEnv = {
    GIT_AUTHOR_NAME: second.name,
    GIT_AUTHOR_EMAIL: second.email,
    GIT_COMMITTER_NAME: second.name,
    GIT_COMMITTER_EMAIL: second.email,
    GIT_AUTHOR_DATE: '2024-01-05T00:00:00Z',
    GIT_COMMITTER_DATE: '2024-01-05T00:00:00Z',
  };
  runGit(repositoryPath, ['merge', '-q', '--no-ff', 'feature', '-m', 'merge feature'], mergeEnv);
  const mergeHash = runGit(repositoryPath, ['rev-parse', 'HEAD']);

  runGit(repositoryPath, ['rm', '-q', 'src/main.js']);
  const deleteHash = commit(
    repositoryPath,
    'delete application',
    second,
    '2024-01-06T00:00:00Z'
  );

  return {
    initialHash,
    renameHash,
    featureHash,
    modifyHash,
    mergeHash,
    deleteHash,
    canonical,
    second,
    feature,
  };
}

module.exports = { createHistoryFixture, runGit };
