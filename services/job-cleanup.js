const dbManager = require('../config/database');
const logger = require('../utils/logger');
const cron = require('node-cron');

class JobCleanupService {
  constructor() {
    this.setupCronJobs();
  }

  async expireOldJobs() {
    try {
      const result = await dbManager.query(`
        UPDATE jobs 
        SET is_remote = false, last_updated = NOW()
        WHERE expires_at < NOW() 
        AND is_remote = true
        RETURNING id, title, company
      `);

      if (result.rows.length > 0) {
        logger.info(`Expired ${result.rows.length} old jobs`, {
          expiredJobs: result.rows.map(job => ({
            id: job.id,
            title: job.title,
            company: job.company
          }))
        });
      }

      return result.rows.length;
    } catch (error) {
      logger.error('Failed to expire old jobs', { error: error.message });
      return 0;
    }
  }

  async getJobStats() {
    try {
      const stats = await dbManager.query(`
        SELECT 
          COUNT(*) as total_jobs,
          COUNT(*) FILTER (WHERE is_remote = true) as active_jobs,
          COUNT(*) FILTER (WHERE expires_at < NOW()) as expired_jobs,
          COUNT(*) FILTER (WHERE expires_at BETWEEN NOW() AND NOW() + INTERVAL '7 days') as expiring_soon,
          MAX(scraped_at) as latest_scrape
        FROM jobs 
        WHERE source = 'jobzilla_ng' OR source IS NULL
      `);

      return stats.rows[0];
    } catch (error) {
      logger.error('Failed to get job stats', { error: error.message });
      return {};
    }
  }

  async deleteExpiredJobs(olderThanDays = 60) {
    try {
      const result = await dbManager.query(`
        DELETE FROM jobs 
        WHERE expires_at < NOW() - INTERVAL '${olderThanDays} days'
        AND source = 'jobzilla_ng'
        RETURNING id, title
      `);

      if (result.rows.length > 0) {
        logger.info(`Permanently deleted ${result.rows.length} very old jobs`);
      }

      return result.rows.length;
    } catch (error) {
      logger.error('Failed to delete expired jobs', { error: error.message });
      return 0;
    }
  }

  setupCronJobs() {
    // Expire old jobs every hour
    cron.schedule('0 * * * *', async () => {
      logger.info('Running scheduled job expiry...');
      await this.expireOldJobs();
    });

    // Delete very old expired jobs weekly (Sunday at 2 AM)
    cron.schedule('0 2 * * 0', async () => {
      logger.info('Running weekly cleanup of very old jobs...');
      await this.deleteExpiredJobs(60); // Delete jobs expired for more than 60 days
    });

    // Log job stats daily (every day at 9 AM)
    cron.schedule('0 9 * * *', async () => {
      const stats = await this.getJobStats();
      logger.info('Daily job statistics', stats);
    });

    logger.info('Job cleanup cron jobs scheduled');
  }

  async runManualCleanup() {
    logger.info('Running manual job cleanup...');
    
    const stats = await this.getJobStats();
    logger.info('Current job stats before cleanup', stats);
    
    const expiredCount = await this.expireOldJobs();
    const deletedCount = await this.deleteExpiredJobs();
    
    const newStats = await this.getJobStats();
    logger.info('Job stats after cleanup', newStats);
    
    return {
      before: stats,
      expired: expiredCount,
      deleted: deletedCount,
      after: newStats
    };
  }
}

module.exports = new JobCleanupService();