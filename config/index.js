'use strict';

/**
 * Centralised application configuration.
 *
 * Reads optional `.env` (no external dependency) and environment variables,
 * applies sensible defaults, and exports a single frozen config object.
 * Relative paths are resolved from the project root.
 */

const fs = require('fs');
const path = require('path');

// config/index.js lives one level below the project root.
const ROOT_DIR = path.resolve(__dirname, '..');

/**
 * Minimal .env loader. Existing process.env values always win, so real
 * environment variables (e.g. in CI or production) override the file.
 * @param {string} file Name of the env file at the project root.
 */
function loadDotEnv(file) {
  const envPath = path.join(ROOT_DIR, file);
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv('.env');

function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function resolveFromRoot(p) {
  return path.isAbsolute(p) ? p : path.join(ROOT_DIR, p);
}

const config = {
  rootDir: ROOT_DIR,
  env: process.env.NODE_ENV || 'development',
  port: toInt(process.env.PORT, 3000),
  paths: {
    dataDir: resolveFromRoot(process.env.DATA_DIR || 'data'),
    db: resolveFromRoot(process.env.DB_PATH || path.join('data', 'rat.sqlite')),
    uploadTmpDir: resolveFromRoot(
      process.env.UPLOAD_TMP_DIR || path.join('data', 'tmp', 'uploads')
    ),
    repoStoreDir: resolveFromRoot(
      process.env.REPO_STORE_DIR || path.join('data', 'repos')
    ),
    clientDir: path.join(ROOT_DIR, 'src', 'client'),
    stylesDir: path.join(ROOT_DIR, 'src', 'styles'),
  },
  limits: {
    maxUploadBytes: toInt(process.env.MAX_UPLOAD_MB, 200) * 1024 * 1024,
    gitTimeoutMs: toInt(process.env.GIT_TIMEOUT_MS, 120000),
    gitRenameThreshold: process.env.GIT_RENAME_THRESHOLD || '50%',
  },
};

module.exports = Object.freeze(config);
