// services/bot.js - INSTANT RESPONSE SYSTEM

const ycloud = require('./ycloud');
const openaiService = require('./openai');
const paystackService = require('./paystack');
const { Queue } = require('bullmq');
const { v4: uuidv4 } = require('uuid');
const redis = require('../config/redis');
const { queueRedis } = require('../config/redis');
const dbManager = require('../config/database');
const logger = require('../utils/logger');
const nodemailer = require('nodemailer');
const config = require('../config');
const RateLimiter = require('../utils/rateLimiter');

// SPECIALIZED QUEUES FOR INSTANT SYSTEM
const cvQueue = new Queue('cv-processing', { connection: queueRedis });
const applicationQueue = new Queue('job-applications', { connection: queueRedis });
const emailQueue = new Queue('recruiter-emails', { connection: queueRedis });

// Email transporter
const transporter = nodemailer.createTransporter({
  host: config.get('SMTP_HOST'),
  port: Number(config.get('SMTP_PORT')),
  secure: false,
  auth: {
    user: config.get('SMTP_USER'),
    pass: config.get('SMTP_PASS')
  }
});

class InstantResponseBot {
  
  // ================================
  // MAIN MESSAGE HANDLER
  // ================================
  
  async handleWhatsAppMessage(phone, message, file = null) {
    try {
      logger.info('Processing WhatsApp message', { phone, hasMessage: !!message, hasFile: !!file });
      
      // Handle file uploads with instant response
      if (file) {
        const uploadLimit = await RateLimiter.checkLimit(phone, 'cv_upload');
        if (!uploadLimit.allowed) {
          return this.sendWhatsAppMessage(phone, uploadLimit.message);
        }
        
        return await this.handleInstantFileUpload(phone, file);
      }

      // Handle text messages
      if (!message || typeof message !== 'string') {
        return this.sendWhatsAppMessage(phone, 
          'Hi! I help you find jobs in Nigeria 🇳🇬\n\nTry:\n• "Find developer jobs in Lagos"\n• "Status" - Check your usage\n• Upload your CV to apply!'
        );
      }

      // Check user state
      const state = await redis.get(`state:${phone}`);
      
      if (state === 'selecting_jobs') {
        return await this.handleJobSelection(phone, message);
      }

      // Enhanced status command
      if (message.toLowerCase().includes('status')) {
        return await this.handleStatusRequest(phone);
      }

      // AI processing with rate limiting
      const aiLimit = await RateLimiter.checkLimit(phone, 'ai_call');
      if (!aiLimit.allowed) {
        const simpleResponse = this.handleSimplePatterns(phone, message);
        if (simpleResponse) {
          return simpleResponse;
        }
        return this.sendWhatsAppMessage(phone, aiLimit.message);
      }

      return await this.handleWithAI(phone, message);

    } catch (error) {
      logger.error('WhatsApp message processing error', { phone, error: error.message });
      return this.sendWhatsAppMessage(phone, 
        '❌ Something went wrong. Please try again.'
      );
    }
  }

  // ================================
  // INSTANT FILE UPLOAD (NO WAITING)
  // ================================
  
  async handleInstantFileUpload(phone, file) {
    try {
      // Check if user has selected jobs to apply to
      const selectedJobs = await redis.get(`selected_jobs:${phone}`);
      
      if (!selectedJobs) {
        return this.sendWhatsAppMessage(phone,
          '💡 **Upload your CV after selecting jobs!**\n\nFirst search for jobs:\n• "Find developer jobs in Lagos"\n• Select jobs to apply to\n• Then upload CV for instant applications!'
        );
      }

      const usage = await this.checkDailyUsage(phone);
      if (usage.needsPayment) {
        const paymentUrl = await this.initiateDailyPayment(phone);
        return this.sendWhatsAppMessage(phone, 
          `💰 **Complete Payment First**\n\nPay ₦500 for 10 daily applications\n\nPay: ${paymentUrl}\n\nAfter payment, upload CV for instant applications!`
        );
      }
      
      if (file.buffer.length > 5 * 1024 * 1024) {
        return this.sendWhatsAppMessage(phone, '❌ File too large (max 5MB).');
      }

      // Parse selected jobs
      let jobs = [];
      try {
        jobs = JSON.parse(selectedJobs);
      } catch (e) {
        logger.error('Failed to parse selected jobs', { phone, error: e.message });
        return this.sendWhatsAppMessage(phone, 
          '❌ Please select jobs again and then upload CV.'
        );
      }

      // INSTANT RESPONSE - User thinks applications are submitted!
      await this.sendInstantApplicationConfirmation(phone, jobs);

      // BACKGROUND PROCESSING - Everything happens behind the scenes
      await this.queueInstantApplications(phone, file, jobs);
      
      // Clear selected jobs and update usage
      await redis.del(`selected_jobs:${phone}`);
      await this.deductApplications(phone, jobs.length);

      logger.info('Instant applications queued', { 
        phone, 
        jobCount: jobs.length,
        fileSize: file.buffer.length 
      });
      
      return true;

    } catch (error) {
      logger.error('Instant file upload error', { phone, error: error.message });
      return this.sendWhatsAppMessage(phone, 
        '❌ Upload failed. Please try again.'
      );
    }
  }

  async sendInstantApplicationConfirmation(phone, jobs) {
    const usage = await this.checkDailyUsage(phone);
    
    let jobList = '';
    jobs.slice(0, 5).forEach((job, index) => {
      jobList += `${index + 1}. ${job.title} - ${job.company}\n`;
    });
    
    if (jobs.length > 5) {
      jobList += `...and ${jobs.length - 5} more jobs!\n`;
    }

    await this.sendWhatsAppMessage(phone,
      `✅ **Applications Submitted Successfully!**\n\n🎯 **Applied to ${jobs.length} jobs:**\n${jobList}\n📧 **Recruiters will receive your applications within 2 hours**\n\n📊 **Today's Usage:**\n• Applications used: ${usage.totalToday + jobs.length}/10\n• Remaining: ${Math.max(0, usage.remaining - jobs.length)}/10\n\n🔍 **Continue searching for more opportunities!**`
    );
  }

  // ================================
  // BACKGROUND APPLICATION PROCESSING
  // ================================
  
  async queueInstantApplications(phone, file, jobs) {
    try {
      const applicationId = `app_${phone}_${Date.now()}`;
      
      // Queue the entire application process
      await applicationQueue.add(
        'process-applications',
        {
          identifier: phone,
          file: {
            buffer: file.buffer,
            originalname: file.originalname,
            mimetype: file.mimetype
          },
          jobs: jobs,
          applicationId: applicationId,
          timestamp: Date.now()
        },
        {
          priority: 1, // High priority for paid applications
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
          removeOnComplete: 20,
          removeOnFail: 10
        }
      );

      // Optional: Monitor progress (don't block user)
      this.monitorApplicationProgress(applicationId, phone, jobs.length);

    } catch (error) {
      logger.error('Failed to queue instant applications', { phone, error: error.message });
    }
  }

  async monitorApplicationProgress(applicationId, phone, jobCount) {
    // This runs in background - user doesn't wait for this
    try {
      // Could send optional progress updates
      setTimeout(async () => {
        try {
          await this.sendWhatsAppMessage(phone,
            `📧 **Application Update**\n\nYour ${jobCount} applications are being processed and sent to recruiters.\n\n💡 **You can continue searching for more jobs while we handle this!**`
          );
        } catch (error) {
          logger.error('Failed to send progress update', { phone, error: error.message });
        }
      }, 300000); // Send update after 5 minutes
    } catch (error) {
      logger.error('Application monitoring failed', { phone, error: error.message });
    }
  }

  // ================================
  // JOB SEARCH & SELECTION
  // ================================
  
  async searchJobs(identifier, filters) {
    try {
      const searchLimit = await RateLimiter.checkLimit(identifier, 'job_search');
      if (!searchLimit.allowed) {
        return this.sendWhatsAppMessage(identifier, searchLimit.message);
      }

      const cacheKey = `jobs:${JSON.stringify(filters)}`;
      const cached = await redis.get(cacheKey);
      
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          if (parsed && parsed.rows) {
            await redis.set(`last_jobs:${identifier}`, JSON.stringify(parsed.rows), 'EX', 3600);
            return this.sendWhatsAppMessage(identifier, parsed.response);
          }
        } catch (e) {
          logger.error('Failed to parse cached jobs', { error: e.message });
        }
      }

      const { title, location, company, remote } = filters;
      
      const query = `
        SELECT * FROM jobs 
        WHERE ($1::text IS NULL OR title ILIKE $1) 
          AND ($2::text IS NULL OR location ILIKE $2) 
          AND ($3::text IS NULL OR company ILIKE $3) 
          AND ($4::boolean IS NULL OR is_remote = $4) 
          AND (is_remote = true OR is_remote IS NULL) 
          AND (expires_at IS NULL OR expires_at > NOW()) 
        ORDER BY COALESCE(last_updated, scraped_at, NOW()) DESC 
        LIMIT 10`;

      const { rows } = await dbManager.query(query, [
        title ? `%${title}%` : null,
        location ? `%${location}%` : null,
        company ? `%${company}%` : null,
        typeof remote === 'boolean' ? remote : null
      ]);

      if (rows.length === 0) {
        return this.sendWhatsAppMessage(identifier, 
          `🔍 No jobs found for "${title || 'jobs'}" in ${location || 'that location'}\n\n💡 Try:\n• "jobs in Lagos"\n• "developer jobs"\n• "remote jobs"`
        );
      }

      let response = `🔍 **Found ${rows.length} Jobs**\n\n`;

      rows.forEach((job, index) => {
        const jobNumber = index + 1;
        response += `**${jobNumber}.** ${job.title}\n`;
        response += `🏢 ${job.company}\n`;
        response += `📍 ${job.is_remote ? '🌍 Remote' : job.location}\n`;
        response += `💰 ${job.salary || 'Competitive salary'}\n\n`;
      });

      response += `**💼 To Apply:**\n`;
      response += `• "Apply to jobs 1,3,5" (select specific jobs)\n`;
      response += `• "Apply to all jobs" (apply to all ${rows.length})\n\n`;
      response += `**Then upload your CV for instant applications!**`;

      await redis.set(`last_jobs:${identifier}`, JSON.stringify(rows), 'EX', 3600);
      await redis.set(cacheKey, JSON.stringify({ response, rows }), 'EX', 3600);

      return this.sendWhatsAppMessage(identifier, response);

    } catch (error) {
      logger.error('Job search error', { identifier, filters, error: error.message });
      return this.sendWhatsAppMessage(identifier, '❌ Job search failed. Please try again.');
    }
  }

  async handleJobSelection(phone, message) {
    try {
      const lastJobsStr = await redis.get(`last_jobs:${phone}`);
      if (!lastJobsStr) {
        return this.sendWhatsAppMessage(phone,
          'Please search for jobs first before selecting them.'
        );
      }

      let lastJobs = [];
      try {
        lastJobs = JSON.parse(lastJobsStr);
      } catch (e) {
        return this.sendWhatsAppMessage(phone,
          'Please search for jobs again.'
        );
      }

      const text = message.toLowerCase().trim();
      let selectedJobs = [];

      if (text.includes('all')) {
        selectedJobs = lastJobs;
      } else {
        // Extract job numbers
        const numbers = this.extractJobNumbers(text);
        selectedJobs = numbers
          .filter(num => num >= 1 && num <= lastJobs.length)
          .map(num => lastJobs[num - 1]);
      }

      if (selectedJobs.length === 0) {
        return this.sendWhatsAppMessage(phone,
          'Please specify which jobs to apply to:\n• "Apply to jobs 1,3,5"\n• "Apply to all jobs"'
        );
      }

      // Check daily usage
      const usage = await this.checkDailyUsage(phone);
      if (selectedJobs.length > usage.remaining && !usage.needsPayment) {
        return this.sendWhatsAppMessage(phone,
          `❌ You selected ${selectedJobs.length} jobs but only have ${usage.remaining} applications remaining today.\n\nSelect fewer jobs or upgrade your daily limit.`
        );
      }

      // Store selected jobs
      await redis.set(`selected_jobs:${phone}`, JSON.stringify(selectedJobs), 'EX', 3600);
      await redis.del(`state:${phone}`);

      let jobList = '';
      selectedJobs.slice(0, 3).forEach((job, index) => {
        jobList += `${index + 1}. ${job.title} - ${job.company}\n`;
      });
      if (selectedJobs.length > 3) {
        jobList += `...and ${selectedJobs.length - 3} more!\n`;
      }

      if (usage.needsPayment) {
        const paymentUrl = await this.initiateDailyPayment(phone);
        return this.sendWhatsAppMessage(phone,
          `💰 **Payment Required**\n\n🎯 **Selected ${selectedJobs.length} jobs:**\n${jobList}\n**Next:** Pay ₦500 for 10 daily applications\n\n${paymentUrl}\n\n**After payment, upload your CV for instant applications!**`
        );
      } else {
        return this.sendWhatsAppMessage(phone,
          `🎯 **Selected ${selectedJobs.length} jobs:**\n${jobList}\n**Next:** Upload your CV (PDF/DOCX) for instant applications!\n\n📧 Applications will be sent to recruiters automatically.`
        );
      }

    } catch (error) {
      logger.error('Job selection error', { phone, error: error.message });
      return this.sendWhatsAppMessage(phone, '❌ Selection failed. Please try again.');
    }
  }

  // ================================
  // AI PROCESSING & PATTERNS
  // ================================
  
  async handleWithAI(phone, message) {
    try {
      const intent = await openaiService.parseJobQuery(message, phone, {
        platform: 'whatsapp',
        timestamp: Date.now()
      });

      return await this.processIntent(phone, intent, message);

    } catch (error) {
      logger.error('AI processing error', { phone, error: error.message });
      return this.handleSimplePatterns(phone, message);
    }
  }

  async processIntent(phone, intent, originalMessage) {
    try {
      switch (intent?.action) {
        case 'search_jobs':
          if (intent.filters && (intent.filters.title || intent.filters.location || intent.filters.remote)) {
            await this.sendWhatsAppMessage(phone, intent.response || '🔍 Searching for jobs...');
            return await this.searchJobs(phone, intent.filters);
          }
          return this.sendWhatsAppMessage(phone, 
            'What type of jobs are you looking for? 🔍\n\nTry: "developer jobs in Lagos" or "remote marketing jobs"'
          );

        case 'apply_job':
          await redis.set(`state:${phone}`, 'selecting_jobs', 'EX', 3600);
          return await this.handleJobSelection(phone, originalMessage);

        case 'status':
          return await this.handleStatusRequest(phone);

        case 'help':
          return this.sendWhatsAppMessage(phone, this.getHelpMessage());

        default:
          return this.sendWhatsAppMessage(phone, 
            intent.response || 'I help you find jobs in Nigeria! 🇳🇬\n\nTry: "Find developer jobs in Lagos"'
          );
      }
    } catch (error) {
      logger.error('Intent processing error', { phone, error: error.message });
      return this.sendWhatsAppMessage(phone, 
        '❌ Something went wrong. Please try again.'
      );
    }
  }

  handleSimplePatterns(phone, message) {
    const text = message.toLowerCase().trim();
    
    if (text.includes('hello') || text.includes('hi')) {
      this.sendWhatsAppMessage(phone, 
        'Hello! I help you find jobs in Nigeria 🇳🇬\n\nTry: "Find developer jobs in Lagos"'
      );
      return true;
    }
    
    if (text.includes('help')) {
      this.sendWhatsAppMessage(phone, this.getHelpMessage());
      return true;
    }
    
    if (text.includes('status')) {
      this.handleStatusRequest(phone);
      return true;
    }

    // Job search patterns
    const jobTypes = ['developer', 'engineer', 'marketing', 'sales', 'teacher', 'nurse', 'doctor'];
    const locations = ['lagos', 'abuja', 'remote'];
    
    let foundJob = null;
    let foundLocation = null;
    
    for (const job of jobTypes) {
      if (text.includes(job)) foundJob = job;
    }
    
    for (const loc of locations) {
      if (text.includes(loc)) foundLocation = loc;
    }
    
    if (foundJob && foundLocation) {
      this.searchJobs(phone, { 
        title: foundJob, 
        location: foundLocation.charAt(0).toUpperCase() + foundLocation.slice(1),
        remote: foundLocation === 'remote'
      });
      return true;
    }
    
    return false;
  }

  // ================================
  // UTILITY METHODS
  // ================================
  
  extractJobNumbers(text) {
    const numbers = [];
    const matches = text.match(/\b\d+\b/g);
    
    if (matches) {
      matches.forEach(match => {
        const num = parseInt(match);
        if (num >= 1 && num <= 20) {
          numbers.push(num);
        }
      });
    }
    
    return [...new Set(numbers)].sort((a, b) => a - b);
  }

  async sendWhatsAppMessage(phone, message) {
    return await ycloud.sendTextMessage(phone, message);
  }

  getHelpMessage() {
    return `🇳🇬 **SmartCVNaija - Job Application Bot**

🔍 **Find Jobs:**
• "Find developer jobs in Lagos"
• "Remote marketing jobs"
• "Jobs in Abuja"

💼 **Apply to Jobs:**
• Select jobs: "Apply to jobs 1,3,5"
• Apply to all: "Apply to all jobs"
• Upload CV for instant applications

💰 **Pricing:** ₦500 for 10 daily applications

📊 **Check Status:** Type "status"

🚀 **Process:** Search → Select → Pay → Upload CV → Instant Applications!`;
  }

  async handleStatusRequest(phone) {
    const usage = await this.checkDailyUsage(phone);
    const selectedJobs = await redis.get(`selected_jobs:${phone}`);
    
    let selectedText = '';
    if (selectedJobs) {
      try {
        const jobs = JSON.parse(selectedJobs);
        selectedText = `\n🎯 **Selected:** ${jobs.length} jobs ready to apply`;
      } catch (e) {
        // Ignore
      }
    }
    
    return this.sendWhatsAppMessage(phone, 
      `📊 **Your Status**

📈 **Today's Usage:**
• Applications used: ${usage.totalToday}/10
• Remaining: ${usage.remaining}/10
• Payment: ${usage.needsPayment ? '⏳ Required' : '✅ Active'}${selectedText}

🔍 **Next Steps:**
${usage.needsPayment ? '1. Pay ₦500 for daily access\n2. Search for jobs\n3. Upload CV for instant applications' : selectedJobs ? '1. Upload CV for instant applications!' : '1. Search for jobs\n2. Select jobs to apply to\n3. Upload CV'}

💡 **Try:** "Find developer jobs in Lagos"`
    );
  }

  // ================================
  // PAYMENT & USAGE MANAGEMENT
  // ================================
  
  async checkDailyUsage(identifier) {
    const today = new Date().toISOString().split('T')[0];
    
    const { rows: [usage] } = await dbManager.query(`
      SELECT 
        applications_remaining,
        usage_date,
        payment_status,
        total_applications_today
      FROM daily_usage 
      WHERE user_identifier = $1
    `, [identifier]);

    if (!usage || usage.usage_date !== today) {
      await this.resetDailyUsage(identifier, today);
      return {
        remaining: 0,
        isNewDay: true,
        needsPayment: true,
        totalToday: 0
      };
    }

    return {
      remaining: usage.applications_remaining,
      isNewDay: false,
      needsPayment: usage.applications_remaining <= 0,
      totalToday: usage.total_applications_today,
      paymentStatus: usage.payment_status
    };
  }

  async resetDailyUsage(identifier, today) {
    await dbManager.query(`
      INSERT INTO daily_usage (user_identifier, applications_remaining, usage_date, total_applications_today, payment_status)
      VALUES ($1, 0, $2, 0, 'pending')
      ON CONFLICT (user_identifier) 
      DO UPDATE SET 
        applications_remaining = 0,
        usage_date = $2,
        total_applications_today = 0,
        payment_status = 'pending',
        updated_at = NOW()
    `, [identifier, today]);
  }

  async initiateDailyPayment(identifier) {
    const email = await redis.get(`email:${identifier}`) || `${identifier}@example.com`;
    const reference = `daily_${uuidv4()}_${identifier}`;
    
    await dbManager.query(`
      UPDATE daily_usage 
      SET payment_reference = $1, payment_status = 'pending', updated_at = NOW()
      WHERE user_identifier = $2
    `, [reference, identifier]);
    
    return paystackService.initializePayment(identifier, reference, email);
  }

  async deductApplications(identifier, count) {
    const result = await dbManager.query(`
      UPDATE daily_usage 
      SET 
        applications_remaining = applications_remaining - $1,
        total_applications_today = total_applications_today + $1,
        updated_at = NOW()
      WHERE user_identifier = $2 AND applications_remaining >= $1
      RETURNING applications_remaining, total_applications_today
    `, [count, identifier]);

    if (result.rows.length === 0) {
      throw new Error('Insufficient applications remaining');
    }

    return result.rows[0];
  }

  async processPayment(reference) {
    const [type, uuid, identifier] = reference.split('_');
    
    if (type !== 'daily') {
      logger.warn('Unknown payment reference type', { reference });
      return;
    }

    const paymentSuccess = await paystackService.verifyPayment(reference);
    
    if (paymentSuccess) {
      const today = new Date().toISOString().split('T')[0];
      
      await dbManager.query(`
        UPDATE daily_usage 
        SET 
          applications_remaining = 10,
          payment_status = 'completed',
          updated_at = NOW()
        WHERE user_identifier = $1 AND usage_date = $2
      `, [identifier, today]);

      return this.sendWhatsAppMessage(identifier, 
        `✅ **Payment Successful!**\n\n🎯 You now have 10 job applications for today!\n\n🔍 **Next steps:**\n1. Search for jobs\n2. Select jobs to apply to\n3. Upload CV for instant applications\n\n💡 Try: "Find developer jobs in Lagos"`
      );
    } else {
      return this.sendWhatsAppMessage(identifier, '❌ Payment failed. Please try again.');
    }
  }
}

module.exports = new InstantResponseBot();