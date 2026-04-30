const { prisma } = require('../config/prisma');
const { redis } = require('../config/redis');
const ApiResponse = require('../utils/apiResponse');

const ACCESS_CACHE_TTL = 300; // 5 minutes

const stateAccessMiddleware = async (req, res, next) => {
  try {
    const { userId } = req.context;
    
    // 1. Extract state_code from query string or URL parameters
    const stateCode = req.query.state_code || req.params.state_code;

    if (!stateCode) {
      return ApiResponse.error(res, 'state_code is required', 400);
    }

    const normalizedCode = stateCode.toUpperCase().trim();

    // -------------------------------------------------------------------------
    // 2. Map state_code to state.id
    // -------------------------------------------------------------------------
    // We cache state mappings globally because geographical codes rarely change.
    // This removes a blocking DB query from the critical request path.
    const stateCodeKey = `state:code:${normalizedCode}`;
    let stateId = await redis.get(stateCodeKey);

    if (!stateId) {
      // Cache miss - fallback to DB
      const stateObj = await prisma.state.findFirst({
        where: { 
          code: normalizedCode, 
          isActive: true, 
          deletedAt: null 
        },
        select: { id: true }
      });

      if (!stateObj) {
        return ApiResponse.error(res, 'Invalid state_code', 400);
      }
      
      stateId = stateObj.id;
      // Cache the mapping for 24 hours to optimize future requests
      await redis.set(stateCodeKey, stateId, { ex: 86400 }).catch(console.error);
    }

    // -------------------------------------------------------------------------
    // 3. Authorization Check (Redis First)
    // -------------------------------------------------------------------------
    const accessKey = `access:user:${userId}:states`;
    let allowedStates = null;
    const cachedAccess = await redis.get(accessKey);

    if (cachedAccess) {
      // Upstash parses JSON automatically or returns a string depending on client version
      allowedStates = typeof cachedAccess === 'string' ? JSON.parse(cachedAccess) : cachedAccess;
    } else {
      // Cache Miss: Query DB for all active states allowed for this user
      const accessGrants = await prisma.userStateAccess.findMany({
        where: {
          userId: userId,
          isActive: true,
          deletedAt: null
        },
        select: { stateId: true }
      });

      // Map to a flat array: [state_id_1, state_id_2]
      allowedStates = accessGrants.map(grant => grant.stateId);

      // Store in Redis with a short TTL (5 minutes)
      await redis.set(accessKey, JSON.stringify(allowedStates), { ex: ACCESS_CACHE_TTL });
    }

    // -------------------------------------------------------------------------
    // 4. Reject or Attach
    // -------------------------------------------------------------------------
    if (!allowedStates.includes(stateId)) {
      return ApiResponse.error(res, 'Forbidden: You do not have access to this state', 403);
    }

    // Attach validated stateId to context so downstream controllers don't have to map it again
    req.context.stateId = stateId;
    
    next();
  } catch (error) {
    console.error('[StateAccessMiddleware] Exception:', error);
    // Security: Fail-closed on errors
    return ApiResponse.error(res, 'Internal Server Error', 500);
  }
};

module.exports = stateAccessMiddleware;
