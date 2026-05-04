const express = require('express');
const SearchController = require('../controllers/searchController');

const router = express.Router();

/**
 * GET /v1/search/villages
 * Demo Endpoint Pipeline:
 * Auth, rate limits, quotas, and state restrictions are temporarily bypassed.
 */
router.get('/', SearchController.searchVillages);
router.get('/villages', SearchController.searchVillages);

module.exports = router;
