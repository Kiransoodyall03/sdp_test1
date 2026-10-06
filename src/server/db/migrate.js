'use strict';

/**
 * Versioned database migration runner.
 *
 * Version 1 is the committed schema.sql. Future schema changes are appended as
 * explicit migrations rather than silently altering the shipped schema.
 */

const fs = require('fs');
const path = require('path');

const CURRENT_SCHEMA_VERSION = 1;
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

function getSchemaVersion(db) {
  return db.pragma('user_version', { simple: true });
}

function migrate(db) {
  const version = getSchemaVersion(db);

  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${version} is newer than supported version ${CURRENT_SCHEMA_VERSION}`
    );
  }

  if (version === 0) {
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(schema);
      db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return getSchemaVersion(db);
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  getSchemaVersion,
  migrate,
};
