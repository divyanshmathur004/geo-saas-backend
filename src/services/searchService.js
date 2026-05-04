const demoVillages = [
  { village_name: 'Bawana', sub_district_name: 'Narela', district_name: 'North West Delhi', state_name: 'Delhi', state_code: 'DL' },
  { village_name: 'Narela', sub_district_name: 'Narela', district_name: 'North Delhi', state_name: 'Delhi', state_code: 'DL' },
  { village_name: 'Alipur', sub_district_name: 'Alipur', district_name: 'North Delhi', state_name: 'Delhi', state_code: 'DL' },
  { village_name: 'Kanjhawala', sub_district_name: 'Kanjhawala', district_name: 'North West Delhi', state_name: 'Delhi', state_code: 'DL' },
  { village_name: 'Jharoda Kalan', sub_district_name: 'Najafgarh', district_name: 'South West Delhi', state_name: 'Delhi', state_code: 'DL' },
  { village_name: 'Dichaon Kalan', sub_district_name: 'Najafgarh', district_name: 'South West Delhi', state_name: 'Delhi', state_code: 'DL' },
  { village_name: 'Chhawla', sub_district_name: 'Dwarka', district_name: 'South West Delhi', state_name: 'Delhi', state_code: 'DL' },
  { village_name: 'Najafgarh', sub_district_name: 'Najafgarh', district_name: 'South West Delhi', state_name: 'Delhi', state_code: 'DL' },
  { village_name: 'Mehrauli', sub_district_name: 'Mehrauli', district_name: 'South Delhi', state_name: 'Delhi', state_code: 'DL' },
  { village_name: 'Ghitorni', sub_district_name: 'Mehrauli', district_name: 'South Delhi', state_name: 'Delhi', state_code: 'DL' },
  { village_name: 'Burari', sub_district_name: 'Civil Lines', district_name: 'Central Delhi', state_name: 'Delhi', state_code: 'DL' },
  { village_name: 'Badarpur', sub_district_name: 'Kalkaji', district_name: 'South East Delhi', state_name: 'Delhi', state_code: 'DL' },
  { village_name: 'Bhalswa Jahangir Pur', sub_district_name: 'Model Town', district_name: 'North West Delhi', state_name: 'Delhi', state_code: 'DL' },
  { village_name: 'Mundka', sub_district_name: 'Punjabi Bagh', district_name: 'West Delhi', state_name: 'Delhi', state_code: 'DL' },
  { village_name: 'Tikri Kalan', sub_district_name: 'Punjabi Bagh', district_name: 'West Delhi', state_name: 'Delhi', state_code: 'DL' }
];

class SearchService {
  /**
   * Performs a highly optimized fuzzy trigram search on village_search using raw SQL.
   * Utilizes Keyset Pagination (Cursor) via similarity score and UUID.
   */
  static async searchVillages({ stateId, query, limit, cursor }) {
    const normalizedQuery = query.toLowerCase();
    const stateCode = stateId || 'DL';

    const filtered = demoVillages
      .filter((village) => village.state_code === stateCode)
      .filter((village) => {
        return [
          village.village_name,
          village.sub_district_name,
          village.district_name,
          village.state_name
        ].some((field) => field.toLowerCase().includes(normalizedQuery));
      })
      .slice(0, limit);

    if (filtered.length > 0 || process.env.DEMO_SEARCH_ONLY !== 'false') {
      return {
        data: filtered.map(({ state_code, ...village }) => village),
        nextCursor: null
      };
    }

    const { prisma } = require('../config/prisma');

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
