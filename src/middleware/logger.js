const AuditLogger = require('../utils/logger');

const requestLogger = (req, res, next) => {
  // Capture high-resolution start time
  const startHrTime = process.hrtime();

  // Hook into the native 'finish' event which fires AFTER the response 
  // has been completely handed off to the OS/Client.
  res.on('finish', () => {
    // Calculate precise elapsed time in milliseconds
    const elapsedHrTime = process.hrtime(startHrTime);
    const responseTimeMs = Math.round(elapsedHrTime[0] * 1000 + elapsedHrTime[1] / 1e6);

    // Safely extract context (may be null if Auth failed or bypassed)
    const userId = req.context?.userId || null;
    const apiKeyId = req.context?.apiKeyId || null;

    // Construct the audit payload matching the api_log table structure
    const logPayload = {
      user_id: userId,
      api_key_id: apiKeyId,
      endpoint: req.originalUrl || req.url,
      method: req.method,
      status_code: res.statusCode,
      response_time_ms: responseTimeMs,
      ip_address: req.ip || req.socket?.remoteAddress || null,
      user_agent: req.get('user-agent') || null,
      created_at: new Date().toISOString()
    };

    // Fire-and-forget: Do NOT await this so the Node event loop can move on instantly
    AuditLogger.pushToQueue(logPayload);
  });

  next();
};

module.exports = requestLogger;
