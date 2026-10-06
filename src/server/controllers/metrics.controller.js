'use strict';

/** HTTP translation for metric and object-list queries. */

const { getDatabase } = require('../db/connection');
const { getMetrics, listObjects } = require('../services/metrics.service');

function createMetricsController(options = {}) {
  const resolveDatabase = () => options.database || getDatabase();

  return {
    get(req, res, next) {
      try {
        const report = getMetrics(
          resolveDatabase(),
          req.params.repoId,
          req.query
        );
        res.json(report);
      } catch (error) {
        next(error);
      }
    },

    listObjects(req, res, next) {
      try {
        const result = listObjects(
          resolveDatabase(),
          req.params.repoId,
          req.query.type
        );
        res.json(result);
      } catch (error) {
        next(error);
      }
    },
  };
}

module.exports = { createMetricsController };
