const { redis } = require('../config/redis');
const logger = require('./logger');

class RateLimiter {
  constructor() {
    this.limits = {
      message: { max: 10, window: 60, name: 'messages' },
      job_search: { max: 20, window: 300, name: 'job searches' },
      cv_upload: { max: 3, window: 3600, name: 'CV uploads' },
      application: { max: 50, window: 86400, name: 'applications' },
      ai_call: { max: 5, window: 60, name: 'AI requests' },
      file_download: { max: 10, window: 300, name: 'file downloads' }
    };
  }

  async checkLimit(identifier, action = 'message') {
    try {
      const limit = this.limits[action];
      if (!limit) {
        logger.warn('Unknown rate limit action', { action });
        return { allowed: true, remaining: 999 };
      }

      const key = `rate:${action}:${identifier}`;
      const current = await redis.get(key);

      if (!current) {
        // First request in window
        await redis.set(key, 1, 'EX', limit.window);
        
        logger.info('Rate limit - first request', {
          identifier: this.maskIdentifier(identifier),
          action,
          remaining: limit.max - 1
        });

        return {
          allowed: true,
          remaining: limit.max - 1,
          resetIn: limit.window,
          limit: limit.max
        };
      }

      const count = parseInt(current);
      
      if (count >= limit.max) {
        const ttl = await redis.ttl(key);
        
        logger.warn('Rate limit exceeded', {
          identifier: this.maskIdentifier(identifier),
          action,
          count,
          limit: limit.max,
          resetIn: ttl
        });

        return {
          allowed: false,
          remaining: 0,
          resetIn: ttl,
          limit: limit.max,
          message: this.getRateLimitMessage(action, ttl)
        };
      }

      // Increment counter
      await redis.incr(key);
      
      return {
        allowed: true,
        remaining: limit.max - count - 1,
        resetIn: await redis.ttl(key),
        limit: limit.max
      };

    } catch (error) {
      logger.error('Rate limiter error', { 
        error: error.message, 
        identifier: this.maskIdentifier(identifier),
        action 
      });
      
      // On error, allow the request (fail open)
      return { allowed: true, remaining: 999, error: true };
    }
  }

  getRateLimitMessage(action, resetIn) {
    const minutes = Math.ceil(resetIn / 60);
    const limit = this.limits[action];
    
    const messages = {
      message: `⏳ Slow down! You can send ${limit.max} messages per minute. Try again in ${minutes} minute(s).`,
      job_search: `🔍 Too many job searches! You can search ${limit.max} times per 5 minutes. Try again in ${minutes} minute(s).`,
      cv_upload: `📄 Upload limit reached! You can upload ${limit.max} CVs per hour. Try again in ${Math.ceil(resetIn / 3600)} hour(s).`,
      application: `💼 Daily application limit reached! You can apply to ${limit.max} jobs per day. Try again tomorrow.`,
      ai_call: `🤖 AI processing limit reached! You can make ${limit.max} AI requests per minute. Try again in ${minutes} minute(s).`,
      file_download: `⬇️ Download limit reached! You can download ${limit.max} files per 5 minutes. Try again in ${minutes} minute(s).`
    };

    return messages[action] || `Rate limit exceeded. Try again in ${minutes} minute(s).`;
  }

  maskIdentifier(identifier) {
    // Mask phone numbers for privacy in logs
    if (identifier && identifier.length > 6) {
      return identifier.substring(0, 6) + '***';
    }
    return identifier;
  }

  // Get current usage stats for monitoring
  async getUsageStats(identifier, action) {
    try {
      const key = `rate:${action}:${identifier}`;
      const current = await redis.get(key);
      const ttl = await redis.ttl(key);
      const limit = this.limits[action];

      return {
        used: parseInt(current) || 0,
        remaining: limit ? limit.max - (parseInt(current) || 0) : 999,
        limit: limit ? limit.max : 999,
        resetIn: ttl > 0 ? ttl : 0
      };
    } catch (error) {
      logger.error('Error getting usage stats', { error: error.message });
      return { used: 0, remaining: 999, limit: 999, resetIn: 0 };
    }
  }

  // Clear all rate limits for a user (admin function)
  async clearUserLimits(identifier) {
    try {
      const keys = await redis.keys(`rate:*:${identifier}`);
      if (keys.length > 0) {
        await redis.del(...keys);
        logger.info('Cleared rate limits for user', { 
          identifier: this.maskIdentifier(identifier),
          clearedKeys: keys.length 
        });
      }
      return keys.length;
    } catch (error) {
      logger.error('Error clearing user limits', { error: error.message });
      return 0;
    }
  }
}

module.exports = new RateLimiter();