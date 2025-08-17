// config/redis.js - VPS PRODUCTION CONFIGURATION

const Redis = require('ioredis');
const config = require('./index');
const logger = require('../utils/logger');

// ✅ VPS REDIS CONFIGURATION
const redisConfig = {
  host: config.get('redis.host'), // Your VPS IP or domain
  port: config.get('redis.port'), // Default 6379
  password: config.get('redis.password'), // Set strong password
  
  // ✅ VPS-OPTIMIZED SETTINGS
  maxRetriesPerRequest: 2,
  retryDelayOnFailover: 50,
  connectTimeout: 10000,           // Increased for VPS latency
  lazyConnect: true,
  keepAlive: 30000,
  family: 4,                       // Force IPv4
  
  // ✅ VPS CONNECTION SETTINGS
  enableReadyCheck: true,          // Enable for VPS
  enableOfflineQueue: false,
  commandTimeout: 8000,            // Increased timeout for VPS
  
  // ✅ VPS SECURITY & PERFORMANCE
  keyPrefix: 'smartcv:',
  db: 0,
  
  // ✅ VPS RECONNECTION SETTINGS
  reconnectOnError: (err) => {
    const targetError = 'READONLY';
    if (err.message.includes(targetError)) {
      return true;
    }
    return false;
  },
  
  // ✅ VPS NETWORK OPTIMIZATION
  enableAutoPipelining: true,
  maxMultiplexedConnections: 5,    // Reduced for VPS
  
  // ✅ VPS ERROR HANDLING
  maxRetriesPerRequest: 2,
  retryDelayOnClusterDown: 300,
  retryDelayOnFailover: 100,
  
  // ✅ VPS-SPECIFIC SETTINGS
  dropBufferSupport: false,
  showFriendlyErrorStack: process.env.NODE_ENV === 'development'
};

// ✅ MAIN REDIS INSTANCE
const redis = new Redis(redisConfig);

const queueRedis = new Redis({
  ...redisConfig,
  db: 1,
  maxRetriesPerRequest: null, // Required for BullMQ
  enableReadyCheck: false,    // REQUIRED: Override to false for BullMQ compatibility
  keyPrefix: '',              // REQUIRED: Override to empty to avoid double-prefixing with BullMQ's prefix
  enableAutoPipelining: false, // Disable for queue operations
  commandTimeout: 10000       // Longer timeout for queue operations
});

// ✅ SESSION REDIS (Separate DB for sessions)
const sessionRedis = new Redis({
  ...redisConfig,
  db: 2,
  keyPrefix: 'session:',
  commandTimeout: 5000,            // Faster timeout for sessions
  maxMultiplexedConnections: 3     // Lower for sessions
});

// ✅ VPS CONNECTION MONITORING
redis.setMaxListeners(30);
queueRedis.setMaxListeners(30);
sessionRedis.setMaxListeners(20);

// ================================
// VPS CONNECTION EVENT HANDLERS
// ================================

// Main Redis events with VPS-specific logging
redis.on('error', (error) => {
  logger.error('Main Redis VPS connection error', { 
    error: error.message,
    host: config.get('redis.host'),
    port: config.get('redis.port'),
    code: error.code
  });
});

redis.on('connect', () => {
  logger.info('Main Redis VPS connected successfully', { 
    host: config.get('redis.host'),
    port: config.get('redis.port'),
    db: redisConfig.db
  });
});

redis.on('ready', () => {
  logger.info('Main Redis VPS ready for commands');
});

redis.on('reconnecting', (delay) => {
  logger.warn('Main Redis VPS reconnecting...', { 
    delay,
    host: config.get('redis.host')
  });
});

redis.on('close', () => {
  logger.warn('Main Redis VPS connection closed');
});

// Queue Redis events
queueRedis.on('error', (error) => {
  logger.error('Queue Redis VPS connection error', { 
    error: error.message,
    db: 1,
    host: config.get('redis.host')
  });
});

queueRedis.on('connect', () => {
  logger.info('Queue Redis VPS connected successfully', { 
    db: 1,
    host: config.get('redis.host')
  });
});

queueRedis.on('ready', () => {
  logger.info('Queue Redis VPS ready for commands');
});

// Session Redis events
sessionRedis.on('error', (error) => {
  logger.error('Session Redis VPS connection error', { 
    error: error.message,
    db: 2,
    host: config.get('redis.host')
  });
});

sessionRedis.on('connect', () => {
  logger.info('Session Redis VPS connected successfully', { 
    db: 2,
    host: config.get('redis.host')
  });
});

// ================================
// VPS PERFORMANCE MONITORING
// ================================

let redisOperationCount = 0;
let redisErrorCount = 0;
let totalResponseTime = 0;
let slowOperationCount = 0;

// Enhanced monitoring for VPS
function monitorRedisOperation(operation, startTime) {
  const responseTime = Date.now() - startTime;
  redisOperationCount++;
  totalResponseTime += responseTime;
  
  // VPS-specific slow operation threshold (higher than local)
  if (responseTime > 2000) { // 2 seconds for VPS
    slowOperationCount++;
    logger.warn('Slow Redis VPS operation detected', {
      operation,
      responseTime: responseTime + 'ms',
      host: config.get('redis.host')
    });
  }
}

// VPS performance stats every 5 minutes
setInterval(() => {
  if (redisOperationCount > 0) {
    const avgResponseTime = Math.round(totalResponseTime / redisOperationCount);
    const errorRate = Math.round((redisErrorCount / redisOperationCount) * 100);
    const slowRate = Math.round((slowOperationCount / redisOperationCount) * 100);
    
    logger.info('Redis VPS Performance Stats', {
      totalOperations: redisOperationCount,
      averageResponseTime: avgResponseTime + 'ms',
      errorRate: errorRate + '%',
      slowOperationRate: slowRate + '%',
      errorsCount: redisErrorCount,
      slowCount: slowOperationCount,
      vpsHost: config.get('redis.host')
    });
    
    // Reset counters
    redisOperationCount = 0;
    redisErrorCount = 0;
    totalResponseTime = 0;
    slowOperationCount = 0;
  }
}, 300000);

// ================================
// VPS-OPTIMIZED REDIS WRAPPER
// ================================

const redisWrapper = {
  async get(key) {
    const startTime = Date.now();
    try {
      const result = await redis.get(key);
      monitorRedisOperation('GET', startTime);
      return result;
    } catch (error) {
      redisErrorCount++;
      logger.error('Redis VPS GET error', { 
        key, 
        error: error.message,
        host: config.get('redis.host')
      });
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
      logger.error('Redis VPS SET error', { 
        key, 
        error: error.message,
        host: config.get('redis.host')
      });
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
      logger.error('Redis VPS DEL error', { 
        key, 
        error: error.message,
        host: config.get('redis.host')
      });
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
      logger.error('Redis VPS EXISTS error', { 
        key, 
        error: error.message,
        host: config.get('redis.host')
      });
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
      logger.error('Redis VPS KEYS error', { 
        pattern, 
        error: error.message,
        host: config.get('redis.host')
      });
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
      logger.error('Redis VPS TTL error', { 
        key, 
        error: error.message,
        host: config.get('redis.host')
      });
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
      logger.error('Redis VPS EXPIRE error', { 
        key, 
        error: error.message,
        host: config.get('redis.host')
      });
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
      logger.error('Redis VPS INCR error', { 
        key, 
        error: error.message,
        host: config.get('redis.host')
      });
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
      logger.error('Redis VPS PING error', { 
        error: error.message,
        host: config.get('redis.host')
      });
      throw error;
    }
  }
};

// ================================
// VPS CONNECTION HEALTH MONITORING
// ================================

let lastHealthCheck = Date.now();
const HEALTH_CHECK_INTERVAL = 60000; // 1 minute for VPS

async function performVPSHealthCheck() {
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
    
    // Log if any instance is slow (VPS threshold)
    if (mainRedisTime > 500 || queueRedisTime > 500 || sessionRedisTime > 500) {
      logger.warn('Redis VPS instances responding slowly', {
        mainRedis: mainRedisTime + 'ms',
        queueRedis: queueRedisTime + 'ms',
        sessionRedis: sessionRedisTime + 'ms',
        vpsHost: config.get('redis.host')
      });
    } else {
      logger.info('Redis VPS health check passed', {
        mainRedis: mainRedisTime + 'ms',
        queueRedis: queueRedisTime + 'ms',
        sessionRedis: sessionRedisTime + 'ms'
      });
    }
    
  } catch (error) {
    logger.error('Redis VPS health check failed', { 
      error: error.message,
      host: config.get('redis.host')
    });
  }
}

// Run VPS health checks
setInterval(performVPSHealthCheck, HEALTH_CHECK_INTERVAL);

// ================================
// VPS MEMORY MANAGEMENT
// ================================

async function checkRedisVPSMemory() {
  try {
    const memoryInfo = await redis.memory('usage', 'smartcv:*');
    const totalMemory = await redis.info('memory');
    
    // Parse memory info
    const usedMemory = totalMemory.match(/used_memory:(\d+)/);
    const maxMemory = totalMemory.match(/maxmemory:(\d+)/);
    
    if (usedMemory) {
      const usedMB = Math.round(parseInt(usedMemory[1]) / 1024 / 1024);
      
      logger.info('Redis VPS memory usage', {
        usedMemory: usedMB + 'MB',
        host: config.get('redis.host')
      });
      
      // Alert if memory usage is high
      if (usedMB > 500) { // Alert if using more than 500MB
        logger.warn('High Redis VPS memory usage', {
          usedMemory: usedMB + 'MB',
          host: config.get('redis.host')
        });
      }
    }
    
  } catch (error) {
    logger.error('Failed to check Redis VPS memory', { 
      error: error.message,
      host: config.get('redis.host')
    });
  }
}

// Check VPS memory every 10 minutes
setInterval(checkRedisVPSMemory, 600000);

// ================================
// VPS CLEANUP OPTIMIZATION
// ================================

async function performRedisVPSCleanup() {
  try {
    logger.info('Starting Redis VPS cleanup...');
    
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
      logger.info('Redis VPS cleanup completed', { 
        keysUpdated: cleanedCount,
        host: config.get('redis.host')
      });
    }
    
  } catch (error) {
    logger.error('Redis VPS cleanup failed', { 
      error: error.message,
      host: config.get('redis.host')
    });
  }
}

// Run VPS cleanup every 4 hours
setInterval(performRedisVPSCleanup, 14400000);

// ================================
// VPS GRACEFUL SHUTDOWN
// ================================

async function gracefulRedisVPSShutdown() {
  logger.info('Starting graceful Redis VPS shutdown...');
  
  try {
    await Promise.all([
      redis.quit(),
      queueRedis.quit(),
      sessionRedis.quit()
    ]);
    logger.info('All Redis VPS connections closed successfully');
  } catch (error) {
    logger.error('Error during Redis VPS shutdown', { 
      error: error.message,
      host: config.get('redis.host')
    });
  }
}

// Handle shutdown signals
process.on('SIGTERM', gracefulRedisVPSShutdown);
process.on('SIGINT', gracefulRedisVPSShutdown);

// ================================
// VPS STATUS FUNCTION
// ================================

function getRedisVPSStatus() {
  return {
    main: {
      status: redis.status,
      db: redisConfig.db,
      keyPrefix: redisConfig.keyPrefix,
      host: config.get('redis.host')
    },
    queue: {
      status: queueRedis.status,
      db: 1,
      host: config.get('redis.host')
    },
    session: {
      status: sessionRedis.status,
      db: 2,
      keyPrefix: 'session:',
      host: config.get('redis.host')
    },
    lastHealthCheck: new Date(lastHealthCheck).toISOString(),
    performance: {
      totalOperations: redisOperationCount,
      errorCount: redisErrorCount,
      slowOperations: slowOperationCount
    },
    vpsInfo: {
      host: config.get('redis.host'),
      port: config.get('redis.port'),
      environment: 'VPS Production'
    }
  };
}

// ================================
// EXPORTS
// ================================

module.exports = redisWrapper;
module.exports.redis = redis;
module.exports.queueRedis = queueRedis;
module.exports.sessionRedis = sessionRedis;
module.exports.getRedisStatus = getRedisVPSStatus;

// ================================
// VPS STARTUP LOGGING
// ================================

logger.info('🚀 Redis VPS configuration loaded for production deployment', {
  vpsHost: config.get('redis.host'),
  vpsPort: config.get('redis.port'),
  mainRedis: {
    db: redisConfig.db,
    keyPrefix: redisConfig.keyPrefix
  },
  queueRedis: {
    db: 1,
    purpose: 'BullMQ job queues'
  },
  sessionRedis: {
    db: 2,
    keyPrefix: 'session:',
    purpose: 'User sessions and temp data'
  },
  vpsOptimizations: [
    'Increased timeouts for VPS latency',
    'Enhanced error handling',
    'VPS-specific monitoring',
    'Network optimization',
    'Memory management'
  ]
});