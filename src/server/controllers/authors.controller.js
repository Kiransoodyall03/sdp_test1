'use strict';

/** HTTP translation for author listing and manual merge operations. */

const { getDatabase } = require('../db/connection');
const {
  listAuthors,
  createAuthorMerge,
  deleteAuthorMerge,
} = require('../services/authors.service');
const { getAuthorMetrics } = require('../services/metrics.service');

function createAuthorsController(options = {}) {
  const resolveDatabase = () => options.database || getDatabase();

  return {
    list(req, res, next) {
      try {
        res.json(listAuthors(resolveDatabase(), req.params.repoId));
      } catch (error) {
        next(error);
      }
    },

    metrics(req, res, next) {
      try {
        res.json(
          getAuthorMetrics(resolveDatabase(), req.params.repoId, req.query)
        );
      } catch (error) {
        next(error);
      }
    },

    merge(req, res, next) {
      try {
        const result = createAuthorMerge(
          resolveDatabase(),
          req.params.repoId,
          req.body && req.body.sourceAuthorId,
          req.body && req.body.targetAuthorId
        );
        res.status(result.created ? 201 : 200).json(result);
      } catch (error) {
        next(error);
      }
    },

    unmerge(req, res, next) {
      try {
        deleteAuthorMerge(
          resolveDatabase(),
          req.params.repoId,
          req.params.sourceAuthorId
        );
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  };
}

module.exports = { createAuthorsController };
