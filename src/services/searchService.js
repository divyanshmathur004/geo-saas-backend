const { prisma } = require('../config/prisma');

class SearchService {
  /**
   * Performs a highly optimized fuzzy trigram search on village_search using raw SQL.
   * Utilizes Keyset Pagination (Cursor) via similarity score and UUID.
   */
  static async searchVillages({ stateId, query, limit, cursor }) {
    // 1. Get the state name for denormalized table filtering
    // Since stateId is verified by middleware, this is a very fast PK lookup
    const state = await prisma.state.findUnique({
      where: { id: stateId },
      select: { name: true }
    });

    if (!state) {
      throw new Error('State not found');
    }

    const stateName = state.name;

    // 2. Decode cursor if present (Keyset pagination decode)
    let cursorSml = null;
    let cursorId = null;

    if (cursor) {
      try {
        const decoded = Buffer.from(cursor, 'base64').toString('utf8');
        const [sml, id] = decoded.split('|');
        if (sml && id) {
          cursorSml = parseFloat(sml);
          cursorId = id;
        }
      } catch (e) {
        // Ignore invalid cursor format, fallback to first page
      }
    }

    // 3. Construct Raw SQL for pg_trgm
    let results;

    // Prisma $queryRaw uses strict tagged templates to safely parameterize inputs, preventing SQL injection.
    // We strictly use the `%` operator to invoke the pg_trgm GIN index.
    if (cursorSml !== null && cursorId !== null) {
      // Keyset Pagination: Next page where similarity is lower, or same similarity but higher ID
      results = await prisma.$queryRaw`
        SELECT 
          id,
          village_name AS "villageName",
          sub_district_name AS "subDistrictName",
          district_name AS "districtName",
          state_name AS "stateName",
          similarity(search_text, ${query}) AS "score"
        FROM village_search
        WHERE state_name = ${stateName}
          AND search_text % ${query}
          AND (
            similarity(search_text, ${query}) < ${cursorSml} OR 
            (similarity(search_text, ${query}) = ${cursorSml} AND id > ${cursorId}::uuid)
          )
        ORDER BY similarity(search_text, ${query}) DESC, id ASC
        LIMIT ${limit}
      `;
    } else {
      // First Page
      results = await prisma.$queryRaw`
        SELECT 
          id,
          village_name AS "villageName",
          sub_district_name AS "subDistrictName",
          district_name AS "districtName",
          state_name AS "stateName",
          similarity(search_text, ${query}) AS "score"
        FROM village_search
        WHERE state_name = ${stateName}
          AND search_text % ${query}
        ORDER BY similarity(search_text, ${query}) DESC, id ASC
        LIMIT ${limit}
      `;
    }

    // 4. Construct response and compute next cursor
    const returnData = results.map(r => ({
      village_name: r.villageName,
      sub_district_name: r.subDistrictName,
      district_name: r.districtName,
      state_name: r.stateName,
      // internal fields to compute cursor
      _id: r.id,
      _score: r.score
    }));

    let nextCursor = null;
    // If we received a full page, there might be more records
    if (returnData.length === limit) {
      const lastRecord = returnData[returnData.length - 1];
      // Base64 encode the sort keys "similarity|id" to create an opaque cursor string
      nextCursor = Buffer.from(`${lastRecord._score}|${lastRecord._id}`).toString('base64');
    }

    // Clean up internal fields before returning to client
    returnData.forEach(r => {
      delete r._id;
      delete r._score;
    });

    return {
      data: returnData,
      nextCursor
    };
  }
}

module.exports = SearchService;
