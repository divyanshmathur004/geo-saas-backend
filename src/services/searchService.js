const { prisma } = require('../config/prisma');

class SearchService {
  static decodeCursor(cursor) {
    if (!cursor) return null;

    try {
      const decoded = Buffer.from(cursor, 'base64').toString('utf8');
      const [score, id] = decoded.split('|');

      if (!score || !id) return null;

      const parsedScore = Number.parseFloat(score);
      if (!Number.isFinite(parsedScore)) return null;

      return { score: parsedScore, id };
    } catch (error) {
      return null;
    }
  }

  static normalizeQuery(query) {
    return query
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  static async searchVillages({ stateId, query, limit, cursor }) {
    const normalizedQuery = SearchService.normalizeQuery(query);
    const containsQuery = `%${normalizedQuery}%`;
    const decodedCursor = SearchService.decodeCursor(cursor);

    const state = await prisma.state.findFirst({
      where: {
        id: stateId,
        isActive: true,
        deletedAt: null
      },
      select: { code: true }
    });

    if (!state) {
      throw new Error('State not found');
    }

    let results;

    if (decodedCursor) {
      results = await prisma.$queryRaw`
        SELECT
          village_search.id,
          village_search.village_name AS "villageName",
          village_search.sub_district_name AS "subDistrictName",
          village_search.district_name AS "districtName",
          village_search.state_name AS "stateName",
          similarity(village_search.search_text, ${normalizedQuery}) AS "score"
        FROM village_search
        JOIN village
          ON village.id = village_search.village_id
         AND village.deleted_at IS NULL
        JOIN sub_district
          ON sub_district.id = village.sub_district_id
         AND sub_district.deleted_at IS NULL
        JOIN district
          ON district.id = sub_district.district_id
         AND district.deleted_at IS NULL
        JOIN state
          ON state.id = district.state_id
         AND state.deleted_at IS NULL
         AND state.is_active = true
        WHERE state.code = ${state.code}
          AND (
            village_search.search_text % ${normalizedQuery}
            OR village_search.search_text ILIKE ${containsQuery}
          )
          AND (
            similarity(village_search.search_text, ${normalizedQuery}) < ${decodedCursor.score}
            OR (
              similarity(village_search.search_text, ${normalizedQuery}) = ${decodedCursor.score}
              AND village_search.id > ${decodedCursor.id}::uuid
            )
          )
        ORDER BY similarity(village_search.search_text, ${normalizedQuery}) DESC, village_search.id ASC
        LIMIT ${limit}
      `;
    } else {
      results = await prisma.$queryRaw`
        SELECT
          village_search.id,
          village_search.village_name AS "villageName",
          village_search.sub_district_name AS "subDistrictName",
          village_search.district_name AS "districtName",
          village_search.state_name AS "stateName",
          similarity(village_search.search_text, ${normalizedQuery}) AS "score"
        FROM village_search
        JOIN village
          ON village.id = village_search.village_id
         AND village.deleted_at IS NULL
        JOIN sub_district
          ON sub_district.id = village.sub_district_id
         AND sub_district.deleted_at IS NULL
        JOIN district
          ON district.id = sub_district.district_id
         AND district.deleted_at IS NULL
        JOIN state
          ON state.id = district.state_id
         AND state.deleted_at IS NULL
         AND state.is_active = true
        WHERE state.code = ${state.code}
          AND (
            village_search.search_text % ${normalizedQuery}
            OR village_search.search_text ILIKE ${containsQuery}
          )
        ORDER BY similarity(village_search.search_text, ${normalizedQuery}) DESC, village_search.id ASC
        LIMIT ${limit}
      `;
    }

    const data = results.map((row) => ({
      village_name: row.villageName,
      sub_district_name: row.subDistrictName,
      district_name: row.districtName,
      state_name: row.stateName,
      _id: row.id,
      _score: row.score
    }));

    let nextCursor = null;

    if (data.length === limit) {
      const lastRow = data[data.length - 1];
      nextCursor = Buffer.from(`${lastRow._score}|${lastRow._id}`).toString('base64');
    }

    data.forEach((row) => {
      delete row._id;
      delete row._score;
    });

    return { data, nextCursor };
  }
}

module.exports = SearchService;
