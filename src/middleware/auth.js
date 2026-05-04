const crypto = require('crypto');
const { prisma } = require('../config/prisma');
const { redis } = require('../config/redis');
const ApiResponse = require('../utils/apiResponse');

const REDIS_TTL_SECONDS = 300; // 5 minutes

/**
 * Hashes the provided secret using SHA-256
 */
const hashSecret = (secret) => {
  return crypto.createHash('sha256').update(secret).digest('hex');
};

/**
 * Validates if a string is a valid UUID
 */
const isValidUUID = (uuid) => {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
};

const authMiddleware = async (req, res, next) => {
  try {
    // 1. Extract headers
    const apiKey = req.header('X-API-Key');
    const apiSecret = req.header('X-API-Secret');

    // 2. Validate presence
    if (!apiKey || !apiSecret) {
      // SECURITY: Generic 401 response, never leak the exact reason
      return ApiResponse.error(res, 'Unauthorized', 401);
    }

    const cacheKey = `auth:key:${apiKey}`;
    let keyData = null;

    // 3. Try fetching from Redis cache. Redis outages must not block DB-backed auth.
    let cached = null;
    try {
      cached = await redis.get(cacheKey);
    } catch (error) {
      console.error('[AuthMiddleware] Redis cache read failed:', error);
    }

    if (cached) {
      // Upstash returns object directly if JSON, or string
      keyData = typeof cached === 'string' ? JSON.parse(cached) : cached;
    } else {
      // 4. Cache Miss - Fallback to Prisma
      // Ensure apiKey is a valid UUID before querying to prevent Prisma exceptions
      if (!isValidUUID(apiKey)) {
        return ApiResponse.error(res, 'Unauthorized', 401);
      }

      const dbKey = await prisma.apiKey.findFirst({
        where: {
          id: apiKey,
          isActive: true,
          deletedAt: null,
          user: {
            deletedAt: null,
            status: 'ACTIVE', // Enforce tenant is fully active
          },
        },
        include: {
          user: {
            include: {
              subscriptionPlan: true,
            },
          },
        },
      });

      // Reject if key doesn't exist, is inactive, or tenant is suspended/deleted
      if (!dbKey) {
        return ApiResponse.error(res, 'Unauthorized', 401);
      }

      // Store in Redis (DO NOT store allowedStates)
      keyData = {
        apiKeyId: dbKey.id,
        keyHash: dbKey.keyHash,
        userId: dbKey.userId,
        isActive: dbKey.isActive,
        plan: dbKey.user.subscriptionPlan,
      };

      redis.set(cacheKey, JSON.stringify(keyData), { ex: REDIS_TTL_SECONDS }).catch((error) => {
        console.error('[AuthMiddleware] Redis cache write failed:', error);
      });
    }

    // 5. Hash the secret
    const providedHash = hashSecret(apiSecret);

    // 6. Constant-Time Comparison
    // Prevents timing attacks where hackers measure response times to guess the hash
    const cachedHashBuffer = Buffer.from(keyData.keyHash, 'utf8');
    const providedHashBuffer = Buffer.from(providedHash, 'utf8');

    // Ensure lengths match before comparing to prevent Buffer throw
    if (
      cachedHashBuffer.length !== providedHashBuffer.length ||
      !crypto.timingSafeEqual(cachedHashBuffer, providedHashBuffer)
    ) {
      return ApiResponse.error(res, 'Unauthorized', 401);
    }

    // 7. Attach Context on Success
    req.context = {
      userId: keyData.userId,
      apiKeyId: keyData.apiKeyId,
      plan: keyData.plan,
    };

    next();
  } catch (error) {
    console.error('[AuthMiddleware] Exception:', error);
    // Generic 401 fallback for any unexpected errors
    return ApiResponse.error(res, 'Unauthorized', 401);
  }
};

module.exports = authMiddleware;
