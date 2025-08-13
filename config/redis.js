const Redis = require('ioredis');
const config = require('./index');
const logger = require('../utils/logger');

const redis = new Redis({
  host: config.get('redis.host'),
  port: config.get('redis.port'),
  password: config.get('redis.password'),
  maxRetriesPerRequest: null,
  lazyConnect: true,
  retryDelayOnFailover: 100,
  connectTimeout: 10000,
});

redis.setMaxListeners(20);

redis.on('error', (error) => {
  logger.error('Redis connection error', { error: error.message });
});

redis.on('connect', () => {
  logger.info('Redis connected successfully');
});

redis.on('ready', () => {
  logger.info('Redis ready for commands');
});

redis.on('reconnecting', () => {
  logger.warn('Redis reconnecting...');
});

module.exports = redis;
