'use strict';

/** Secure zip extraction and repository ingestion. */

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const config = require('../../../config');
const git = require('./git.service');
const {
  ValidationError,
  validateName,
  ingestRepository,
} = require('./ingestion.service');

class ZipValidationError extends ValidationError {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ZipValidationError';
    this.status = status;
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function validateEntryName(entryName, extractionRoot, limits) {
  const portable = entryName.replace(/\\/g, '/');
  if (
    !portable ||
    portable.includes('\0') ||
    portable.startsWith('/') ||
    /^[A-Za-z]:\//.test(portable)
  ) {
    throw new ZipValidationError(`Unsafe zip entry path: ${entryName}`);
  }

  const segments = portable.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '..')) {
    throw new ZipValidationError(`Unsafe zip entry path: ${entryName}`);
  }
  if (segments.length > limits.maxZipDepth) {
    throw new ZipValidationError('Zip entry exceeds the maximum directory depth', 413);
  }

  const target = path.resolve(extractionRoot, ...segments);
  if (!isWithin(extractionRoot, target)) {
    throw new ZipValidationError(`Unsafe zip entry path: ${entryName}`);
  }
  return target;
}

function isSymbolicLink(entry) {
  // The Unix file type is stored in the high 16 bits of the external attrs;
  // header.fileAttr exposes permission bits only in adm-zip.
  const mode = (entry.attr >>> 16) & 0xffff;
  return (mode & 0o170000) === 0o120000;
}

function verifyZipSignature(filename) {
  const descriptor = fs.openSync(filename, 'r');
  try {
    const signature = Buffer.alloc(4);
    const bytesRead = fs.readSync(descriptor, signature, 0, 4, 0);
    if (
      bytesRead !== 4 ||
      signature[0] !== 0x50 ||
      signature[1] !== 0x4b ||
      !(
        (signature[2] === 0x03 && signature[3] === 0x04) ||
        (signature[2] === 0x05 && signature[3] === 0x06) ||
        (signature[2] === 0x07 && signature[3] === 0x08)
      )
    ) {
      throw new ZipValidationError('Uploaded file is not a valid zip archive');
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function extractZipSafely(filename, extractionRoot, limits = config.limits) {
  verifyZipSignature(filename);
  fs.mkdirSync(extractionRoot, { recursive: true });

  let archive;
  try {
    archive = new AdmZip(filename);
  } catch (error) {
    throw new ZipValidationError(`Unable to read zip archive: ${error.message}`);
  }

  const entries = archive.getEntries();
  if (!entries.length) throw new ZipValidationError('Zip archive is empty');
  if (entries.length > limits.maxZipEntries) {
    throw new ZipValidationError('Zip archive contains too many entries', 413);
  }

  const seenPaths = new Set();
  let declaredBytes = 0;
  for (const entry of entries) {
    const target = validateEntryName(entry.entryName, extractionRoot, limits);
    const key = path.relative(extractionRoot, target);
    if (seenPaths.has(key)) {
      throw new ZipValidationError(`Zip archive contains a duplicate path: ${key}`);
    }
    seenPaths.add(key);

    if (isSymbolicLink(entry)) {
      throw new ZipValidationError(`Symbolic links are not allowed in zip uploads: ${key}`);
    }
    if (entry.header.encrypted) {
      throw new ZipValidationError('Encrypted zip entries are not supported');
    }

    const size = Number(entry.header.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new ZipValidationError(`Invalid uncompressed size for zip entry: ${key}`);
    }
    declaredBytes += size;
    if (declaredBytes > limits.maxExtractedBytes) {
      throw new ZipValidationError('Extracted zip exceeds the configured size limit', 413);
    }
  }

  let extractedBytes = 0;
  for (const entry of entries) {
    const target = validateEntryName(entry.entryName, extractionRoot, limits);
    if (entry.isDirectory) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }

    const data = entry.getData();
    extractedBytes += data.length;
    if (extractedBytes > limits.maxExtractedBytes) {
      throw new ZipValidationError('Extracted zip exceeds the configured size limit', 413);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data, { flag: 'wx', mode: 0o600 });
  }

  return { entryCount: entries.length, extractedBytes };
}

function findGitMarkers(extractionRoot) {
  const markers = [];
  const pending = [extractionRoot];

  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.name === '.git' && (entry.isDirectory() || entry.isFile())) {
        markers.push(candidate);
        if (entry.isDirectory()) continue;
      }
      if (entry.isDirectory()) pending.push(candidate);
    }
  }
  return markers;
}

function validateGitFile(markerPath, extractionRoot) {
  const stat = fs.statSync(markerPath);
  if (stat.size > 4096) {
    throw new ZipValidationError('.git pointer file is too large');
  }

  const content = fs.readFileSync(markerPath, 'utf8').trim();
  const match = /^gitdir:\s*(.+)$/i.exec(content);
  if (!match) throw new ZipValidationError('Invalid .git pointer file');
  if (path.isAbsolute(match[1])) {
    throw new ZipValidationError('.git pointer must be relative within the archive');
  }

  const gitDirectory = path.resolve(path.dirname(markerPath), match[1]);
  if (!isWithin(extractionRoot, gitDirectory)) {
    throw new ZipValidationError('.git pointer escapes the uploaded archive');
  }
  if (!fs.existsSync(gitDirectory) || !fs.statSync(gitDirectory).isDirectory()) {
    throw new ZipValidationError('.git pointer target is missing from the archive');
  }
}

function locateRepositoryRoot(extractionRoot) {
  const markers = findGitMarkers(extractionRoot);
  if (!markers.length) {
    throw new ZipValidationError('Zip must contain a .git directory or file');
  }

  const ranked = markers
    .map((marker) => ({
      marker,
      root: path.dirname(marker),
      depth: path.relative(extractionRoot, marker).split(path.sep).length,
    }))
    .sort((left, right) => left.depth - right.depth);

  const shallowest = ranked.filter((candidate) => candidate.depth === ranked[0].depth);
  if (shallowest.length > 1) {
    throw new ZipValidationError('Zip contains multiple top-level repositories');
  }

  const selected = shallowest[0];
  if (fs.statSync(selected.marker).isFile()) {
    validateGitFile(selected.marker, extractionRoot);
  }
  return selected.root;
}

function defaultZipName(originalName) {
  return path.basename(originalName || 'Repository').replace(/\.zip$/i, '') || 'Repository';
}

async function ingestZip(options) {
  const {
    db,
    uploadPath,
    originalName,
    name,
    uploadTmpDir = config.paths.uploadTmpDir,
    repoStoreDir = config.paths.repoStoreDir,
    gitService = git,
    gitOptions = {},
    limits = config.limits,
  } = options;

  if (!uploadPath || !fs.existsSync(uploadPath)) {
    throw new ZipValidationError('repository zip file is required');
  }

  let extractionRoot = null;
  try {
    const sourceOrigin = path.basename(originalName || 'repository.zip');
    const repositoryName = validateName(
      name ?? defaultZipName(sourceOrigin),
      sourceOrigin
    );
    fs.mkdirSync(uploadTmpDir, { recursive: true });
    extractionRoot = fs.mkdtempSync(path.join(uploadTmpDir, 'extract-'));

    extractZipSafely(uploadPath, extractionRoot, limits);
    const repositoryRoot = locateRepositoryRoot(extractionRoot);

    return await ingestRepository({
      db,
      sourceType: 'zip',
      sourceOrigin,
      repositoryName,
      repoStoreDir,
      gitService,
      gitOptions,
      prepareStorage: (storagePath) =>
        gitService.cloneBare(repositoryRoot, storagePath, gitOptions),
    });
  } finally {
    if (extractionRoot) {
      fs.rmSync(extractionRoot, { recursive: true, force: true });
    }
    fs.rmSync(uploadPath, { force: true });
  }
}

module.exports = {
  ZipValidationError,
  extractZipSafely,
  locateRepositoryRoot,
  ingestZip,
};
