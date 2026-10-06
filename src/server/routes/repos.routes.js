'use strict';

/**
 * Repository routes. Handlers delegate directly to the controller; no git or
 * persistence business logic belongs in this layer.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const config = require('../../../config');
const { createReposController } = require('../controllers/repos.controller');
const { createMetricsController } = require('../controllers/metrics.controller');
const { createAuthorsController } = require('../controllers/authors.controller');

function createUploadMiddleware(options) {
  const uploadTmpDir = options.uploadTmpDir || config.paths.uploadTmpDir;
  fs.mkdirSync(uploadTmpDir, { recursive: true });

  return multer({
    storage: multer.diskStorage({
      destination: uploadTmpDir,
      filename(req, file, done) {
        done(null, `${crypto.randomUUID()}.zip`);
      },
    }),
    limits: {
      fileSize: config.limits.maxUploadBytes,
      files: 1,
      fields: 4,
      parts: 5,
    },
    fileFilter(req, file, done) {
      if (path.extname(file.originalname).toLowerCase() !== '.zip') {
        const error = new Error('repository upload must be a .zip file');
        error.status = 400;
        done(error);
        return;
      }
      done(null, true);
    },
  }).single('repository');
}

function uploadErrorBoundary(upload) {
  return (req, res, next) => {
    upload(req, res, (error) => {
      if (!error) return next();
      error.status = error.code === 'LIMIT_FILE_SIZE' ? 413 : error.status || 400;
      return next(error);
    });
  };
}

function createReposRouter(options = {}) {
  const router = express.Router();
  const controller = createReposController(options);
  const metricsController = createMetricsController(options);
  const authorsController = createAuthorsController(options);

  // GET /api/repos?includeArchived=true
  router.get('/', controller.list);

  // POST /api/repos { "url": "https://host/owner/repo.git", "name"?: "..." }
  router.post('/', controller.createFromClone);

  // POST /api/repos/upload multipart: repository=<zip>, name=<optional>
  router.post(
    '/upload',
    uploadErrorBoundary(createUploadMiddleware(options)),
    controller.createFromZip
  );

  router.get('/:repoId/commits', controller.listCommits);
  router.get('/:repoId/metrics', metricsController.get);
  router.post('/:repoId/metrics/batch', metricsController.batch);
  router.get('/:repoId/objects', metricsController.listObjects);
  router.get('/:repoId/authors/metrics', authorsController.metrics);
  router.get('/:repoId/authors', authorsController.list);
  router.post('/:repoId/author-merges', authorsController.merge);
  router.delete(
    '/:repoId/author-merges/:sourceAuthorId',
    authorsController.unmerge
  );

  // Repository detail and lifecycle (archive / restore / delete).
  router.get('/:repoId', controller.get);
  router.patch('/:repoId/archive', controller.archive);
  router.patch('/:repoId/restore', controller.restore);
  router.delete('/:repoId', controller.remove);

  return router;
}

module.exports = { createReposRouter };
