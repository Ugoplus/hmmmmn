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
  enableOfflineQueue: true,
  commandTimeout: 10000,
  lazyConnect: true,
  keepAlive: 30000,
  family: 4
};

// Main Redis instance (DB0)
const redis = new Redis(redisConfig);

// Queue Redis (BullMQ compatible, DB1)
const queueRedis = new Redis({
  ...redisConfig,
  db: 1,
  keyPrefix: '',
  enableAutoPipelining: false
});

// Session Redis (DB2)
const sessionRedis = new Redis({
  ...redisConfig,
  db: 2,
  keyPrefix: 'session:'
});

// Event handlers
redis.on('connect', () => logger.info('Main Redis connected successfully'));
redis.on('error', (error) => logger.error('Main Redis error', { error: error.message }));

queueRedis.on('connect', () => logger.info('Queue Redis connected successfully'));
queueRedis.on('error', (error) => logger.error('Queue Redis error', { error: error.message }));

sessionRedis.on('connect', () => logger.info('Session Redis connected successfully'));
sessionRedis.on('error', (error) => logger.error('Session Redis error', { error: error.message }));

// Safe wrapper for simple operations (always DB0)
const redisWrapper = {
  async get(key) { return redis.get(key); },
  async set(key, value, ...args) { return redis.set(key, value, ...args); },
  async del(key) { return redis.del(key); },
  async exists(key) { return redis.exists(key); },
  async keys(pattern) { return redis.keys(pattern); },
  async incr(key) { return redis.incr(key); },
  async expire(key, seconds) { return redis.expire(key, seconds); },
  async ttl(key) { return redis.ttl(key); },
  async ping() { return redis.ping(); }
};

module.exports = {
  redis,         // Main Redis
  queueRedis,    // For BullMQ queues
  sessionRedis,  // For session context
  redisWrapper   // For simple key/value ops
};
