// services/autoApplyEngine.js - Core engine for automatic job applications

const dbManager = require('../config/database');
const logger = require('../utils/logger');
const queryExpansion = require('./queryExpansion');
const openaiService = require('./openai');
const atsScoring = require('./atsScoring');
const recruiterDigest = require('./recruiterDigest');
const { Queue } = require('bullmq');
const { queueRedis } = require('../config/redis');

// Reuse existing application queue
const applicationQueue = new Queue('job-applications', {
  connection: queueRedis,
  prefix: 'queue:'
});

class AutoApplyEngine {
  constructor() {
    this.batchSize = 10; // Process 10 jobs at a time
    this.processingInterval = 30 * 60 * 1000; // Check every 30 minutes
  }

  /**
   * Main function: Find and apply to new jobs for all active subscriptions
   * Run this via cron every 30 minutes or hourly
   */
  async processAllSubscriptions() {
    try {
      logger.info('Starting auto-apply processing cycle');

      // Get all active subscriptions with preferences
      const subscriptions = await this.getActiveSubscriptions();

      if (subscriptions.length === 0) {
        logger.info('No active subscriptions to process');
        return { processed: 0, applied: 0 };
      }

      logger.info(`Processing ${subscriptions.length} active subscriptions`);

      let totalProcessed = 0;
      let totalApplied = 0;

      for (const subscription of subscriptions) {
        try {
          const result = await this.processSubscription(subscription);
          totalProcessed++;
          totalApplied += result.applied;

        } catch (error) {
          logger.error('Failed to process subscription', {
            subscriptionId: subscription.id,
            userId: subscription.user_identifier.substring(0, 6) + '***',
            error: error.message
          });
        }
      }

      logger.info('Auto-apply cycle complete', {
        subscriptionsProcessed: totalProcessed,
        totalApplications: totalApplied
      });

      return {
        processed: totalProcessed,
        applied: totalApplied
      };

    } catch (error) {
      logger.error('Auto-apply processing failed', {
        error: error.message
      });
      return { processed: 0, applied: 0 };
    }
  }

  /**
   * Get all active subscriptions
   */
  async getActiveSubscriptions() {
    try {
      const result = await dbManager.query(`
        SELECT 
          s.id, s.user_identifier, s.tier, s.jobs_applied, s.max_jobs,
          s.valid_until
        FROM auto_apply_subscriptions s
        WHERE s.status = 'active'
          AND s.valid_until > NOW()
          AND (
            s.tier = 'unlimited' 
            OR (s.tier = 'basic' AND s.jobs_applied < s.max_jobs)
          )
      `);

      return result.rows;

    } catch (error) {
      logger.error('Failed to get active subscriptions', {
        error: error.message
      });
      return [];
    }
  }

  /**
   * Process a single subscription
   */
  async processSubscription(subscription) {
    try {
      logger.info('Processing subscription', {
        subscriptionId: subscription.id,
        userId: subscription.user_identifier.substring(0, 6) + '***',
        tier: subscription.tier,
        jobsApplied: subscription.jobs_applied
      });

      // Get user's preferences
      const preferences = await this.getUserPreferences(subscription.id);

      if (preferences.length === 0) {
        logger.info('No preferences set for subscription', {
          subscriptionId: subscription.id
        });
        return { applied: 0 };
      }

      let totalApplied = 0;

      // Process each preference
      for (const preference of preferences) {
        try {
          // Check if we hit the limit
          if (subscription.tier === 'basic' && 
              subscription.jobs_applied + totalApplied >= subscription.max_jobs) {
            logger.info('Basic tier limit reached', {
              subscriptionId: subscription.id,
              limit: subscription.max_jobs
            });
            break;
          }

          const applied = await this.processPreference(subscription, preference);
          totalApplied += applied;

        } catch (error) {
          logger.error('Failed to process preference', {
            preferenceId: preference.id,
            error: error.message
          });
        }
      }

      return { applied: totalApplied };

    } catch (error) {
      logger.error('Failed to process subscription', {
        subscriptionId: subscription.id,
        error: error.message
      });
      return { applied: 0 };
    }
  }

  /**
   * Get user preferences
   */
  async getUserPreferences(subscriptionId) {
    try {
      const result = await dbManager.query(`
        SELECT 
          id, job_category, job_category_label, location, 
          is_remote, expanded_keywords, jobs_applied,
          last_job_applied_at
        FROM auto_apply_preferences
        WHERE subscription_id = $1 AND is_active = true
      `, [subscriptionId]);

      return result.rows;

    } catch (error) {
      logger.error('Failed to get user preferences', {
        subscriptionId,
        error: error.message
      });
      return [];
    }
  }

  /**
   * Process a single preference (find and apply to matching jobs)
   */
  async processPreference(subscription, preference) {
    try {
      logger.info('Processing preference', {
        preferenceId: preference.id,
        category: preference.job_category_label,
        location: preference.location
      });

      // Get CV text for user
      const cvText = await this.getUserCV(subscription.user_identifier);

      if (!cvText) {
        logger.warn('No CV found for user', {
          userId: subscription.user_identifier.substring(0, 6) + '***'
        });
        return 0;
      }

      // Get or generate query expansion
      let expansion = preference.expanded_keywords;
      
      if (!expansion) {
        expansion = await queryExpansion.expandQuery(
          preference.job_category_label,
          preference.job_category
        );

        // Save for future use
        await dbManager.query(`
          UPDATE auto_apply_preferences
          SET expanded_keywords = $1, updated_at = NOW()
          WHERE id = $2
        `, [JSON.stringify(expansion), preference.id]);
      } else if (typeof expansion === 'string') {
        expansion = JSON.parse(expansion);
      }

      // Find new jobs matching this preference
      const newJobs = await this.findNewJobs(preference, expansion, subscription.user_identifier);

      if (newJobs.length === 0) {
        logger.info('No new jobs found for preference', {
          preferenceId: preference.id
        });
        return 0;
      }

      // Filter for relevance (auto-apply needs high confidence)
      const relevantJobs = await queryExpansion.filterForAutoApply(
        newJobs,
        preference.job_category_label,
        expansion
      );

      if (relevantJobs.length === 0) {
        logger.info('No relevant jobs after filtering', {
          preferenceId: preference.id,
          foundJobs: newJobs.length
        });
        return 0;
      }

      logger.info('Found relevant jobs for auto-apply', {
        preferenceId: preference.id,
        relevantCount: relevantJobs.length
      });

      // Apply to jobs (respect limits)
      const applied = await this.applyToJobs(
        subscription,
        preference,
        relevantJobs,
        cvText
      );

      return applied;

    } catch (error) {
      logger.error('Failed to process preference', {
        preferenceId: preference.id,
        error: error.message
      });
      return 0;
    }
  }

  /**
   * Get user's CV text
   */
  async getUserCV(userId) {
    try {
      // Try to get from most recent application
      const result = await dbManager.query(`
        SELECT cv_text
        FROM applications
        WHERE user_identifier = $1
          AND cv_text IS NOT NULL
        ORDER BY applied_at DESC
        LIMIT 1
      `, [userId]);

      if (result.rows.length > 0) {
        return result.rows[0].cv_text;
      }

      return null;

    } catch (error) {
      logger.error('Failed to get user CV', {
        userId: userId?.substring(0, 6) + '***',
        error: error.message
      });
      return null;
    }
  }

  /**
   * Find new jobs matching preference
   */
  async findNewJobs(preference, expansion, userId) {
    try {
      // Build search query
      const { whereClause, params } = queryExpansion.buildSearchQuery(
        expansion,
        preference.location
      );

      // Exclude jobs already applied to by this user
      const excludeClause = `
        AND j.id NOT IN (
          SELECT job_id FROM applications WHERE user_identifier = $${params.length + 1}
        )
      `;

      params.push(userId);

      // Get last check time (or 24 hours ago if never checked)
      const sinceTime = preference.last_job_applied_at || new Date(Date.now() - 24 * 60 * 60 * 1000);
      
      params.push(sinceTime);
      const timeClause = `AND (j.last_updated > $${params.length} OR j.scraped_at > $${params.length})`;

      const query = `
        SELECT j.* FROM jobs j
        ${whereClause}
        ${excludeClause}
        ${timeClause}
        ORDER BY COALESCE(j.last_updated, j.scraped_at, NOW()) DESC
        LIMIT 20
      `;

      const result = await dbManager.query(query, params);

      logger.info('New jobs query executed', {
        preferenceId: preference.id,
        foundJobs: result.rows.length
      });

      return result.rows;

    } catch (error) {
      logger.error('Failed to find new jobs', {
        preferenceId: preference.id,
        error: error.message
      });
      return [];
    }
  }

  /**
   * Apply to jobs
   */
  async applyToJobs(subscription, preference, jobs, cvText) {
    try {
      let applied = 0;
      const maxToApply = subscription.tier === 'unlimited' ? jobs.length : 
                         Math.min(jobs.length, subscription.max_jobs - subscription.jobs_applied);

      const jobsToApply = jobs.slice(0, maxToApply);

      logger.info('Starting auto-applications', {
        subscriptionId: subscription.id,
        jobCount: jobsToApply.length
      });

      for (const job of jobsToApply) {
        try {
          // Queue application
          await this.queueApplication(subscription, preference, job, cvText);
          applied++;

          // Update counters
          await this.updateCounters(subscription.id, preference.id);

        } catch (error) {
          logger.error('Failed to queue application', {
            jobId: job.id,
            error: error.message
          });
        }
      }

      logger.info('Auto-applications queued', {
        subscriptionId: subscription.id,
        applied
      });

      return applied;

    } catch (error) {
      logger.error('Failed to apply to jobs', {
        subscriptionId: subscription.id,
        error: error.message
      });
      return 0;
    }
  }

  /**
   * Queue a single application
   */
  async queueApplication(subscription, preference, job, cvText) {
    try {
      const applicationId = require('uuid').v4();

      // Extract user info from CV (cached)
      const userInfo = await openaiService.extractUserInfo(cvText, subscription.user_identifier);

      // Create application record
      await dbManager.query(`
        INSERT INTO applications (
          id, user_identifier, job_id, cv_text,
          status, applied_at, applicant_name, applicant_email, applicant_phone
        ) VALUES ($1, $2, $3, $4, 'queued', NOW(), $5, $6, $7)
      `, [
        applicationId,
        subscription.user_identifier,
        job.id,
        cvText,
        userInfo.name,
        userInfo.email,
        userInfo.phone
      ]);

      // Track for digest instead of immediate email
      await recruiterDigest.trackForDigest(
        job.email,
        job.id,
        applicationId,
        userInfo
      );

      // Queue ATS scoring
      await atsScoring.queueScoring(applicationId, subscription.user_identifier, job.id, cvText);

      // Add to auto-apply queue tracking
      await dbManager.query(`
        INSERT INTO auto_apply_queue (
          subscription_id, preference_id, user_identifier, job_id,
          application_id, status
        ) VALUES ($1, $2, $3, $4, $5, 'applied')
      `, [
        subscription.id,
        preference.id,
        subscription.user_identifier,
        job.id,
        applicationId
      ]);

      logger.info('Application queued for auto-apply', {
        applicationId,
        jobId: job.id,
        jobTitle: job.title,
        company: job.company
      });

    } catch (error) {
      logger.error('Failed to queue application', {
        jobId: job.id,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Update subscription and preference counters
   */
  async updateCounters(subscriptionId, preferenceId) {
    try {
      // Update subscription
      await dbManager.query(`
        UPDATE auto_apply_subscriptions
        SET jobs_applied = jobs_applied + 1, updated_at = NOW()
        WHERE id = $1
      `, [subscriptionId]);

      // Update preference
      await dbManager.query(`
        UPDATE auto_apply_preferences
        SET 
          jobs_applied = jobs_applied + 1,
          last_job_applied_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
      `, [preferenceId]);

    } catch (error) {
      logger.error('Failed to update counters', {
        subscriptionId,
        preferenceId,
        error: error.message
      });
    }
  }

  /**
   * Get auto-apply statistics
   */
  async getStatistics(days = 7) {
    try {
      const result = await dbManager.query(`
        SELECT 
          COUNT(DISTINCT subscription_id) as active_subscriptions,
          COUNT(DISTINCT user_identifier) as active_users,
          COUNT(*) as total_applications,
          COUNT(CASE WHEN status = 'applied' THEN 1 END) as successful_applications,
          COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_applications
        FROM auto_apply_queue
        WHERE queued_at > NOW() - INTERVAL '${days} days'
      `);

      return result.rows[0];

    } catch (error) {
      logger.error('Failed to get auto-apply statistics', {
        error: error.message
      });
      return null;
    }
  }
}

module.exports = new AutoApplyEngine();