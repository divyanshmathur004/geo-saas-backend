const { redis } = require('../config/redis');

class AuditLogger {
  /**
   * Pushes the API audit log to the Redis queue.
   * Fire-and-forget architecture: It must fail silently 
   * to ensure logging failures never break the core API response.
   */
  static async pushToQueue(logData) {
    try {
      // Async LPUSH to Redis List (api_log_queue)
      await redis.lpush('api_log_queue', JSON.stringify(logData));
    } catch (error) {
      console.error('[AuditLogger] Failed to push log to Redis queue:', error.message);
    }
  }
}

module.exports = AuditLogger;
