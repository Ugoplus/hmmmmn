// config/redis.js - ENHANCED FOR SCALE
const Redis = require('ioredis');
const config = require('./index');
const logger = require('../utils/logger');

// Enhanced Redis configuration for high concurrency
const redisConfig = {
  host: config.get('redis.host'),
  port: config.get('redis.port'),
  password: config.get('redis.password'),
  
  // CRITICAL SCALING CHANGES
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 100,
  connectTimeout: 10000,
  lazyConnect: true,
  keepAlive: 30000,
  family: 4, // Force IPv4
  
  // Connection pool settings
  enableReadyCheck: false,
  enableOfflineQueue: false,
  
  // Memory optimization
  keyPrefix: 'smartcv:',
  db: 0,
};

// Main Redis instance for caching
const redis = new Redis(redisConfig);

// Separate Redis instance for BullMQ queues (better performance)
const queueRedis = new Redis({
  ...redisConfig,
  db: 1, // Different database
  maxRetriesPerRequest: null, // Required for BullMQ
});

redis.setMaxListeners(20);
queueRedis.setMaxListeners(20);

// Enhanced error handling
redis.on('error', (error) => {
  logger.error('Redis connection error', { error: error.message });
});

redis.on('connect', () => {
  logger.info('Redis connected successfully', { 
    host: config.get('redis.host'),
    port: config.get('redis.port')
  });
});

redis.on('ready', () => {
  logger.info('Redis ready for commands');
});

redis.on('reconnecting', (delay) => {
  logger.warn('Redis reconnecting...', { delay });
});

// Queue Redis events
queueRedis.on('error', (error) => {
  logger.error('Queue Redis connection error', { error: error.message });
});

queueRedis.on('connect', () => {
  logger.info('Queue Redis connected successfully');
});

// Export both instances
module.exports = redis;
module.exports.queueRedis = queueRedis;