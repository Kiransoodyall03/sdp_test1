'use strict';

/**
 * Git process and history-streaming service.
 *
 * Commands are spawned with argument arrays (never a shell), prompts are
 * disabled, and every process has a timeout. History is NUL-delimited so paths
 * containing spaces, tabs or newlines do not break record boundaries.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../../../config');

const COMMIT_MARKER = '\x1eRAT_COMMIT_V1\x1e';
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_CAPTURE_BYTES = 1024 * 1024;

class GitCommandError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'GitCommandError';
    this.code = details.code;
    this.signal = details.signal;
    this.timedOut = Boolean(details.timedOut);
    this.stderr = details.stderr || '';
  }
}

function appendLimited(current, chunk, limit) {
  const next = current + chunk.toString('utf8');
  return next.length <= limit ? next : next.slice(next.length - limit);
}

function runGit(args, options = {}) {
  const {
    cwd,
    timeoutMs = config.limits.gitTimeoutMs,
    onStdout,
    maxCaptureBytes = MAX_CAPTURE_BYTES,
  } = options;

  return new Promise((resolve, reject) => {
    let stderr = '';
    let stdout = '';
    let stdoutBytes = 0;
    let callbackError = null;
    let timedOut = false;
    let settled = false;

    const child = spawn('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        LC_ALL: 'C.UTF-8',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000).unref();
    }, timeoutMs);
    timer.unref();

    child.stdout.on('data', (chunk) => {
      if (callbackError) return;
      try {
        if (onStdout) {
          onStdout(chunk);
        } else {
          stdoutBytes += chunk.length;
          if (stdoutBytes > maxCaptureBytes) {
            throw new Error(`git output exceeded ${maxCaptureBytes} bytes`);
          }
          stdout += chunk.toString('utf8');
        }
      } catch (error) {
        callbackError = error;
        child.kill('SIGTERM');
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr = appendLimited(stderr, chunk, MAX_STDERR_BYTES);
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new GitCommandError(`Unable to start git: ${error.message}`, {
          stderr,
        })
      );
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (callbackError) {
        reject(callbackError);
        return;
      }
      if (timedOut) {
        reject(
          new GitCommandError(`git command timed out after ${timeoutMs} ms`, {
            code,
            signal,
            timedOut: true,
            stderr,
          })
        );
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim();
        reject(
          new GitCommandError(
            detail ? `git failed: ${detail}` : `git exited with code ${code}`,
            { code, signal, stderr }
          )
        );
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

/** Deep clone: deliberately no --depth or --single-branch. */
async function cloneBare(sourceUrl, destination, options = {}) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  await runGit(['clone', '--bare', '--quiet', '--', sourceUrl, destination], options);
}

async function resolveHead(repositoryPath, options = {}) {
  const result = await runGit(
    ['-C', repositoryPath, 'rev-parse', '--verify', 'HEAD'],
    options
  );
  return result.stdout.trim();
}

function parseInteger(value, label) {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid ${label} in git output: ${JSON.stringify(value)}`);
  }
  return Number.parseInt(value, 10);
}

/**
 * Incremental parser for the NUL-delimited git log format emitted below.
 * onCommit is called as soon as metadata arrives and may return a context
 * (the DB commit id). onChange receives each file fact with that context.
 */
class GitLogParser {
  constructor({ onCommit, onChange }) {
    this.onCommit = onCommit;
    this.onChange = onChange;
    this.tail = Buffer.alloc(0);
    this.metadata = null;
    this.hasCurrentCommit = false;
    this.currentContext = null;
    this.pendingRename = null;
  }

  push(chunk) {
    const data = this.tail.length ? Buffer.concat([this.tail, chunk]) : chunk;
    let start = 0;
    let separator;

    while ((separator = data.indexOf(0, start)) !== -1) {
      this.consume(data.subarray(start, separator).toString('utf8'));
      start = separator + 1;
    }
    this.tail = data.subarray(start);
  }

  consume(token) {
    if (this.metadata) {
      this.metadata.push(token);
      if (this.metadata.length === 6) this.finishMetadata();
      return;
    }

    if (this.pendingRename) {
      if (this.pendingRename.oldPath === null) {
        this.pendingRename.oldPath = token;
      } else {
        const change = {
          ...this.pendingRename,
          path: token,
          isRename: true,
        };
        delete change.oldPathPending;
        this.pendingRename = null;
        this.onChange(change, this.currentContext);
      }
      return;
    }

    if (token === COMMIT_MARKER) {
      this.metadata = [];
      return;
    }

    if (!this.hasCurrentCommit) {
      if (token.trim() === '') return;
      throw new Error('File change appeared before commit metadata');
    }

    const record = token.replace(/^\n+/, '');
    if (!record) return;

    const firstTab = record.indexOf('\t');
    const secondTab = record.indexOf('\t', firstTab + 1);
    if (firstTab < 1 || secondTab < 0) {
      throw new Error(`Invalid numstat record: ${JSON.stringify(record)}`);
    }

    const addedText = record.slice(0, firstTab);
    const removedText = record.slice(firstTab + 1, secondTab);
    const filePath = record.slice(secondTab + 1);
    const isBinary = addedText === '-' || removedText === '-';
    const base = {
      added: isBinary ? 0 : parseInteger(addedText, 'added-line count'),
      removed: isBinary ? 0 : parseInteger(removedText, 'removed-line count'),
      isBinary,
      isRename: false,
      oldPath: null,
    };

    // With --numstat -z, a rename has an empty path in this token, followed
    // by separate NUL-delimited old-path and new-path tokens.
    if (filePath === '') {
      this.pendingRename = { ...base, oldPath: null };
      return;
    }

    this.onChange({ ...base, path: filePath }, this.currentContext);
  }

  finishMetadata() {
    const [hash, parents, authorName, authorEmail, dateText, subject] =
      this.metadata;
    this.metadata = null;

    const parentList = parents.trim() ? parents.trim().split(/\s+/) : [];
    if (parentList.length > 1) {
      throw new Error(`Merge commit unexpectedly present in history: ${hash}`);
    }

    this.currentContext = this.onCommit({
      hash,
      parentHash: parentList[0] || null,
      authorName: authorName.trim() || 'Unknown Author',
      authorEmail: authorEmail.trim() || 'unknown@invalid',
      committerDate: parseInteger(dateText, 'committer date'),
      subject,
    });
    this.hasCurrentCommit = true;
  }

  finish() {
    if (this.tail.length) {
      throw new Error('Incomplete NUL-delimited token at end of git output');
    }
    if (this.metadata) {
      throw new Error('Incomplete commit metadata at end of git output');
    }
    if (this.pendingRename) {
      throw new Error('Incomplete rename record at end of git output');
    }
  }
}

async function streamHistory(repositoryPath, handlers, options = {}) {
  const renameThreshold = options.renameThreshold || config.limits.gitRenameThreshold;
  const thresholdMatch = /^(\d{1,3})%$/.exec(renameThreshold);
  if (
    !thresholdMatch ||
    Number.parseInt(thresholdMatch[1], 10) < 1 ||
    Number.parseInt(thresholdMatch[1], 10) > 100
  ) {
    throw new Error(`Invalid git rename threshold: ${renameThreshold}`);
  }

  const parser = new GitLogParser(handlers);
  const format = `${COMMIT_MARKER}%x00%H%x00%P%x00%aN%x00%aE%x00%ct%x00%s%x00`;
  const args = [
    '-C',
    repositoryPath,
    'log',
    'HEAD',
    '--no-merges',
    '--use-mailmap',
    '--root',
    '--no-ext-diff',
    `--find-renames=${renameThreshold}`,
    '--numstat',
    '-z',
    `--format=${format}`,
  ];

  await runGit(args, {
    ...options,
    onStdout: (chunk) => parser.push(chunk),
  });
  parser.finish();
}

module.exports = {
  COMMIT_MARKER,
  GitCommandError,
  GitLogParser,
  runGit,
  cloneBare,
  resolveHead,
  streamHistory,
};
