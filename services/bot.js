// services/bot.js - CLEAN TEASE-THEN-PAY METHOD FOR 1000+ USERS

const ycloud = require('./ycloud');
const openaiService = require('./openai');
const paystackService = require('./paystack');
const { Queue } = require('bullmq');
const { v4: uuidv4 } = require('uuid');
const { redis, queueRedis, sessionRedis } = require('../config/redis');

const dbManager = require('../config/database');
const logger = require('../utils/logger');
const nodemailer = require('nodemailer');
const config = require('../config');
const RateLimiter = require('../utils/rateLimiter');

// SPECIALIZED QUEUES FOR INSTANT SYSTEM
const cvQueue = new Queue('cv-processing', { connection: queueRedis, prefix: 'queue:' });
const cvBackgroundQueue = new Queue('cv-processing-background', { connection: queueRedis, prefix: 'queue:' });
const applicationQueue = new Queue('job-applications', { connection: queueRedis, prefix: 'queue:' });
const emailQueue = new Queue('recruiter-emails', { connection: queueRedis, prefix: 'queue:' });

// Email transporter
const transporter = nodemailer.createTransport({
  host: config.get('SMTP_HOST'),
  port: Number(config.get('SMTP_PORT')),
  secure: false,
  auth: {
    user: config.get('SMTP_USER'),
    pass: config.get('SMTP_PASS')
  }
});

class CleanTeaseThenPayBot {
  
  // ================================
  // MAIN MESSAGE HANDLER
  // ================================
  
async handleWhatsAppMessage(phone, message, file = null) {
  try {
    logger.info('Processing WhatsApp message', { phone, hasMessage: !!message, hasFile: !!file });
    
    // GET SESSION CONTEXT - NEW ADDITION
    const sessionContext = await getSessionContext(phone);
    
    // Handle file uploads with payment protection + instant response
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

    // Check if user wants to see jobs after payment
    if (message.toLowerCase().includes('show jobs') || message.toLowerCase().includes('my jobs')) {
      return await this.showFullJobsAfterPayment(phone);
    }

    // Handle clear/reset commands - NEW ADDITION
    if (message.toLowerCase().includes('clear') || message.toLowerCase().includes('reset')) {
      await clearSessionContext(phone);
      return this.sendWhatsAppMessage(phone, 
        '✅ Conversation cleared! Ready to start fresh.\n\nTry: "Find developer jobs in Lagos"'
      );
    }

    // AI processing with rate limiting
    const aiLimit = await RateLimiter.checkLimit(phone, 'ai_call');
    if (!aiLimit.allowed) {
      const simpleResponse = this.handleSimplePatterns(phone, message, sessionContext); // PASS sessionContext
      if (simpleResponse) {
        return simpleResponse;
      }
      return this.sendWhatsAppMessage(phone, aiLimit.message);
    }

    return await this.handleWithAI(phone, message, sessionContext); // PASS sessionContext

  } catch (error) {
    logger.error('WhatsApp message processing error', { phone, error: error.message });
    return this.sendWhatsAppMessage(phone, 
      '⚠️ Something went wrong. Please try again.'
    );
  }
}
  // ================================
  // CLEAN TEASE-THEN-PAY JOB SEARCH
  // ================================
  
  async searchJobs(identifier, filters) {
    try {
      const searchLimit = await RateLimiter.checkLimit(identifier, 'job_search');
      if (!searchLimit.allowed) {
        return this.sendWhatsAppMessage(identifier, searchLimit.message);
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
        LIMIT 20`;

      const { rows } = await dbManager.query(query, [
        title ? `%${title}%` : null,
        location ? `%${location}%` : null,
        company ? `%${company}%` : null,
        typeof remote === 'boolean' ? remote : null
      ]);

      if (rows.length === 0) {
        return this.sendWhatsAppMessage(identifier, 
          `?? No jobs found for "${title || 'jobs'}" in ${location || 'that location'}\n\n?? Try:\n� "jobs in Lagos"\n� "developer jobs"\n� "remote jobs"`
        );
      }

      // ? CLEAN TEASE METHOD: Show count and basic info only
      return await this.showCleanJobTease(identifier, rows, filters);

    } catch (error) {
      logger.error('Job search error', { identifier, filters, error: error.message });
      return this.sendWhatsAppMessage(identifier, '? Job search failed. Please try again.');
    }
  }

  async showCleanJobTease(identifier, jobs, filters) {
    try {
      // Group jobs by location for tease
      const locationGroups = {};
      jobs.forEach(job => {
        const loc = job.is_remote ? 'Remote' : job.location;
        if (!locationGroups[loc]) locationGroups[loc] = 0;
        locationGroups[loc]++;
      });

      // ? CLEAN TEASE RESPONSE - NO DISTRACTIONS
      let response = `?? **Found ${jobs.length} ${filters.title || 'jobs'}!**\n\n`;
      
      response += `?? **Available Locations:**\n`;
      Object.entries(locationGroups).forEach(([location, count]) => {
        response += `� ${location}: ${count} job${count > 1 ? 's' : ''}\n`;
      });

      response += `\n?? **Pay ?300 to see full details and apply**\n\n`;
      response += `?? **What you'll get:**\n`;
      response += `? Full job descriptions & company names\n`;
      response += `? Salary information & requirements\n`;
      response += `? Apply to up to 10 jobs today\n\n`;

      // Store jobs for after payment (don't show details yet)
      await redis.set(`pending_jobs:${identifier}`, JSON.stringify(jobs), 'EX', 3600);
      await redis.set(`search_context:${identifier}`, JSON.stringify(filters), 'EX', 3600);

      // Generate payment link
      const paymentUrl = await this.initiateDailyPayment(identifier);
      response += `?? **Pay now:** ${paymentUrl}\n\n`;
      response += `?? **Already paid?** Type "show jobs"`;

      // ? SCHEDULE PAYMENT REMINDERS (with community link)
      this.schedulePaymentReminders(identifier);

      return this.sendWhatsAppMessage(identifier, response);

    } catch (error) {
      logger.error('Job tease error', { identifier, error: error.message });
      return this.sendWhatsAppMessage(identifier, '? Failed to process jobs. Please try again.');
    }
  }

  async showFullJobsAfterPayment(identifier) {
    try {
      const pendingJobsStr = await redis.get(`pending_jobs:${identifier}`);
      if (!pendingJobsStr) {
        return this.sendWhatsAppMessage(identifier,
          '?? No jobs found. Search for jobs first:\n� "Find developer jobs in Lagos"\n� "Remote marketing jobs"'
        );
      }

      const jobs = JSON.parse(pendingJobsStr);

      let response = `? **Here are your ${jobs.length} jobs:**\n\n`;

      jobs.forEach((job, index) => {
        const jobNumber = index + 1;
        response += `**${jobNumber}.** ${job.title}\n`;
        response += `?? ${job.company}\n`;
        response += `?? ${job.is_remote ? '?? Remote' : job.location}\n`;
        response += `?? ${job.salary || 'Competitive salary'}\n`;
        if (job.description && job.description.length > 100) {
          response += `?? ${job.description.substring(0, 100)}...\n`;
        }
        response += `\n`;
      });

      response += `**?? Ready to Apply:**\n`;
      response += `� "Apply to jobs 1,3,5" (select specific jobs)\n`;
      response += `� "Apply to all jobs" (apply to all ${jobs.length})\n\n`;
      response += `**Next:** Select jobs, then upload your CV!`;

      // Store for selection
      await redis.set(`last_jobs:${identifier}`, JSON.stringify(jobs), 'EX', 3600);
      await redis.del(`pending_jobs:${identifier}`); // Clear pending

      return this.sendWhatsAppMessage(identifier, response);

    } catch (error) {
      logger.error('Show full jobs error', { identifier, error: error.message });
      return this.sendWhatsAppMessage(identifier, '? Failed to show jobs. Please try again.');
    }
  }

  // ================================
  // PAYMENT REMINDERS WITH STRATEGIC COMMUNITY PLACEMENT
  // ================================

  schedulePaymentReminders(identifier) {
    // First reminder after 10 minutes - include community for social proof
    setTimeout(async () => {
      const usage = await this.checkDailyUsage(identifier);
      if (usage.needsPayment) {
        await this.sendPaymentReminderWithCommunity(identifier);
      }
    }, 600000); // 10 minutes

    // Final reminder after 1 hour - create urgency
    setTimeout(async () => {
      const usage = await this.checkDailyUsage(identifier);
      if (usage.needsPayment) {
        await this.sendFinalPaymentReminder(identifier);
      }
    }, 3600000); // 1 hour
  }

  async sendPaymentReminderWithCommunity(identifier) {
    const pendingJobs = await redis.get(`pending_jobs:${identifier}`);
    if (!pendingJobs) return;

    try {
      const jobs = JSON.parse(pendingJobs);
      const paymentUrl = await this.initiateDailyPayment(identifier);
      
      await this.sendWhatsAppMessage(identifier,
        `?? **Still interested in those ${jobs.length} jobs?**\n\n?? **See what others are saying about us:**\nhttps://whatsapp.com/channel/0029VbAp71RA89Mc5GPDKl1h\n\n?? **Complete payment to see job details:**\n${paymentUrl}\n\n? These jobs get 50+ applications daily!`
      );
    } catch (error) {
      logger.error('Payment reminder error', { identifier, error: error.message });
    }
  }

  async sendFinalPaymentReminder(identifier) {
    const pendingJobs = await redis.get(`pending_jobs:${identifier}`);
    if (!pendingJobs) return;

    try {
      const jobs = JSON.parse(pendingJobs);
      const paymentUrl = await this.initiateDailyPayment(identifier);
      
      await this.sendWhatsAppMessage(identifier,
        `?? **Final reminder:** Your ${jobs.length} job search results expire soon!\n\n?? **Complete payment now:**\n${paymentUrl}\n\n? New jobs added daily - don't miss out!`
      );
    } catch (error) {
      logger.error('Final reminder error', { identifier, error: error.message });
    }
  }

  // ================================
  // JOB SELECTION (UNCHANGED)
  // ================================

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
        return this.sendWhatsAppMessage(phone, 'Please search for jobs again.');
      }

      const text = message.toLowerCase().trim();
      let selectedJobs = [];

      if (text.includes('all')) {
        selectedJobs = lastJobs;
      } else {
        const numbers = this.extractJobNumbers(text);
        selectedJobs = numbers
          .filter(num => num >= 1 && num <= lastJobs.length)
          .map(num => lastJobs[num - 1]);
      }

      if (selectedJobs.length === 0) {
        return this.sendWhatsAppMessage(phone,
          'Please specify which jobs to apply to:\n� "Apply to jobs 1,3,5"\n� "Apply to all jobs"'
        );
      }

      const usage = await this.checkDailyUsage(phone);
      if (selectedJobs.length > usage.remaining && !usage.needsPayment) {
        return this.sendWhatsAppMessage(phone,
          `? You selected ${selectedJobs.length} jobs but only have ${usage.remaining} applications remaining today.\n\nSelect fewer jobs or wait until tomorrow.`
        );
      }

      await redis.set(`selected_jobs:${phone}`, JSON.stringify(selectedJobs), 'EX', 3600);
      await redis.del(`state:${phone}`);

      let jobList = '';
      selectedJobs.slice(0, 3).forEach((job, index) => {
        jobList += `${index + 1}. ${job.title} - ${job.company}\n`;
      });
      if (selectedJobs.length > 3) {
        jobList += `...and ${selectedJobs.length - 3} more!\n`;
      }

      return this.sendWhatsAppMessage(phone,
        `?? **Selected ${selectedJobs.length} jobs:**\n${jobList}\n**Next:** Upload your CV (PDF/DOCX) for instant applications!\n\n?? Applications will be sent to recruiters automatically.`
      );

    } catch (error) {
      logger.error('Job selection error', { phone, error: error.message });
      return this.sendWhatsAppMessage(phone, '? Selection failed. Please try again.');
    }
  }

  // ================================
  // FILE UPLOAD WITH PAYMENT PROTECTION
  // ================================
  
  async handleInstantFileUpload(phone, file) {
    try {
      // Check if user has selected jobs to apply to
      const selectedJobs = await redis.get(`selected_jobs:${phone}`);
      
      if (!selectedJobs) {
        return this.sendWhatsAppMessage(phone,
          '?? **First select jobs to apply to!**\n\nSearch for jobs:\n� "Find developer jobs in Lagos"\n� Select jobs to apply to\n� Then upload CV for applications!'
        );
      }

      // ? PAYMENT PROTECTION - CHECK PAYMENT FIRST
      const usage = await this.checkDailyUsage(phone);
      if (usage.needsPayment) {
        const paymentUrl = await this.initiateDailyPayment(phone);
        return this.sendWhatsAppMessage(phone, 
          `?? **Complete Payment First**\n\nPay ?300 for 10 daily applications\n\n${paymentUrl}\n\nAfter payment, upload CV for instant applications!`
        );
      }
      
      if (file.buffer.length > 5 * 1024 * 1024) {
        return this.sendWhatsAppMessage(phone, '? File too large (max 5MB).');
      }

      // Parse selected jobs
      let jobs = [];
      try {
        jobs = JSON.parse(selectedJobs);
      } catch (e) {
        logger.error('Failed to parse selected jobs', { phone, error: e.message });
        return this.sendWhatsAppMessage(phone, 
          '? Please select jobs again and then upload CV.'
        );
      }

      // ? PAYMENT SECURED - PROVIDE INSTANT GRATIFICATION WITH COMMUNITY
      await this.sendInstantApplicationConfirmationWithCommunity(phone, jobs);

      // ? QUEUE BACKGROUND PROCESSING
      await this.queueSmartApplicationProcessing(phone, file, jobs);
      
      // Clear selected jobs and update usage
      await redis.del(`selected_jobs:${phone}`);
      await this.deductApplications(phone, jobs.length);

      logger.info('Instant applications queued after payment', { 
        phone, 
        jobCount: jobs.length,
        fileSize: file.buffer.length 
      });
      
      return true;

    } catch (error) {
      logger.error('Instant file upload error', { phone, error: error.message });
      return this.sendWhatsAppMessage(phone, 
        '? Upload failed. Please try again.'
      );
    }
  }

  // ================================
  // SUCCESS CONFIRMATION WITH COMMUNITY
  // ================================
  
  async sendInstantApplicationConfirmationWithCommunity(phone, jobs) {
    const usage = await this.checkDailyUsage(phone);
    
    let jobList = '';
    jobs.slice(0, 5).forEach((job, index) => {
      jobList += `${index + 1}. ${job.title} - ${job.company}\n`;
    });
    
    if (jobs.length > 5) {
      jobList += `...and ${jobs.length - 5} more jobs!\n`;
    }

    await this.sendWhatsAppMessage(phone,
      `?? **SUCCESS! Applications Submitted!**\n\n?? **Applied to ${jobs.length} jobs:**\n${jobList}\n?? **Recruiters have received your applications**\n\n?? **Today's Usage:**\n� Applications used: ${usage.totalToday + jobs.length}/10\n� Remaining: ${Math.max(0, usage.remaining - jobs.length)}/10\n\n?? **Join our success community & share your win:**\nhttps://whatsapp.com/channel/0029VbAp71RA89Mc5GPDKl1h\n\n?? **Continue searching for more opportunities!**`
    );
  }

  // ================================
  // BACKGROUND PROCESSING
  // ================================
  
  async queueSmartApplicationProcessing(phone, file, jobs) {
    try {
      const applicationId = `app_${phone}_${Date.now()}`;
      
      await applicationQueue.add(
        'process-smart-applications',
        {
          identifier: phone,
          file: {
            buffer: file.buffer,
            originalname: file.originalname,
            mimetype: file.mimetype
          },
          jobs: jobs,
          applicationId: applicationId,
          timestamp: Date.now(),
          processingStrategy: 'smart_fallback'
        },
        {
          priority: 1,
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: 30,
          removeOnFail: 15
        }
      );

      logger.info('Smart application processing queued', { 
        phone, 
        applicationId, 
        jobCount: jobs.length 
      });

    } catch (error) {
      logger.error('Failed to queue smart applications', { phone, error: error.message });
    }
  }

  // ================================
  // AI PROCESSING & PATTERNS
  // ================================
  
 async handleWithAI(phone, message, sessionContext = {}) {
  try {
    const intent = await openaiService.parseJobQuery(message, phone, {
      platform: 'whatsapp',
      timestamp: Date.now(),
      sessionData: sessionContext // PASS sessionContext to AI
    });

    const result = await this.processIntent(phone, intent, message, sessionContext);
    
    // UPDATE SESSION CONTEXT AFTER PROCESSING - NEW ADDITION
    await this.updateSessionContext(phone, message, intent, sessionContext);
    
    return result;

  } catch (error) {
    logger.error('AI processing error', { phone, error: error.message });
    return this.handleSimplePatterns(phone, message, sessionContext);
  }
}
async updateSessionContext(phone, message, intent, currentContext) {
  try {
    const updatedContext = { ...currentContext };
    
    // Save job type if detected
    if (intent?.filters?.title) {
      updatedContext.lastJobType = intent.filters.title;
      logger.debug('Updated session job type', { phone, jobType: intent.filters.title });
    }
    
    // Save location if detected  
    if (intent?.filters?.location) {
      updatedContext.lastLocation = intent.filters.location;
      logger.debug('Updated session location', { phone, location: intent.filters.location });
    }
    
    // Save last message and action for context
    updatedContext.lastMessage = message;
    updatedContext.lastAction = intent?.action || 'unknown';
    updatedContext.timestamp = Date.now();
    
    // Save interaction count
    updatedContext.interactionCount = (updatedContext.interactionCount || 0) + 1;
    
    await saveSessionContext(phone, updatedContext);
    
  } catch (error) {
    logger.error('Failed to update session context', { phone, error: error.message });
  }
}

async processIntent(phone, intent, originalMessage, sessionContext = {}) {
  try {
    switch (intent?.action) {
      case 'search_jobs':
        if (intent.filters && (intent.filters.title || intent.filters.location || intent.filters.remote)) {
          // Use session context to complete partial queries - NEW LOGIC
          const filters = { ...intent.filters };
          
          if (!filters.title && sessionContext.lastJobType) {
            filters.title = sessionContext.lastJobType;
            logger.info('Completed query with session job type', { phone, jobType: filters.title });
          }
          
          if (!filters.location && sessionContext.lastLocation) {
            filters.location = sessionContext.lastLocation;
            logger.info('Completed query with session location', { phone, location: filters.location });
          }

          // Save/Update context on full search - EXISTING LOGIC ENHANCED
          if (filters.title) {
            await redis.set(`lastJobType:${phone}`, filters.title, 'EX', 60);
          }
          if (filters.location) {
            await redis.set(`lastLocation:${phone}`, filters.location, 'EX', 60);
          }

          await this.sendWhatsAppMessage(phone, intent.response || '🔎 Searching for jobs...');
          return await this.searchJobs(phone, filters);
        }
        return this.sendWhatsAppMessage(phone, 
          'What type of jobs are you looking for? 🤔\n\nTry: "developer jobs in Lagos" or "remote marketing jobs"'
        );

      case 'clarify':
        // Store/update partial context so next reply merges properly - EXISTING LOGIC
        if (intent.filters?.title) {
          await redis.set(`lastJobType:${phone}`, intent.filters.title, 'EX', 3600);
        }
        if (intent.filters?.location) {
          await redis.set(`lastLocation:${phone}`, intent.filters.location, 'EX', 3600);
        }

        return this.sendWhatsAppMessage(phone, intent.response);

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
      '⚠️ Something went wrong. Please try again.'
    );
  }
}

handleSimplePatterns(phone, message, sessionContext = {}) {
  const text = message.toLowerCase().trim();
  
  if (text.includes('hello') || text.includes('hi')) {
    // Use session context to personalize greeting
    const greeting = sessionContext.lastJobType || sessionContext.lastLocation 
      ? `Hello again! Still looking for ${sessionContext.lastJobType || 'jobs'} ${sessionContext.lastLocation ? 'in ' + sessionContext.lastLocation : ''}?`
      : 'Hello! I help you find jobs in Nigeria 🇳🇬\n\nTry: "Find developer jobs in Lagos"';
    
    this.sendWhatsAppMessage(phone, greeting);
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
  
  // USE SESSION CONTEXT FOR PARTIAL QUERIES - NEW LOGIC
  if (foundJob && !foundLocation && sessionContext.lastLocation) {
    foundLocation = sessionContext.lastLocation.toLowerCase();
    logger.info('Using session location', { phone, location: foundLocation });
  }
  
  if (!foundJob && foundLocation && sessionContext.lastJobType) {
    foundJob = sessionContext.lastJobType.toLowerCase();
    logger.info('Using session job type', { phone, jobType: foundJob });
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
    return `???? **SmartCVNaija - Job Application Bot**

?? **Find Jobs:**
� "Find developer jobs in Lagos"
� "Remote marketing jobs"
� "Jobs in Abuja"

?? **How it works:**
1. Search for jobs (free preview)
2. Pay ?300 to see full details
3. Select jobs to apply to
4. Upload CV for instant applications

?? **Apply to Jobs:**
� Select jobs: "Apply to jobs 1,3,5"
� Apply to all: "Apply to all jobs"

?? **Check Status:** Type "status"

?? **Simple Process:** Search ? Pay ? Select ? Upload ? Apply!`;
  }

  async handleStatusRequest(phone) {
    const usage = await this.checkDailyUsage(phone);
    const selectedJobs = await redis.get(`selected_jobs:${phone}`);
    const pendingJobs = await redis.get(`pending_jobs:${phone}`);
    
    let statusText = '';
    if (pendingJobs) {
      try {
        const jobs = JSON.parse(pendingJobs);
        statusText = `\n?? **Pending:** ${jobs.length} jobs found - pay ?300 to see details`;
      } catch (e) {
        // Ignore
      }
    }
    
    if (selectedJobs) {
      try {
        const jobs = JSON.parse(selectedJobs);
        statusText = `\n?? **Selected:** ${jobs.length} jobs ready to apply`;
      } catch (e) {
        // Ignore
      }
    }
    
    return this.sendWhatsAppMessage(phone, 
      `?? **Your Status**

?? **Today's Usage:**
� Applications used: ${usage.totalToday}/10
� Remaining: ${usage.remaining}/10
� Payment: ${usage.needsPayment ? '? Required' : '? Active'}${statusText}

?? **Next Steps:**
${usage.needsPayment ? '1. Search for jobs\n2. Pay ?300 to see details\n3. Apply with CV' : selectedJobs ? '1. Upload CV for instant applications!' : pendingJobs ? '1. Pay ?300 to see job details\n2. Select and apply' : '1. Search for jobs\n2. Pay to see details\n3. Apply with CV'}

?? **Try:** "Find developer jobs in Lagos"`
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

      // ? SHOW JOBS AFTER SUCCESSFUL PAYMENT
      const pendingJobs = await redis.get(`pending_jobs:${identifier}`);
      if (pendingJobs) {
        // User had searched for jobs before payment
        return this.showFullJobsAfterPayment(identifier);
      } else {
        // User paid without searching first
        return this.sendWhatsAppMessage(identifier, 
          `? **Payment Successful!**\n\n?? You now have 10 job applications for today!\n\n?? **Next steps:**\n1. Search for jobs: "Find developer jobs in Lagos"\n2. Select jobs to apply to\n3. Upload CV for instant applications\n\n?? Start searching now!`
        );
      }
    } else {
      return this.sendWhatsAppMessage(identifier, '? Payment failed. Please try again.');
    }
  }
}

module.exports = new CleanTeaseThenPayBot();