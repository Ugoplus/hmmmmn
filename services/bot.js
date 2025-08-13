const { Pool } = require('pg');
const Redis = require('ioredis');
const axios = require('axios');
const nodemailer = require('nodemailer');
const config = require('../config');
const logger = require('../utils/logger');
const { trackMetric } = require('../utils/metrics');
const openaiService = require('./openai');
const paystackService = require('./paystack');
const { Queue } = require('bullmq');
const { v4: uuidv4 } = require('uuid');
const TelegramBot = require('node-telegram-bot-api');
const redis = require('../config/redis');
const dbManager = require('../config/database');
const fs = require('fs');

const cvQueue = new Queue('cv-processing', { connection: redis });

const transporter = nodemailer.createTransport({
  host: config.get('SMTP_HOST'),
  port: Number(config.get('SMTP_PORT')),
  secure: false,
  auth: {
    user: config.get('SMTP_USER'),
    pass: config.get('SMTP_PASS')
  }
});

// ✅ Only create Telegram bot if token exists and is valid
let telegramBot = null;
const telegramToken = config.get('telegram.token');
if (telegramToken && telegramToken.trim() !== '' && telegramToken !== 'your-telegram-token') {
  try {
    telegramBot = new TelegramBot(telegramToken, { polling: false });
    logger.info('Telegram bot initialized in services/bot.js');
  } catch (error) {
    logger.error('Failed to initialize Telegram bot in services/bot.js', { error: error.message });
  }
} else {
  logger.info('Telegram bot not initialized - no valid token provided');
}

let pool = null;

class CVJobMatchingBot {
  
  // ================================
  // DAILY USAGE MANAGEMENT
  // ================================
  
  async checkDailyUsage(identifier) {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
    
    const { rows: [usage] } = await dbManager.query(`
      SELECT 
        applications_remaining,
        usage_date,
        payment_status,
        total_applications_today
      FROM daily_usage 
      WHERE user_identifier = $1
    `, [identifier]);

    // If no record exists or it's a new day, reset
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


   async getSessionData(identifier) {
  try {
    const sessionData = await redis.get(`session:${identifier}`);
    
    if (!sessionData) {
      const newSession = {
        lastLocation: null,
        lastJobType: null,
        searchHistory: [],
        preferences: {
          preferredCities: [],
          jobTypes: []
        },
        createdAt: new Date().toISOString(),
        lastActive: new Date().toISOString()
      };
      
      await this.saveSessionData(identifier, newSession);
      return newSession;
    }
    
    const parsed = JSON.parse(sessionData);
    parsed.lastActive = new Date().toISOString();
    await this.saveSessionData(identifier, parsed);
    
    return parsed;
  } catch (error) {
    logger.error('Error getting session data', { identifier, error: error.message });
    return this.getDefaultSession();
  }
}


async saveSessionData(identifier, sessionData) {
  try {
    await redis.set(
      `session:${identifier}`, 
      JSON.stringify(sessionData), 
      'EX', 
      86400 * 7
    );
  } catch (error) {
    logger.error('Error saving session data', { identifier, error: error.message });
  }
}




getDefaultSession() {
  return {
    lastLocation: null,
    lastJobType: null,
    searchHistory: [],
    preferences: {
      preferredCities: [],
      jobTypes: []
    },
    createdAt: new Date().toISOString(),
    lastActive: new Date().toISOString()
  };
}




async updateSessionContext(identifier, updates) {
  try {
    const sessionData = await this.getSessionData(identifier);
    
    if (updates.location) {
      sessionData.lastLocation = updates.location;
      
      if (!sessionData.preferences.preferredCities.includes(updates.location)) {
        sessionData.preferences.preferredCities.push(updates.location);
        if (sessionData.preferences.preferredCities.length > 3) {
          sessionData.preferences.preferredCities.shift();
        }
      }
    }
    
    if (updates.jobType) {
      sessionData.lastJobType = updates.jobType;
      
      if (!sessionData.preferences.jobTypes.includes(updates.jobType)) {
        sessionData.preferences.jobTypes.push(updates.jobType);
        if (sessionData.preferences.jobTypes.length > 3) {
          sessionData.preferences.jobTypes.shift();
        }
      }
    }
    
    if (updates.search) {
      sessionData.searchHistory.unshift(updates.search);
      if (sessionData.searchHistory.length > 10) {
        sessionData.searchHistory = sessionData.searchHistory.slice(0, 10);
      }
    }
    
    sessionData.lastActive = new Date().toISOString();
    await this.saveSessionData(identifier, sessionData);
    
    return sessionData;
  } catch (error) {
    logger.error('Error updating session context', { identifier, error: error.message });
    return await this.getSessionData(identifier);
  }
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

  // ================================
  // MESSAGE HANDLERS
  // ================================
  async handleWhatsAppMessage(phone, message, file = null) {
    try {
      if (file) {
        const usage = await this.checkDailyUsage(phone);
        if (usage.needsPayment) {
          const paymentUrl = await this.initiateDailyPayment(phone);
          return this.sendWhatsAppMessage(phone, 
            `💰 Daily Payment Required\n\nGet 10 job applications for ₦500!\n\nPay here: ${paymentUrl}`
          );
        }
        
        if (file.buffer.length > 5 * 1024 * 1024) {
          return this.sendWhatsAppMessage(phone, 
            '❌ File too large. Please upload a CV smaller than 5MB.'
          );
        }
        
        const job = await cvQueue.add('process-cv', { 
          file: {
            buffer: file.buffer,
            originalname: file.originalname,
            mimetype: file.mimetype
          }, 
          identifier: phone 
        });
        
        const cvText = await job.waitUntilFinished(cvQueue);
        
        await redis.set(`cv:${phone}`, cvText, 'EX', 86400);
        await redis.set(`email:${phone}`, file.email || `hr@smartcvnaija.com.ng`, 'EX', 86400);
        await redis.set(`state:${phone}`, 'awaiting_cover_letter', 'EX', 86400);
        
        const updatedUsage = await this.checkDailyUsage(phone);
        return this.sendWhatsAppMessage(phone, 
          `✅ CV uploaded successfully!\n\n📊 Applications remaining: ${updatedUsage.remaining}/10\n\n✍️ Send a cover letter or reply "generate"`
        );
      }

      if (!message || typeof message !== 'string') {
        return this.sendWhatsAppMessage(phone, 
          '❓ Please try again.'
        );
      }

      const state = await redis.get(`state:${phone}`);

      if (state === 'awaiting_cover_letter') {
        let coverLetter = message;
        
        if (message.toLowerCase().trim() === 'generate') {
          const cvText = await redis.get(`cv:${phone}`);
          if (!cvText) {
            return this.sendWhatsAppMessage(phone, 
              '❌ CV not found. Please upload your CV first.'
            );
          }
          coverLetter = await openaiService.generateCoverLetter(cvText);
        }
        
        await redis.set(`cover_letter:${phone}`, coverLetter, 'EX', 86400);
        await redis.del(`state:${phone}`);
        
        const usage = await this.checkDailyUsage(phone);
        return this.sendWhatsAppMessage(phone, 
          `✅ Cover letter saved!\n\n📊 Applications remaining: ${usage.remaining}/10\n\n🔍 Search for jobs:\n• "find jobs in Lagos"`
        );
      }


         const sessionData = await this.getSessionData(phone);
         const userContext = {
  platform: 'whatsapp',
  sessionData: sessionData,
  hasCV: await redis.exists(`cv:${phone}`),
  hasCoverLetter: await redis.exists(`cover_letter:${phone}`),
  currentState: await redis.get(`state:${phone}`) || 'idle'
};

const intent = await openaiService.parseJobQuery(message, phone, {
  platform: 'whatsapp',
  sessionData: sessionData,
  hasCV: await redis.exists(`cv:${phone}`),
  hasCoverLetter: await redis.exists(`cover_letter:${phone}`),
  currentState: await redis.get(`state:${phone}`) || 'idle'
});



// Update session based on intent
if (intent.filters) {
  const updates = {};
  
  if (intent.filters.location) {
    updates.location = intent.filters.location;
  }
  
  if (intent.filters.title) {
    updates.jobType = intent.filters.title;
  }
  
  if (intent.action === 'search_jobs') {
    updates.search = {
      query: message,
      filters: intent.filters,
      timestamp: new Date().toISOString()
    };
  }
  
  if (Object.keys(updates).length > 0) {
    await this.updateSessionContext(phone, updates);
  }
}


      return await this.processIntent(phone, intent);

      
    } catch (error) {
      logger.error('WhatsApp message processing error', { phone, error: error.message });
      return this.sendWhatsAppMessage(phone, 
        '❌ Sorry, an error occurred. Please try again.'
      );
    }
  }

  async handleTelegramMessage(chatId, message, file = null) {
    try {
      if (file) {
        // CV upload requires daily access
        const usage = await this.checkDailyUsage(chatId);
        if (usage.needsPayment) {
          const paymentUrl = await this.initiateDailyPayment(chatId);
          return this.sendTelegramMessage(chatId, 
            `🔄 Daily Access Required\n\nGet 10 job applications for ₦500 today!\n\nPay here: ${paymentUrl}`
          );
        }
        
        if (file.buffer.length > 5 * 1024 * 1024) {
          return this.sendTelegramMessage(chatId, 'File is too large. Please upload a CV smaller than 5MB.');
        }
        
        const job = await cvQueue.add('process-cv', { file, identifier: chatId });
        const cvText = await job.waitUntilFinished(cvQueue);
        await redis.set(`cv:${chatId}`, cvText, 'EX', 86400);
        await redis.set(`email:${chatId}`, file.email || `${chatId}@example.com`, 'EX', 86400);
        await redis.set(`state:${chatId}`, 'awaiting_cover_letter', 'EX', 86400);
        
        const updatedUsage = await this.checkDailyUsage(chatId);
        return this.sendTelegramMessage(chatId, 
          `✅ CV uploaded successfully!\n\n📊 Applications remaining today: ${updatedUsage.remaining}/10\n\nPlease provide a cover letter or reply "generate" to create one.`
        );
      }

      const state = await redis.get(`state:${chatId}`);
      if (state === 'awaiting_cover_letter' && message) {
        let coverLetter = message;
        if (message.toLowerCase() === 'generate') {
          const cvText = await redis.get(`cv:${chatId}`);
          coverLetter = await openaiService.generateCoverLetter(cvText);
        }
        await redis.set(`cover_letter:${chatId}`, coverLetter, 'EX', 86400);
        await redis.del(`state:${chatId}`);
        
        const pendingJobs = await redis.get(`pending_jobs:${chatId}`);
        if (pendingJobs) {
          let jobs = [];
          try {
            jobs = JSON.parse(pendingJobs);
          } catch (e) {
            logger.error('Failed to parse pending jobs', { pendingJobs, error: e.message });
          }
          await redis.del(`pending_jobs:${chatId}`);
          return this.applyToJobs(chatId, jobs);
        }
        
        const usage = await this.checkDailyUsage(chatId);
        return this.sendTelegramMessage(chatId, 
          `✅ Cover letter saved!\n\n📊 Applications remaining: ${usage.remaining}/10\n\nYou can now search for jobs or apply.`
        );
      }

       const sessionData = await redis.get(`session:${chatId}`);
       const userContext = sessionData ? JSON.parse(sessionData) : {};

const intent = await openaiService.parseJobQuery(message, chatId, {
  platform: 'telegram',
  sessionData: userContext,
  hasCV: await redis.exists(`cv:${chatId}`),
  hasCoverLetter: await redis.exists(`cover_letter:${chatId}`),
  currentState: await redis.get(`state:${chatId}`) || 'idle'
});

return await this.processIntent(chatId, intent);

    } catch (error) {
      logger.error('Telegram message processing error', { chatId, error });
      return this.sendTelegramMessage(chatId, 'Sorry, an error occurred. Please try again.');
    }
  }

  // ================================
  // INTENT PROCESSING
  // ================================

async processIntent(identifier, intent) {
  try {
    logger.info('Processing intent', { 
      identifier, 
      action: intent?.action, 
      hasResponse: !!intent?.response 
    });

    // ONLY handle actions that require complex business logic
    switch (intent?.action) {
      
      case 'reset': {
        return await this.handleResetCommand(identifier);
      }

case 'search_jobs': {
  // Check if we have filters and they're complete
  if (intent.filters && Object.keys(intent.filters).length > 0) {
    await this.setUserState(identifier, 'browsing_jobs');
    const searchResult = await this.searchJobs(identifier, intent.filters);
    // NEW: Update session after search
    await this.updateSessionContext(identifier, {
      location: intent.filters.location || (intent.filters.remote ? 'Remote' : null),
      jobType: intent.filters.title
    });
    return searchResult;
  }
  
  // If no filters or incomplete, ask for more info
  return this.sendMessage(identifier, 
    'Please specify both job type AND location.\n\nExample: "developer jobs Lagos" or "teacher Abuja"'
  );
}



      case 'apply_job': {
        await this.setUserState(identifier, 'applying');
        const result = await this.handleJobApplication(identifier, intent);
        await this.setUserState(identifier, 'idle');
        return result;
      }

           case 'status': {
  const currentUsage = await this.checkDailyUsage(identifier);
  const userState = await this.getUserState(identifier);
  const hasCV = await redis.exists(`cv:${identifier}`);
  const hasCoverLetter = await redis.exists(`cover_letter:${identifier}`);
  const sessionData = await this.getSessionData(identifier);

  let statusMessage = `📊 **Your SmartCVNaija Status**\n\n📈 **Usage:**\n• Applications today: ${currentUsage.totalToday}/10\n• Remaining: ${currentUsage.remaining}/10\n• Payment status: ${currentUsage.needsPayment ? '⏳ Required' : '✅ Active'}\n\n📄 **Your Data:**\n• CV uploaded: ${hasCV ? '✅ Yes' : '❌ No'}\n• Cover letter: ${hasCoverLetter ? '✅ Ready' : '❌ Needed'}\n• Current state: ${userState}`;

  if (sessionData.lastLocation || sessionData.lastJobType) {
    statusMessage += `\n\n🎯 **Your Preferences:**`;
    if (sessionData.lastLocation) {
      statusMessage += `\n• Last location: ${sessionData.lastLocation}`;
    }
    if (sessionData.lastJobType) {
      statusMessage += `\n• Last job type: ${sessionData.lastJobType}`;
    }
  }

  statusMessage += `\n\n💡 Type "reset" to clear your session`;

  return this.sendMessage(identifier, statusMessage);
}

      case 'clarify': {
        // NEW: Send response and update session with partial detection
        if (intent.filters) { // If partial filters were detected
          await this.updateSessionContext(identifier, {
            location: intent.filters.location || (intent.filters.remote ? 'Remote' : null),
            jobType: intent.filters.title
          });
        }
        return this.sendMessage(identifier, intent.response);
      }

      default: {
        if (intent?.response) {
          return this.sendMessage(identifier, intent.response);
        }
        return this.sendMessage(identifier, 'I\'m here to help with job searches! Try "find developer jobs in Lagos" or "help" for commands.');
      }
    }
    
  } catch (error) {
    logger.error('Intent processing error', { identifier, action: intent?.action, error: error.message });
    return this.sendMessage(identifier, '❌ Sorry, something went wrong. Please try again or type "help".');
  }
}

// ================================
  // JOB SEARCH METHOD
  // ================================

async searchJobs(identifier, filters) {
  try {
    const cacheKey = `jobs:${JSON.stringify(filters)}`;
    const cached = await redis.get(cacheKey);
    
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (parsed && parsed.rows) {
          await redis.set(`last_jobs:${identifier}`, JSON.stringify(parsed.rows), 'EX', 3600);
          return this.sendMessage(identifier, parsed.response);
        }
      } catch (e) {
        logger.error('Failed to parse cached jobs', { cached, error: e.message });
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
  const searchedLocation = filters.location || 'that location';
  const searchedJob = filters.title || 'jobs';
  
  return this.sendMessage(identifier, 
    `🔍 No ${searchedJob} jobs found in ${searchedLocation}\n\n💡 Try these popular cities:\n• Lagos (most jobs)\n• Abuja (government & tech)\n• Port Harcourt (oil & gas)\n\nOr search for "remote ${searchedJob} jobs"`
  );
}

    // ✨ CLEAN NUMBERED JOB FORMATTING ✨
    let response = `🔍 Found ${rows.length} ${filters.remote ? 'Remote ' : ''}Job${rows.length > 1 ? 's' : ''}\n\n`;

    rows.forEach((job, index) => {
      // Calculate days until expiry
      let expiryText = '';
      if (job.expires_at) {
        const daysLeft = Math.ceil((new Date(job.expires_at) - new Date()) / (1000 * 60 * 60 * 24));
        expiryText = `⏰ Expires in ${daysLeft} days`;
      }

      // Format salary
      const salaryText = job.salary ? `💰 ${job.salary}` : '💰 Salary to be discussed';

      // Use job number for application
      const jobNumber = index + 1;

      // Clean numbered format
      response += `*${jobNumber}.* 🚀 *${job.title.toUpperCase()}*\n`;
      response += `   🏢 ${job.company}\n`;
      response += `   📍 ${job.is_remote ? '🌍 Remote work' : job.location}\n`;
      response += `   ${salaryText}\n`;
      
      if (expiryText) {
        response += `   ${expiryText}\n`;
      }
      
      response += `   💬 Reply: "apply ${jobNumber}" to apply\n\n`;
    });

    // Add action instructions at the bottom
    response += `*Quick Actions:*\n`;
    response += `• "apply all" - Apply to all ${rows.length} jobs\n`;
    response += `• Type "apply 1" for first job, "apply 2" for second job\n`;
    
    if (rows.length === 10) {
      response += `• "more jobs" - See more results\n`;
    }
    
    response += `• Upload CV first if you haven't yet`;

    await redis.set(`last_jobs:${identifier}`, JSON.stringify(rows), 'EX', 3600);
    await redis.set(cacheKey, JSON.stringify({ response, rows }), 'EX', 3600);

    return this.sendMessage(identifier, response);

  } catch (error) {
    logger.error('Job search error', { identifier, filters, error: error.message });
    return this.sendMessage(identifier, '❌ Job search failed. Please try again or contact support.');
  }
}


  // ================================
  // PAYMENT PROCESSING
  // ================================

  async processPayment(reference) {
    const [type, uuid, identifier] = reference.split('_');
    
    if (type !== 'daily') {
      logger.warn('Unknown payment reference type', { reference });
      return;
    }

    const paymentSuccess = await paystackService.verifyPayment(reference);
    
    if (paymentSuccess) {
      const today = new Date().toISOString().split('T')[0];
      
      // Give user 10 applications for today
      await dbManager.query(`
        UPDATE daily_usage 
        SET 
          applications_remaining = 10,
          payment_status = 'completed',
          updated_at = NOW()
        WHERE user_identifier = $1 AND usage_date = $2
      `, [identifier, today]);

      const pendingJobs = await redis.get(`pending_jobs:${identifier}`);
      
      if (pendingJobs) {
        // Auto-apply to pending jobs
        let jobs = [];
        try {
          jobs = JSON.parse(pendingJobs);
        } catch (e) {
          logger.error('Failed to parse pending jobs', { pendingJobs, error: e.message });
        }
        await redis.del(`pending_jobs:${identifier}`);
        
        if (jobs.length > 0) {
          // Apply to jobs automatically after a short delay
          setTimeout(() => {
            this.applyToJobs(identifier, jobs);
          }, 1000);
          
          return this.sendMessage(identifier, 
            `✅ Payment successful!\n\n🎯 Applying to your ${jobs.length} selected job(s) now...\n\n📊 Applications remaining: ${10 - jobs.length}/10`
          );
        }
      }

      return this.sendMessage(identifier, 
        `✅ Payment successful!\n\n📊 You now have 10 job applications for today!\n\n💡 Upload your CV and start applying!`
      );
    } else {
      return this.sendMessage(identifier, '❌ Payment failed. Please try again.');
    }
  }

  // ================================
  // USER STATE MANAGEMENT
  // ================================
  
  async setUserState(identifier, state) {
    try {
      await redis.set(`state:${identifier}`, state, 'EX', 86400);
    } catch (error) {
      logger.error('Failed to set user state', { identifier, state, error: error.message });
    }
  }

  async getUserState(identifier) {
    try {
      return await redis.get(`state:${identifier}`) || 'idle';
    } catch (error) {
      logger.error('Failed to get user state', { identifier, error: error.message });
      return 'idle';
    }
  }

  async handleResetCommand(identifier) {
    try {
      // Clear all user data
      const keys = [
        `cv:${identifier}`,
        `cover_letter:${identifier}`,
        `email:${identifier}`,
        `state:${identifier}`,
        `last_jobs:${identifier}`,
        `pending_jobs:${identifier}`,
        `cv_text:${identifier}`,
        `cv_file:${identifier}`
      ];

      for (const key of keys) {
        await redis.del(key);
      }

      await this.setUserState(identifier, 'idle');
      
      return this.sendMessage(identifier, 
        `🔄 **Session Reset Complete**\n\n✅ All your data has been cleared:\n• CV removed\n• Cover letter removed\n• Job search history cleared\n• Application status reset\n\n💡 **Ready for a fresh start!**\n\nYou can now:\n• Upload a new CV\n• Search for jobs\n• "help" for commands\n\nWhat would you like to do?`
      );
    } catch (error) {
      logger.error('Reset command error', { identifier, error: error.message });
      return this.sendMessage(identifier, '❌ Reset failed. Please try again.');
    }
  }

   // Replace your searchJobs method in services/bot.js with this beautiful format:

async searchJobs(identifier, filters) {
  try {
    const cacheKey = `jobs:${JSON.stringify(filters)}`;
    const cached = await redis.get(cacheKey);
    
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (parsed && parsed.rows) {
          await redis.set(`last_jobs:${identifier}`, JSON.stringify(parsed.rows), 'EX', 3600);
          return this.sendMessage(identifier, parsed.response);
        }
      } catch (e) {
        logger.error('Failed to parse cached jobs', { cached, error: e.message });
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
  const searchedLocation = filters.location || 'that location';
  const searchedJob = filters.title || 'jobs';
  
  return this.sendMessage(identifier, 
    `🔍 No ${searchedJob} jobs found in ${searchedLocation}\n\n💡 Try these popular cities:\n• Lagos (most jobs)\n• Abuja (government & tech)\n• Port Harcourt (oil & gas)\n\nOr search for "remote ${searchedJob} jobs"`
  );
}

    // ✨ CLEAN NUMBERED JOB FORMATTING ✨
    let response = `🔍 Found ${rows.length} ${filters.remote ? 'Remote ' : ''}Job${rows.length > 1 ? 's' : ''}\n\n`;

    rows.forEach((job, index) => {
      // Calculate days until expiry
      let expiryText = '';
      if (job.expires_at) {
        const daysLeft = Math.ceil((new Date(job.expires_at) - new Date()) / (1000 * 60 * 60 * 24));
        expiryText = `⏰ Expires in ${daysLeft} days`;
      }

      // Format salary
      const salaryText = job.salary ? `💰 ${job.salary}` : '💰 Salary to be discussed';

      // Use job number for application
      const jobNumber = index + 1;

      // Clean numbered format
      response += `*${jobNumber}.* 🚀 *${job.title.toUpperCase()}*\n`;
      response += `   🏢 ${job.company}\n`;
      response += `   📍 ${job.is_remote ? '🌍 Remote work' : job.location}\n`;
      response += `   ${salaryText}\n`;
      
      if (expiryText) {
        response += `   ${expiryText}\n`;
      }
      
      response += `   💬 Reply: "apply ${jobNumber}" to apply\n\n`;
    });

    // Add action instructions at the bottom
    response += `*Quick Actions:*\n`;
    response += `• "apply all" - Apply to all ${rows.length} jobs\n`;
    response += `• Type "apply 1" for first job, "apply 2" for second job\n`;
    
    if (rows.length === 10) {
      response += `• "more jobs" - See more results\n`;
    }
    
    response += `• Upload CV first if you haven't yet`;

    await redis.set(`last_jobs:${identifier}`, JSON.stringify(rows), 'EX', 3600);
    await redis.set(cacheKey, JSON.stringify({ response, rows }), 'EX', 3600);

    return this.sendMessage(identifier, response);

  } catch (error) {
    logger.error('Job search error', { identifier, filters, error: error.message });
    return this.sendMessage(identifier, '❌ Job search failed. Please try again or contact support.');
  }
}


  // ================================
  // MESSAGING METHODS
  // ================================
    async sendWhatsAppMessage(phone, message) {
  try {
    // Format the phone number
    let chatId = phone;
    
    if (phone.includes('@s.whatsapp.net')) {
      chatId = phone;
    } else if (phone.includes('@')) {
      const number = phone.split('@')[0];
      chatId = `${number}@s.whatsapp.net`;
    } else if (phone.startsWith('+')) {
      chatId = `${phone.substring(1)}@s.whatsapp.net`;
    } else {
      chatId = `${phone}@s.whatsapp.net`;
    }
    
    // Validate message
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      logger.error('Invalid message content', { message });
      return false;
    }
    
    // Step 1: Send typing indicator (fire and forget - don't await)
    axios.post('https://gate.whapi.cloud/chats/typing', 
      {
        to: chatId,
        typing: true
      },
      {
        headers: { 
          'Authorization': `Bearer ${config.get('whatsapp.token')}`,
          'Content-Type': 'application/json'
        },
        timeout: 2000
      }
    ).catch(err => {
      // Ignore typing indicator errors
      console.log('Typing indicator error (ignored):', err.message);
    });
    
    // Step 2: Small delay for typing effect (1.5 seconds max)
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    // Step 3: Send the actual message
    const payload = {
      to: chatId,
      body: message.trim()
    };
    
    const response = await axios.post('https://gate.whapi.cloud/messages/text', payload, {
      headers: { 
        'Authorization': `Bearer ${config.get('whatsapp.token')}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });
    
    if (response.status === 200 && response.data) {
      logger.info('WhatsApp message sent with typing effect', { 
        chatId, 
        messageLength: message.length
      });
      return true;
    } else {
      logger.error('WhatsApp API returned non-200 status', { 
        status: response.status, 
        data: response.data 
      });
      return false;
    }
    
  } catch (error) {
    logger.error('WhatsApp message failed', { phone, error: error.message });
    return false;
  }
}





  async sendTelegramMessage(chatId, message) {
    if (!telegramBot) {
      logger.warn('Telegram bot not initialized, cannot send message', { chatId });
      return 'Telegram bot not available.';
    }
    try {
      await telegramBot.sendMessage(chatId, message);
      return message;
    } catch (error) {
      logger.error('Telegram message failed', { chatId, error: error.message });
      throw error;
    }
  }

async sendMessage(identifier, message) {
  if (identifier.startsWith('+') || /^\d+$/.test(identifier)) {
    // Phone number - use WhatsApp
    return this.sendWhatsAppMessage(identifier, message);
  } else {
    // Chat ID - use Telegram  
    return this.sendTelegramMessage(identifier, message);
  }
}



  // ================================
  // LEGACY COMPATIBILITY (REMOVE THESE METHODS)
  // ================================
  
  // Keep these for now to avoid breaking existing webhook calls
  async checkPaymentStatus(identifier) {
    const usage = await this.checkDailyUsage(identifier);
    return usage.needsPayment ? 'pending' : 'completed';
  }

  async initiatePayment(identifier) {
    return this.initiateDailyPayment(identifier);
  }
}

module.exports = new CVJobMatchingBot();
