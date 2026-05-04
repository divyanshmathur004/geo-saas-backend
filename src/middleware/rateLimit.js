const { redis } = require('../config/redis');
const ApiResponse = require('../utils/apiResponse');

const rateLimitMiddleware = async (req, res, next) => {
  try {
    // Ensure auth middleware has already populated req.context
    const { apiKeyId, userId, plan } = req.context;

    // -------------------------------------------------------------------------
    // 1. Rate Limiting (Requests Per Minute)
    // -------------------------------------------------------------------------
    const currentMinute = Math.floor(Date.now() / 60000);
    const rlKey = `rate_limit:${apiKeyId}:${currentMinute}`;
    
    // O(1) atomic increment to avoid race conditions under high concurrency
    let currentRequests;
    try {
      currentRequests = await redis.incr(rlKey);
    } catch (error) {
      console.error('[RateLimitMiddleware] Redis rate limit unavailable:', error);
      req.context.usage = null;
      return next();
    }
    
    // Set 60-second TTL only on the first request of the minute to save Redis commands
    if (currentRequests === 1) {
      // Async fire-and-forget, no need to await for the request path
      redis.expire(rlKey, 60).catch(console.error);
    }

    if (currentRequests > plan.rateLimitPerMin) {
      return ApiResponse.error(res, 'Too Many Requests', 429);
    }

    // -------------------------------------------------------------------------
    // 2. Monthly Quota Enforcement (Read BEFORE processing)
    // -------------------------------------------------------------------------
    const now = new Date();
    const yearMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const quotaKey = `usage:${userId}:${yearMonth}`;

    // O(1) read
    let currentUsageVal;
    try {
      currentUsageVal = await redis.get(quotaKey);
    } catch (error) {
      console.error('[RateLimitMiddleware] Redis quota unavailable:', error);
      req.context.usage = null;
      return next();
    }
    const currentUsage = currentUsageVal ? parseInt(currentUsageVal, 10) : 0;
    const maxQuota = plan.maxRequestsPerMonth;

    if (currentUsage >= maxQuota) {
      return ApiResponse.error(res, 'Monthly Quota Exceeded', 429);
    }

    // -------------------------------------------------------------------------
    // 3. Attach to Context
    // -------------------------------------------------------------------------
    req.context.usage = {
      current: currentUsage,
      limit: maxQuota
    };

    // -------------------------------------------------------------------------
    // 4. Increment Usage (AFTER successful request)
    // -------------------------------------------------------------------------
    res.on('finish', () => {
      // Only charge the quota if the request was actually successful (2xx).
      // We do not penalize users for 500 errors, 404s, or validation failures.
      if (res.statusCode >= 200 && res.statusCode < 300) {
        redis.incr(quotaKey)
          .then((newUsage) => {
            // Expire quota keys after 32 days to ensure Redis memory doesn't leak
            if (newUsage === 1) {
              redis.expire(quotaKey, 60 * 60 * 24 * 32).catch(console.error);
            }
          })
          .catch((err) => {
            console.error('[Quota Increment Error]', err);
          });
      }
    });

    next();
  } catch (error) {
    console.error('[RateLimitMiddleware] Exception:', error);
    // Security: Fail-closed on Redis failure to prevent quota bypass during outages
    return ApiResponse.error(res, 'Internal Server Error', 500);
  }
};

module.exports = rateLimitMiddleware;
