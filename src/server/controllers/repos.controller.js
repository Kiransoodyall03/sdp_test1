'use strict';

/**
 * Repository HTTP controller. It translates request/response concerns only;
 * clone validation and all ingestion business logic live in the service.
 */

const config = require('../../../config');
const { getDatabase } = require('../db/connection');
const { ingestClone } = require('../services/ingestion.service');
const { ingestZip } = require('../services/zip.service');
const {
  listRepositories,
  listCommits,
} = require('../services/repositories.service');

function createReposController(options = {}) {
  const {
    database,
    repoStoreDir = config.paths.repoStoreDir,
    gitService,
    gitOptions,
  } = options;

  return {
    list(req, res, next) {
      try {
        res.json(
          listRepositories(database || getDatabase(), {
            includeArchived: req.query.includeArchived,
          })
        );
      } catch (error) {
        next(error);
      }
    },

    listCommits(req, res, next) {
      try {
        res.json(listCommits(database || getDatabase(), req.params.repoId, req.query));
      } catch (error) {
        next(error);
      }
    },

    async createFromClone(req, res, next) {
      try {
        const repository = await ingestClone({
          db: database || getDatabase(),
          url: req.body && req.body.url,
          name: req.body && req.body.name,
          repoStoreDir,
          gitService,
          gitOptions,
        });
        res.status(201).json({ repository });
      } catch (error) {
        next(error);
      }
    },

    async createFromZip(req, res, next) {
      try {
        const repository = await ingestZip({
          db: database || getDatabase(),
          uploadPath: req.file && req.file.path,
          originalName: req.file && req.file.originalname,
          name: req.body && req.body.name,
          uploadTmpDir: options.uploadTmpDir,
          repoStoreDir,
          gitService,
          gitOptions,
        });
        res.status(201).json({ repository });
      } catch (error) {
        next(error);
      }
    },
  };
}

module.exports = { createReposController };
