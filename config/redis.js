// config/redis.js - OPTIMIZED FOR 1000+ USERS HIGH PERFORMANCE

const Redis = require('ioredis');
const config = require('./index');
const logger = require('../utils/logger');

// ✅ ENHANCED REDIS CONFIGURATION FOR HIGH CONCURRENCY
const redisConfig = {
  host: config.get('redis.host'),
  port: config.get('redis.port'),
  password: config.get('redis.password'),
  
  // ✅ CRITICAL SCALING OPTIMIZATIONS
  maxRetriesPerRequest: 2,        // Reduced retries for faster failures
  retryDelayOnFailover: 50,       // Faster retry (was 100)
  connectTimeout: 5000,           // Faster connection timeout (was 10000)
  lazyConnect: true,              // Connect only when needed
  keepAlive: 30000,               // Keep connections alive
  family: 4,                      // Force IPv4 for reliability
  
  // ✅ CONNECTION POOL OPTIMIZATION
  enableReadyCheck: false,        // Skip ready check for performance
  enableOfflineQueue: false,      // Disable offline queue to prevent memory buildup
  
  // ✅ MEMORY AND PERFORMANCE SETTINGS
  keyPrefix: 'smartcv:',          // Namespace all keys
  db: 0,                          // Use default database
  
  // ✅ COMMAND OPTIMIZATION
  commandTimeout: 5000,           // 5 second command timeout
  
  // ✅ BUFFERING SETTINGS
  enableAutoPipelining: true,     // Enable automatic command pipelining
  maxMultiplexedConnections: 10,  // Multiple connections for high load
  
  // ✅ ERROR HANDLING
  maxRetriesPerRequest: 2,
  retryDelayOnClusterDown: 300,
  retryDelayOnFailover: 100,
  
  // ✅ MEMORY MANAGEMENT
  dropBufferSupport: false,       // Keep buffer support for file operations
  
  // ✅ RECONNECTION SETTINGS
  reconnectOnError: (err) => {
    const targetError = 'READONLY';
    return err.message.includes(targetError);
  }
};

// ✅ MAIN REDIS INSTANCE FOR CACHING
const redis = new Redis(redisConfig);

// ✅ SEPARATE REDIS INSTANCE FOR BULLMQ QUEUES (BETTER PERFORMANCE)
const queueRedis = new Redis({
  ...redisConfig,
  db: 1,                          // Different database for queues
  maxRetriesPerRequest: null,     // Required for BullMQ
  enableAutoPipelining: false,    // Disable for queue operations
  keyPrefix: 'queue:',            // Different prefix for queues
});

// ✅ SEPARATE REDIS INSTANCE FOR SESSION DATA
const sessionRedis = new Redis({
  ...redisConfig,
  db: 2,                          // Different database for sessions
  keyPrefix: 'session:',
  commandTimeout: 3000,           // Faster timeout for sessions
});

// ✅ SET EVENT LISTENERS AND LIMITS
redis.setMaxListeners(25);        // Increased from 20
queueRedis.setMaxListeners(25);
sessionRedis.setMaxListeners(15);

// ================================
// CONNECTION EVENT HANDLERS
// ================================

// Main Redis events
redis.on('error', (error) => {
  logger.error('Main Redis connection error', { 
    error: error.message,
    host: config.get('redis.host'),
    port: config.get('redis.port')
  });
});

redis.on('connect', () => {
  logger.info('Main Redis connected successfully', { 
    host: config.get('redis.host'),
    port: config.get('redis.port'),
    db: redisConfig.db
  });
});

redis.on('ready', () => {
  logger.info('Main Redis ready for commands');
});

redis.on('reconnecting', (delay) => {
  logger.warn('Main Redis reconnecting...', { delay });
});

redis.on('close', () => {
  logger.warn('Main Redis connection closed');
});

// Queue Redis events
queueRedis.on('error', (error) => {
  logger.error('Queue Redis connection error', { 
    error: error.message,
    db: 1
  });
});

queueRedis.on('connect', () => {
  logger.info('Queue Redis connected successfully', { db: 1 });
});

queueRedis.on('ready', () => {
  logger.info('Queue Redis ready for commands');
});

// Session Redis events
sessionRedis.on('error', (error) => {
  logger.error('Session Redis connection error', { 
    error: error.message,
    db: 2
  });
});

sessionRedis.on('connect', () => {
  logger.info('Session Redis connected successfully', { db: 2 });
});

// ================================
// PERFORMANCE MONITORING
// ================================

let redisOperationCount = 0;
let redisErrorCount = 0;
let totalResponseTime = 0;

// Monitor Redis performance
function monitorRedisOperation(operation, startTime) {
  const responseTime = Date.now() - startTime;
  redisOperationCount++;
  totalResponseTime += responseTime;
  
  if (responseTime > 1000) { // Log slow operations
    logger.warn('Slow Redis operation detected', {
      operation,
      responseTime: responseTime + 'ms'
    });
  }
}

// Log Redis performance stats every 5 minutes
setInterval(() => {
  if (redisOperationCount > 0) {
    const avgResponseTime = Math.round(totalResponseTime / redisOperationCount);
    const errorRate = Math.round((redisErrorCount / redisOperationCount) * 100);
    
    logger.info('Redis Performance Stats', {
      totalOperations: redisOperationCount,
      averageResponseTime: avgResponseTime + 'ms',
      errorRate: errorRate + '%',
      errorsCount: redisErrorCount
    });
    
    // Reset counters
    redisOperationCount = 0;
    redisErrorCount = 0;
    totalResponseTime = 0;
  }
}, 300000);

// ================================
// ENHANCED REDIS WRAPPER FUNCTIONS
// ================================

// Wrapper for Redis operations with monitoring
const redisWrapper = {
  async get(key) {
    const startTime = Date.now();
    try {
      const result = await redis.get(key);
      monitorRedisOperation('GET', startTime);
      return result;
    } catch (error) {
      redisErrorCount++;
      logger.error('Redis GET error', { key, error: error.message });
      throw error;
    }
  },

  async set(key, value, ...args) {
    const startTime = Date.now();
    try {
      const result = await redis.set(key, value, ...args);
      monitorRedisOperation('SET', startTime);
      return result;
    } catch (error) {
      redisErrorCount++;
      logger.error('Redis SET error', { key, error: error.message });
      throw error;
    }
  },

  async del(key) {
    const startTime = Date.now();
    try {
      const result = await redis.del(key);
      monitorRedisOperation('DEL', startTime);
      return result;
    } catch (error) {
      redisErrorCount++;
      logger.error('Redis DEL error', { key, error: error.message });
      throw error;
    }
  },

  async exists(key) {
    const startTime = Date.now();
    try {
      const result = await redis.exists(key);
      monitorRedisOperation('EXISTS', startTime);
      return result;
    } catch (error) {
      redisErrorCount++;
      logger.error('Redis EXISTS error', { key, error: error.message });
      throw error;
    }
  },

  async keys(pattern) {
    const startTime = Date.now();
    try {
      const result = await redis.keys(pattern);
      monitorRedisOperation('KEYS', startTime);
      return result;
    } catch (error) {
      redisErrorCount++;
      logger.error('Redis KEYS error', { pattern, error: error.message });
      throw error;
    }
  },

  async ttl(key) {
    const startTime = Date.now();
    try {
      const result = await redis.ttl(key);
      monitorRedisOperation('TTL', startTime);
      return result;
    } catch (error) {
      redisErrorCount++;
      logger.error('Redis TTL error', { key, error: error.message });
      throw error;
    }
  },

  async expire(key, seconds) {
    const startTime = Date.now();
    try {
      const result = await redis.expire(key, seconds);
      monitorRedisOperation('EXPIRE', startTime);
      return result;
    } catch (error) {
      redisErrorCount++;
      logger.error('Redis EXPIRE error', { key, error: error.message });
      throw error;
    }
  },

  async incr(key) {
    const startTime = Date.now();
    try {
      const result = await redis.incr(key);
      monitorRedisOperation('INCR', startTime);
      return result;
    } catch (error) {
      redisErrorCount++;
      logger.error('Redis INCR error', { key, error: error.message });
      throw error;
    }
  },

  async ping() {
    const startTime = Date.now();
    try {
      const result = await redis.ping();
      monitorRedisOperation('PING', startTime);
      return result;
    } catch (error) {
      redisErrorCount++;
      logger.error('Redis PING error', { error: error.message });
      throw error;
    }
  }
};

// ================================
// CONNECTION HEALTH MONITORING
// ================================

let lastHealthCheck = Date.now();
const HEALTH_CHECK_INTERVAL = 30000; // 30 seconds

async function performHealthCheck() {
  try {
    const startTime = Date.now();
    
    // Test main Redis
    await redis.ping();
    const mainRedisTime = Date.now() - startTime;
    
    // Test queue Redis
    const queueStartTime = Date.now();
    await queueRedis.ping();
    const queueRedisTime = Date.now() - queueStartTime;
    
    // Test session Redis
    const sessionStartTime = Date.now();
    await sessionRedis.ping();
    const sessionRedisTime = Date.now() - sessionStartTime;
    
    lastHealthCheck = Date.now();
    
    // Log if any instance is slow
    if (mainRedisTime > 100 || queueRedisTime > 100 || sessionRedisTime > 100) {
      logger.warn('Redis instances responding slowly', {
        mainRedis: mainRedisTime + 'ms',
        queueRedis: queueRedisTime + 'ms',
        sessionRedis: sessionRedisTime + 'ms'
      });
    }
    
  } catch (error) {
    logger.error('Redis health check failed', { error: error.message });
  }
}

// Run health checks
setInterval(performHealthCheck, HEALTH_CHECK_INTERVAL);

// ================================
// MEMORY MANAGEMENT
// ================================

// Monitor Redis memory usage
async function checkRedisMemory() {
  try {
    const memoryInfo = await redis.memory('usage', 'smartcv:*');
    const totalMemory = await redis.info('memory');
    
    // Parse memory info
    const usedMemory = totalMemory.match(/used_memory:(\d+)/);
    const maxMemory = totalMemory.match(/maxmemory:(\d+)/);
    
    if (usedMemory && maxMemory) {
      const usedMB = Math.round(parseInt(usedMemory[1]) / 1024 / 1024);
      const maxMB = Math.round(parseInt(maxMemory[1]) / 1024 / 1024);
      const usagePercent = Math.round((usedMB / maxMB) * 100);
      
      if (usagePercent > 80) {
        logger.warn('High Redis memory usage', {
          usedMemory: usedMB + 'MB',
          maxMemory: maxMB + 'MB',
          usage: usagePercent + '%'
        });
      }
    }
    
  } catch (error) {
    logger.error('Failed to check Redis memory', { error: error.message });
  }
}

// Check Redis memory every 5 minutes
setInterval(checkRedisMemory, 300000);

// ================================
// AUTOMATIC KEY CLEANUP
// ================================

// Clean up expired keys and optimize performance
async function performRedisCleanup() {
  try {
    logger.info('Starting Redis cleanup...');
    
    // Clean up old CV processing keys
    const oldCVKeys = await redis.keys('smartcv:raw_cv:*');
    let cleanedCount = 0;
    
    for (const key of oldCVKeys) {
      const ttl = await redis.ttl(key);
      if (ttl < 0) { // No expiry set
        await redis.expire(key, 7200); // Set 2 hour expiry
        cleanedCount++;
      }
    }
    
    // Clean up old job keys
    const oldJobKeys = await redis.keys('smartcv:last_jobs:*');
    for (const key of oldJobKeys) {
      const ttl = await redis.ttl(key);
      if (ttl < 0) {
        await redis.expire(key, 3600); // Set 1 hour expiry
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      logger.info('Redis cleanup completed', { keysUpdated: cleanedCount });
    }
    
  } catch (error) {
    logger.error('Redis cleanup failed', { error: error.message });
  }
}

// Run cleanup every 2 hours
setInterval(performRedisCleanup, 7200000);

// ================================
// GRACEFUL SHUTDOWN
// ================================

async function gracefulRedisShutdown() {
  logger.info('Starting graceful Redis shutdown...');
  
  try {
    await Promise.all([
      redis.quit(),
      queueRedis.quit(),
      sessionRedis.quit()
    ]);
    logger.info('All Redis connections closed successfully');
  } catch (error) {
    logger.error('Error during Redis shutdown', { error: error.message });
  }
}

// Handle shutdown signals
process.on('SIGTERM', gracefulRedisShutdown);
process.on('SIGINT', gracefulRedisShutdown);

// ================================
// CONNECTION POOL STATUS
// ================================

function getRedisStatus() {
  return {
    main: {
      status: redis.status,
      db: redisConfig.db,
      keyPrefix: redisConfig.keyPrefix
    },
    queue: {
      status: queueRedis.status,
      db: 1,
      keyPrefix: 'queue:'
    },
    session: {
      status: sessionRedis.status,
      db: 2,
      keyPrefix: 'session:'
    },
    lastHealthCheck: new Date(lastHealthCheck).toISOString(),
    performance: {
      totalOperations: redisOperationCount,
      errorCount: redisErrorCount
    }
  };
}

// ================================
// EXPORTS
// ================================

// Export the wrapped Redis instance as default
module.exports = redisWrapper;

// Export additional instances
module.exports.redis = redis;           // Raw Redis instance if needed
module.exports.queueRedis = queueRedis; // For BullMQ queues
module.exports.sessionRedis = sessionRedis; // For session management
module.exports.getRedisStatus = getRedisStatus; // Status function

// ================================
// STARTUP LOGGING
// ================================

logger.info('🚀 Optimized Redis configuration loaded for 1000+ users', {
  mainRedis: {
    host: config.get('redis.host'),
    port: config.get('redis.port'),
    db: redisConfig.db,
    keyPrefix: redisConfig.keyPrefix
  },
  queueRedis: {
    db: 1,
    keyPrefix: 'queue:',
    purpose: 'BullMQ job queues'
  },
  sessionRedis: {
    db: 2,
    keyPrefix: 'session:',
    purpose: 'User sessions and temp data'
  },
  optimizations: [
    'Connection pooling enabled',
    'Auto-pipelining active',
    'Memory monitoring configured',
    'Health checks running',
    'Performance tracking enabled'
  ]
});