'use strict';

/**
 * SQLite connection lifecycle.
 *
 * openDatabase() is dependency-injected for tests (`:memory:` or a temp file).
 * getDatabase() owns the process-wide application connection. Every connection
 * enables foreign keys and runs committed migrations before it is returned.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../../../config');
const { migrate } = require('./migrate');

let applicationDatabase = null;

function ensureParentDirectory(filename) {
  if (filename === ':memory:') return;
  fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
}

function openDatabase(filename = config.paths.db) {
  ensureParentDirectory(filename);

  const db = new Database(filename, {
    timeout: 5000,
    fileMustExist: false,
  });

  try {
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');

    // WAL improves concurrent dashboard reads while ingestion is writing.
    // In-memory SQLite does not support WAL and remains in memory journal mode.
    if (filename !== ':memory:') {
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
    }

    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function getDatabase() {
  if (!applicationDatabase || !applicationDatabase.open) {
    applicationDatabase = openDatabase();
  }
  return applicationDatabase;
}

function closeDatabase() {
  if (applicationDatabase && applicationDatabase.open) {
    applicationDatabase.close();
  }
  applicationDatabase = null;
}

module.exports = {
  openDatabase,
  getDatabase,
  closeDatabase,
};
