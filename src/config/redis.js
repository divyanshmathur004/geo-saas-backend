const { Redis } = require('@upstash/redis');
const { env } = require('./env');

/**
 * Upstash Redis Singleton
 * Ensures we only initialize one Redis HTTP client instance.
 * While HTTP clients don't suffer from TCP exhaustion like DB connections, 
 * reusing the instance prevents memory leaks during Vercel cold starts/hot reloads.
 */
const globalForRedis = global;

const redis =
  globalForRedis.redis ||
  new Redis({
    url: env.REDIS_URL,
    token: env.REDIS_TOKEN,
  });

if (env.NODE_ENV !== 'production') globalForRedis.redis = redis;

module.exports = { redis };
