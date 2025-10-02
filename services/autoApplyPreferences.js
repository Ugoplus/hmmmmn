// services/autoApplyPreferences.js - Manage user auto-apply preferences with YCloud interactive

const ycloud = require('./ycloud');
const dbManager = require('../config/database');
const logger = require('../utils/logger');
const { redis } = require('../config/redis');

class AutoApplyPreferencesService {
  constructor() {
    // Job categories for interactive selection
    this.categories = {
      'it_software': 'IT & Software Development',
      'accounting_finance': 'Accounting & Finance',
      'marketing_sales': 'Sales & Marketing',
      'healthcare_medical': 'Healthcare & Medical',
      'engineering_technical': 'Engineering & Technical',
      'education_training': 'Education & Training',
      'admin_office': 'Administration & Office',
      'management_executive': 'Management & Executive',
      'human_resources': 'Human Resources',
      'customer_service': 'Customer Service',
      'legal_compliance': 'Legal & Compliance',
      'media_creative': 'Media & Creative',
      'logistics_supply': 'Logistics & Supply Chain',
      'security_safety': 'Security & Safety',
      'construction_real_estate': 'Construction & Real Estate',
      'manufacturing_production': 'Manufacturing & Production',
      'transport_driving': 'Transport & Driving',
      'retail_fashion': 'Retail & Fashion',
      'other_general': 'General Jobs'
    };

    this.locations = [
      'Lagos', 'Abuja', 'Port Harcourt', 'Kano', 'Ibadan',
      'Jos', 'Kaduna', 'Enugu', 'Benin', 'Calabar',
      'Oyo', 'Abia', 'Delta', 'Edo', 'Rivers',
      'Anambra', 'Imo', 'Ogun', 'Ondo', 'Osun',
      'Remote'
    ];
  }

  /**
   * Show interactive preference setup menu
   */
  async showPreferenceSetup(phone, subscriptionId) {
    try {
      // Check existing preferences count
      const existing = await this.getUserPreferences(phone, subscriptionId);
      
      const sections = [{
        title: "Setup Options",
        rows: [
          {
            id: 'pref_add_new',
            title: '➕ Add Job Preference',
            description: 'Set category & location to watch'
          },
          {
            id: 'pref_view_all',
            title: '📋 View My Preferences',
            description: `${existing.length} active preference${existing.length !== 1 ? 's' : ''}`
          }
        ]
      }];

      // Add remove option if preferences exist
      if (existing.length > 0) {
        sections[0].rows.push({
          id: 'pref_remove',
          title: '🗑️ Remove Preference',
          description: 'Stop watching a category'
        });
      }

      await ycloud.sendInteractiveListMessage(
        phone,
        "Auto-Apply Preferences",
        "Manage your job watching preferences:",
        sections,
        "Choose Action"
      );

      await redis.set(`state:${phone}`, 'preference_menu', 'EX', 3600);

      return true;

    } catch (error) {
      logger.error('Failed to show preference setup', {
        phone: phone.substring(0, 6) + '***',
        error: error.message
      });
      return false;
    }
  }

  /**
   * Show category selection (step 1)
   */
  async showCategorySelection(phone) {
    try {
      // Split into two messages for better UX (max 10 items per list)
      const categoryEntries = Object.entries(this.categories);
      const firstHalf = categoryEntries.slice(0, 10);
      const secondHalf = categoryEntries.slice(10);

      // First list
      const sections1 = [{
        title: "Job Categories (1/2)",
        rows: firstHalf.map(([key, label]) => ({
          id: `cat_${key}`,
          title: label.substring(0, 24), // YCloud limit
          description: `Watch ${label.toLowerCase()} jobs`
        }))
      }];

      await ycloud.sendInteractiveListMessage(
        phone,
        "Select Job Category (Part 1)",
        "Choose the type of jobs to auto-apply:",
        sections1,
        "Select Category"
      );

      // Second list after 1.5 seconds
      setTimeout(async () => {
        const sections2 = [{
          title: "Job Categories (2/2)",
          rows: secondHalf.map(([key, label]) => ({
            id: `cat_${key}`,
            title: label.substring(0, 24),
            description: `Watch ${label.toLowerCase()} jobs`
          }))
        }];

        await ycloud.sendInteractiveListMessage(
          phone,
          "Select Job Category (Part 2)",
          "Or choose from these categories:",
          sections2,
          "Select Category"
        );
      }, 1500);

      await redis.set(`state:${phone}`, 'selecting_category', 'EX', 3600);

      return true;

    } catch (error) {
      logger.error('Failed to show category selection', {
        phone: phone.substring(0, 6) + '***',
        error: error.message
      });
      return false;
    }
  }

  /**
   * Show location selection (step 2)
   */
  async showLocationSelection(phone, category) {
    try {
      // Store selected category
      await redis.set(`temp_category:${phone}`, JSON.stringify({
        key: category,
        label: this.categories[category]
      }), 'EX', 3600);

      // Split locations into two lists (max 10 each)
      const firstHalf = this.locations.slice(0, 10);
      const secondHalf = this.locations.slice(10);

      // First list
      const sections1 = [{
        title: "Locations (1/2)",
        rows: firstHalf.map(loc => ({
          id: `loc_${loc.toLowerCase().replace(/\s+/g, '_')}`,
          title: loc,
          description: `Jobs in ${loc}`
        }))
      }];

      await ycloud.sendInteractiveListMessage(
        phone,
        "Select Location (Part 1)",
        `Where should we watch for ${this.categories[category]} jobs?`,
        sections1,
        "Select Location"
      );

      // Second list
      setTimeout(async () => {
        const sections2 = [{
          title: "Locations (2/2)",
          rows: secondHalf.map(loc => ({
            id: `loc_${loc.toLowerCase().replace(/\s+/g, '_')}`,
            title: loc,
            description: `Jobs in ${loc}`
          }))
        }];

        await ycloud.sendInteractiveListMessage(
          phone,
          "Select Location (Part 2)",
          "Or choose from these locations:",
          sections2,
          "Select Location"
        );
      }, 1500);

      await redis.set(`state:${phone}`, 'selecting_location', 'EX', 3600);

      return true;

    } catch (error) {
      logger.error('Failed to show location selection', {
        phone: phone.substring(0, 6) + '***',
        error: error.message
      });
      return false;
    }
  }

  /**
   * Save user preference
   */
  async savePreference(phone, subscriptionId, category, location) {
    try {
      const categoryLabel = this.categories[category];
      const isRemote = location.toLowerCase() === 'remote';

      // Check if preference already exists
      const existing = await dbManager.query(`
        SELECT id FROM auto_apply_preferences
        WHERE subscription_id = $1 
          AND job_category = $2 
          AND location = $3
          AND is_active = true
      `, [subscriptionId, category, location]);

      if (existing.rows.length > 0) {
        return {
          success: false,
          message: 'You already have this preference active!'
        };
      }

      // Insert new preference
      const result = await dbManager.query(`
        INSERT INTO auto_apply_preferences (
          subscription_id, user_identifier, job_category,
          job_category_label, location, is_remote
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
      `, [subscriptionId, phone, category, categoryLabel, location, isRemote]);

      logger.info('Auto-apply preference saved', {
        phone: phone.substring(0, 6) + '***',
        category: categoryLabel,
        location
      });

      return {
        success: true,
        preferenceId: result.rows[0].id,
        category: categoryLabel,
        location
      };

    } catch (error) {
      logger.error('Failed to save preference', {
        phone: phone.substring(0, 6) + '***',
        error: error.message
      });
      return {
        success: false,
        message: 'Failed to save preference. Please try again.'
      };
    }
  }

  /**
   * Get user preferences
   */
  async getUserPreferences(phone, subscriptionId = null) {
    try {
      let query = `
        SELECT 
          p.id, p.job_category, p.job_category_label, 
          p.location, p.is_remote, p.jobs_matched, 
          p.jobs_applied, p.last_job_applied_at, p.created_at
        FROM auto_apply_preferences p
      `;

      let params = [];
      
      if (subscriptionId) {
        query += ` WHERE p.subscription_id = $1 AND p.is_active = true`;
        params = [subscriptionId];
      } else {
        query += ` 
          INNER JOIN auto_apply_subscriptions s ON p.subscription_id = s.id
          WHERE p.user_identifier = $1 
            AND p.is_active = true
            AND s.status = 'active'
            AND s.valid_until > NOW()
        `;
        params = [phone];
      }

      query += ` ORDER BY p.created_at DESC`;

      const result = await dbManager.query(query, params);

      return result.rows;

    } catch (error) {
      logger.error('Failed to get user preferences', {
        phone: phone?.substring(0, 6) + '***',
        error: error.message
      });
      return [];
    }
  }

  /**
   * Show user's active preferences
   */
  async showUserPreferences(phone, subscriptionId) {
    try {
      const preferences = await this.getUserPreferences(phone, subscriptionId);

      if (preferences.length === 0) {
        await ycloud.sendTextMessage(phone, 
          '📋 No Active Preferences\n\n' +
          'You haven\'t set up any job watching preferences yet.\n\n' +
          'Reply with "add preference" to get started!'
        );
        return true;
      }

      let message = `📋 Your Auto-Apply Preferences\n\n`;
      
      preferences.forEach((pref, index) => {
        message += `${index + 1}. ${pref.job_category_label}\n`;
        message += `   📍 ${pref.location}\n`;
        message += `   ✅ ${pref.jobs_applied || 0} applied\n`;
        if (pref.last_job_applied_at) {
          const lastApplied = new Date(pref.last_job_applied_at);
          const daysAgo = Math.floor((Date.now() - lastApplied) / (1000 * 60 * 60 * 24));
          message += `   🕐 Last: ${daysAgo === 0 ? 'Today' : daysAgo + ' days ago'}\n`;
        }
        message += '\n';
      });

      message += '💡 We automatically apply when new matching jobs are found!\n\n';
      message += 'Reply "add preference" to watch more categories.';

      await ycloud.sendTextMessage(phone, message);

      return true;

    } catch (error) {
      logger.error('Failed to show user preferences', {
        phone: phone.substring(0, 6) + '***',
        error: error.message
      });
      return false;
    }
  }

  /**
   * Show preference removal options
   */
  async showRemovalOptions(phone, subscriptionId) {
    try {
      const preferences = await this.getUserPreferences(phone, subscriptionId);

      if (preferences.length === 0) {
        await ycloud.sendTextMessage(phone, 
          'No preferences to remove. Add a preference first!'
        );
        return true;
      }

      const sections = [{
        title: "Remove Preference",
        rows: preferences.map((pref, index) => ({
          id: `remove_${pref.id}`,
          title: pref.job_category_label.substring(0, 24),
          description: `${pref.location} - ${pref.jobs_applied || 0} applied`
        }))
      }];

      await ycloud.sendInteractiveListMessage(
        phone,
        "Remove Preference",
        "Select preference to stop watching:",
        sections,
        "Remove"
      );

      await redis.set(`state:${phone}`, 'removing_preference', 'EX', 3600);

      return true;

    } catch (error) {
      logger.error('Failed to show removal options', {
        phone: phone.substring(0, 6) + '***',
        error: error.message
      });
      return false;
    }
  }

  /**
   * Remove preference
   */
  async removePreference(preferenceId, phone) {
    try {
      const result = await dbManager.query(`
        UPDATE auto_apply_preferences
        SET is_active = false, updated_at = NOW()
        WHERE id = $1 AND user_identifier = $2
        RETURNING job_category_label, location
      `, [preferenceId, phone]);

      if (result.rows.length > 0) {
        const pref = result.rows[0];
        
        logger.info('Preference removed', {
          phone: phone.substring(0, 6) + '***',
          category: pref.job_category_label,
          location: pref.location
        });

        return {
          success: true,
          category: pref.job_category_label,
          location: pref.location
        };
      }

      return {
        success: false,
        message: 'Preference not found.'
      };

    } catch (error) {
      logger.error('Failed to remove preference', {
        phone: phone.substring(0, 6) + '***',
        error: error.message
      });
      return {
        success: false,
        message: 'Failed to remove preference.'
      };
    }
  }

  /**
   * Handle interactive callback from YCloud
   */
  async handleInteractiveCallback(phone, callbackId, callbackTitle) {
    try {
      const state = await redis.get(`state:${phone}`);

      logger.info('Handling preference interactive callback', {
        phone: phone.substring(0, 6) + '***',
        callbackId,
        state
      });

      // Preference menu actions
      if (callbackId === 'pref_add_new') {
        return await this.showCategorySelection(phone);
      }

      if (callbackId === 'pref_view_all') {
        const subData = await this.getActiveSubscription(phone);
        if (subData) {
          return await this.showUserPreferences(phone, subData.id);
        }
      }

      if (callbackId === 'pref_remove') {
        const subData = await this.getActiveSubscription(phone);
        if (subData) {
          return await this.showRemovalOptions(phone, subData.id);
        }
      }

      // Category selection
      if (callbackId.startsWith('cat_')) {
        const category = callbackId.replace('cat_', '');
        return await this.showLocationSelection(phone, category);
      }

      // Location selection
      if (callbackId.startsWith('loc_')) {
        const location = callbackId.replace('loc_', '').replace(/_/g, ' ');
        const categoryData = await redis.get(`temp_category:${phone}`);
        
        if (categoryData) {
          const category = JSON.parse(categoryData);
          const subData = await this.getActiveSubscription(phone);
          
          if (subData) {
            const result = await this.savePreference(
              phone, 
              subData.id, 
              category.key,
              location.charAt(0).toUpperCase() + location.slice(1)
            );

            if (result.success) {
              await ycloud.sendTextMessage(phone,
                `✅ Preference Saved!\n\n` +
                `📂 Category: ${result.category}\n` +
                `📍 Location: ${result.location}\n\n` +
                `🤖 We'll automatically apply to new matching jobs!\n\n` +
                `Reply "preferences" to manage or add more.`
              );
            } else {
              await ycloud.sendTextMessage(phone, result.message);
            }

            await redis.del(`temp_category:${phone}`);
            await redis.del(`state:${phone}`);
          }
        }
      }

      // Remove preference
      if (callbackId.startsWith('remove_')) {
        const preferenceId = callbackId.replace('remove_', '');
        const result = await this.removePreference(preferenceId, phone);

        if (result.success) {
          await ycloud.sendTextMessage(phone,
            `🗑️ Preference Removed\n\n` +
            `${result.category} in ${result.location} is no longer being watched.\n\n` +
            `Reply "preferences" to manage remaining preferences.`
          );
        } else {
          await ycloud.sendTextMessage(phone, result.message);
        }

        await redis.del(`state:${phone}`);
      }

      return true;

    } catch (error) {
      logger.error('Failed to handle preference callback', {
        phone: phone.substring(0, 6) + '***',
        error: error.message
      });
      return false;
    }
  }

  /**
   * Get active subscription for user
   */
  async getActiveSubscription(phone) {
    try {
      const result = await dbManager.query(`
        SELECT id, tier, max_jobs, jobs_applied, valid_until
        FROM auto_apply_subscriptions
        WHERE user_identifier = $1
          AND status = 'active'
          AND valid_until > NOW()
        LIMIT 1
      `, [phone]);

      return result.rows.length > 0 ? result.rows[0] : null;

    } catch (error) {
      logger.error('Failed to get active subscription', {
        phone: phone.substring(0, 6) + '***',
        error: error.message
      });
      return null;
    }
  }
}

module.exports = new AutoApplyPreferencesService();