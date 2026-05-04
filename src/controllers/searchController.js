const SearchService = require('../services/searchService');
const ApiResponse = require('../utils/apiResponse');

class SearchController {
  static async searchVillages(req, res) {
    try {
      const { q, limit, cursor, state_code } = req.query;
      const stateId = (state_code || 'DL').toUpperCase().trim();

      if (!q || q.trim().length < 1) {
        return ApiResponse.error(res, 'Search query is required', 400);
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
