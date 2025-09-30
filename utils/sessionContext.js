const { sessionRedis } = require('../config/redis');
const logger = require('../utils/logger');

async function getSessionContext(phone) {
  try {
    const key = `session:${phone}`;
    const value = await sessionRedis.get(key);
    const context = value ? JSON.parse(value) : {};
    
    logger.debug('Session context loaded', { 
      phone: phone.substring(0, 6) + '***',
      pendingJobType: context.pendingJobType,
      lastJobType: context.lastJobType,
      hasData: !!value
    });
    
    return context;
  } catch (err) {
    logger.error('Failed to get session context', { phone, error: err.message });
    return {};
  }
}

async function saveSessionContext(phone, context) {
  try {
    const key = `session:${phone}`;
    
    // SET returns 'OK' on success
    const result = await sessionRedis.set(key, JSON.stringify(context), 'EX', 3600);
    
    if (result === 'OK') {
      logger.debug('Session context saved successfully', { 
        phone: phone.substring(0, 6) + '***',
        contextKeys: Object.keys(context),
        pendingJobType: context.pendingJobType,
        lastJobType: context.lastJobType
      });
      return true;
    } else {
      logger.error('Session save returned unexpected result', { 
        phone: phone.substring(0, 6) + '***',
        result 
      });
      return false;
    }
  } catch (err) {
    logger.error('Failed to save session context', { 
      phone: phone.substring(0, 6) + '***',
      error: err.message 
    });
    return false;
  }
}

async function clearSessionContext(phone) {
  try {
    const key = `session:${phone}`;
    const result = await sessionRedis.del(key);
    logger.info('Session context cleared', { 
      phone: phone.substring(0, 6) + '***',
      keysDeleted: result 
    });
    return result > 0;
  } catch (err) {
    logger.error('Failed to clear session context', { 
      phone: phone.substring(0, 6) + '***',
      error: err.message 
    });
    return false;
  }
}

module.exports = {
  getSessionContext,
  saveSessionContext,
  clearSessionContext
};