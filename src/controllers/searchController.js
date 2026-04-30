const SearchService = require('../services/searchService');
const ApiResponse = require('../utils/apiResponse');

class SearchController {
  static async searchVillages(req, res) {
    try {
      const { q, limit, cursor } = req.query;
      const { stateId } = req.context; // Strictly populated by stateAccessMiddleware

      // 1. Validate Query Length (Must be >= 3 chars to safely hit GIN trgm index)
      if (!q || q.trim().length < 3) {
        return ApiResponse.error(res, 'Search query must be at least 3 characters', 400);
      }

      // 2. Validate and Cap Limit (Max 50 to prevent huge JSON payloads and CPU strain)
      let parsedLimit = parseInt(limit, 10);
      if (isNaN(parsedLimit) || parsedLimit < 1) {
        parsedLimit = 20; // Default
      } else if (parsedLimit > 50) {
        parsedLimit = 50; // Ceiling
      }

      // 3. Execute High-Performance Search
      const searchResult = await SearchService.searchVillages({
        stateId,
        query: q.trim(),
        limit: parsedLimit,
        cursor
      });

      // 4. Return Success
      return res.status(200).json({
        success: true,
        data: searchResult.data,
        meta: {
          nextCursor: searchResult.nextCursor,
          limit: parsedLimit
        }
      });
    } catch (error) {
      console.error('[SearchController] Exception:', error);
      return ApiResponse.error(res, 'Search processing failed', 500);
    }
  }
}

module.exports = SearchController;
