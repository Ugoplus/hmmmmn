const { sessionRedis } = require('../config/redis');
const logger = require('../utils/logger');

async function getSessionContext(phone) {
  try {
    const key = `session:${phone}`;
    const value = await sessionRedis.get(key);
    return value ? JSON.parse(value) : {};
  } catch (err) {
    logger.error('Failed to get session context', { phone, error: err.message });
    return {};
  }
}

async function saveSessionContext(phone, context) {
  try {
    const key = `session:${phone}`;
    await sessionRedis.set(key, JSON.stringify(context), 'EX', 3600); // 1h expiry
    logger.debug('Session context saved', { phone, contextKeys: Object.keys(context) });
  } catch (err) {
    logger.error('Failed to save session context', { phone, error: err.message });
  }
}

async function clearSessionContext(phone) {
  try {
    const key = `session:${phone}`;
    await sessionRedis.del(key);
    logger.info('Session context cleared', { phone });
  } catch (err) {
    logger.error('Failed to clear session context', { phone, error: err.message });
  }
}

module.exports = {
  getSessionContext,
  saveSessionContext,
  clearSessionContext
};