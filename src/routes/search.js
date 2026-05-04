const express = require('express');
const authMiddleware = require('../middleware/auth');
const rateLimitMiddleware = require('../middleware/rateLimit');
const stateAccessMiddleware = require('../middleware/stateAccess');
const SearchController = require('../controllers/searchController');

const router = express.Router();

/**
 * GET /v1/search/villages
 * Production Endpoint Pipeline:
 * 1. Auth (API Key + Secret Validation)
 * 2. Rate Limit (Redis-backed quotas)
 * 3. State Access (Redis-backed authorization)
 * 4. Controller (pg_trgm search)
 */
const searchPipeline = [
  authMiddleware,
  rateLimitMiddleware,
  stateAccessMiddleware,
  SearchController.searchVillages
];

router.get('/', searchPipeline);
router.get('/villages', searchPipeline);

module.exports = router;
