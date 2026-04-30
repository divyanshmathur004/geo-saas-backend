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
 * 2. Rate Limit (Real-time Redis quotas)
 * 3. State Access (Redis-backed 403 authorization)
 * 4. Controller (Fuzzy pg_trgm Search)
 */
router.get(
  '/villages',
  authMiddleware,
  rateLimitMiddleware,
  stateAccessMiddleware,
  SearchController.searchVillages
);

module.exports = router;
