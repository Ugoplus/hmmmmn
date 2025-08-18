const Redis = require('ioredis');
const config = require('./index');
const logger = require('../utils/logger');

// Single Redis configuration without duplicates
const redisConfig = {
  host: config.get('redis.host'),
  port: config.get('redis.port'),
  password: config.get('redis.password'),
  maxRetriesPerRequest: null, // Required for BullMQ
  enableReadyCheck: false,
  enableOfflineQueue: false,
  commandTimeout: 10000,
  lazyConnect: true,
  keepAlive: 30000,
  family: 4
};

// Main Redis instance
const redis = new Redis(redisConfig);

// Queue Redis (BullMQ compatible)
const queueRedis = new Redis({
  ...redisConfig,
  db: 1,
  keyPrefix: '', // Empty prefix for BullMQ
  enableAutoPipelining: false
});

// Session Redis
const sessionRedis = new Redis({
  ...redisConfig,
  db: 2,
  keyPrefix: 'session:'
});

// Event handlers
redis.on('connect', () => {
  logger.info('Main Redis connected successfully');
});

redis.on('error', (error) => {
  logger.error('Main Redis error', { error: error.message });
});

queueRedis.on('connect', () => {
  logger.info('Queue Redis connected successfully');
});

queueRedis.on('error', (error) => {
  logger.error('Queue Redis error', { error: error.message });
});

// Wrapper for safe operations
const redisWrapper = {
  async get(key) { return await redis.get(key); },
  async set(key, value, ...args) { return await redis.set(key, value, ...args); },
  async del(key) { return await redis.del(key); },
  async exists(key) { return await redis.exists(key); },
  async keys(pattern) { return await redis.keys(pattern); },
  async incr(key) { return await redis.incr(key); },
  async expire(key, seconds) { return await redis.expire(key, seconds); },
  async ttl(key) { return await redis.ttl(key); },
  async ping() { return await redis.ping(); }
};

module.exports = redisWrapper;
module.exports.redis = redis;
module.exports.queueRedis = queueRedis;
module.exports.sessionRedis = sessionRedis;