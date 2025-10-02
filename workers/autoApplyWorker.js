// workers/autoApplyWorker.js - Scheduled worker for auto-apply processing

require('dotenv').config();
const cron = require('node-cron');
const autoApplyEngine = require('../services/autoApplyEngine');
const recruiterDigest = require('../services/recruiterDigest');
const autoApplyPayment = require('../services/autoApplyPayment');
const queryExpansion = require('../services/queryExpansion');
const logger = require('../utils/logger');

class AutoApplyWorker {
  constructor() {
    this.jobs = [];
  }

  /**
   * Start all scheduled jobs
   */
  start() {
    logger.info('Starting Auto-Apply Worker');

    // 1. Process auto-applications every 30 minutes
    const autoApplyJob = cron.schedule('*/30 * * * *', async () => {
      try {
        logger.info('Running auto-apply processing cycle');
        const result = await autoApplyEngine.processAllSubscriptions();
        logger.info('Auto-apply cycle complete', result);
      } catch (error) {
        logger.error('Auto-apply cycle failed', { error: error.message });
      }
    });

    this.jobs.push({ name: 'auto-apply-processor', job: autoApplyJob });

    // 2. Send recruiter digests daily at 6 PM
    const digestJob = cron.schedule('0 18 * * *', async () => {
      try {
        logger.info('Running daily recruiter digest');
        const result = await recruiterDigest.sendPendingDigests();
        logger.info('Digest sending complete', result);
      } catch (error) {
        logger.error('Digest sending failed', { error: error.message });
      }
    });

    this.jobs.push({ name: 'recruiter-digest', job: digestJob });

    // 3. Clean up expired subscriptions daily at midnight
    const cleanupJob = cron.schedule('0 0 * * *', async () => {
      try {
        logger.info('Running subscription cleanup');
        const count = await autoApplyPayment.cleanupExpiredSubscriptions();
        logger.info('Cleanup complete', { expiredCount: count });
      } catch (error) {
        logger.error('Cleanup failed', { error: error.message });
      }
    });

    this.jobs.push({ name: 'subscription-cleanup', job: cleanupJob });

    // 4. Clean query expansion cache daily at 2 AM
    const cacheCleanupJob = cron.schedule('0 2 * * *', async () => {
      try {
        logger.info('Running query cache cleanup');
        const count = await queryExpansion.cleanExpiredCache();
        logger.info('Cache cleanup complete', { deletedCount: count });
      } catch (error) {
        logger.error('Cache cleanup failed', { error: error.message });
      }
    });

    this.jobs.push({ name: 'cache-cleanup', job: cacheCleanupJob });

    // 5. Log statistics every hour
    const statsJob = cron.schedule('0 * * * *', async () => {
      try {
        const stats = await autoApplyEngine.getStatistics(7);
        logger.info('Auto-apply statistics', stats);
      } catch (error) {
        logger.error('Stats logging failed', { error: error.message });
      }
    });

    this.jobs.push({ name: 'statistics', job: statsJob });

    logger.info('All scheduled jobs started', {
      jobCount: this.jobs.length,
      jobs: this.jobs.map(j => j.name)
    });
  }

  /**
   * Stop all scheduled jobs
   */
  stop() {
    logger.info('Stopping Auto-Apply Worker');
    
    this.jobs.forEach(({ name, job }) => {
      job.stop();
      logger.info(`Stopped job: ${name}`);
    });

    this.jobs = [];
  }

  /**
   * Manual trigger for testing
   */
  async runManualCycle() {
    logger.info('Running manual auto-apply cycle');

    try {
      const result = await autoApplyEngine.processAllSubscriptions();
      logger.info('Manual cycle complete', result);
      return result;
    } catch (error) {
      logger.error('Manual cycle failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Manual digest trigger for testing
   */
  async sendManualDigest() {
    logger.info('Running manual digest send');

    try {
      const result = await recruiterDigest.sendPendingDigests();
      logger.info('Manual digest complete', result);
      return result;
    } catch (error) {
      logger.error('Manual digest failed', { error: error.message });
      throw error;
    }
  }
}

// Create singleton instance
const worker = new AutoApplyWorker();

// Auto-start if running as main module
if (require.main === module) {
  worker.start();

  // Graceful shutdown
  process.on('SIGTERM', () => {
    logger.info('SIGTERM received, shutting down gracefully');
    worker.stop();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    logger.info('SIGINT received, shutting down gracefully');
    worker.stop();
    process.exit(0);
  });

  logger.info('Auto-Apply Worker is running. Press Ctrl+C to exit.');
}

module.exports = worker;