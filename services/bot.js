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

const pool = new Pool({
  host: config.get('database.host'),
  port: config.get('database.port'),
  database: config.get('database.name'),
  user: config.get('database.user'),
  password: config.get('database.password'),
  max: config.get('database.maxConnections')
});

const redis = new Redis({
  host: config.get('redis.host'),
  port: config.get('redis.port'),
  password: config.get('redis.password'),
  maxRetriesPerRequest: null  // ✅ REQUIRED for BullMQ
});


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

class CVJobMatchingBot {
  
  // ================================
  // DAILY USAGE MANAGEMENT
  // ================================
  
  async checkDailyUsage(identifier) {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
    
    const { rows: [usage] } = await pool.query(`
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
    await pool.query(`
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
    
    await pool.query(`
      UPDATE daily_usage 
      SET payment_reference = $1, payment_status = 'pending', updated_at = NOW()
      WHERE user_identifier = $2
    `, [reference, identifier]);
    
    return paystackService.initializePayment(identifier, reference, email);
  }

  async deductApplications(identifier, count) {
    const result = await pool.query(`
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
    // ... your existing code ...
    
    console.log('=== DEBUG: About to parse intent ===', { message });
    try {
      let intent;
if (message.toLowerCase().includes('job') || message.toLowerCase().includes('find')) {
  intent = { action: 'search_jobs', filters: {} };
} else {
  intent = { action: 'greeting' };
}      
      console.log('=== DEBUG: Intent parsed successfully ===', { intent });
      
      console.log('=== DEBUG: About to process intent ===');
      const result = await this.processIntent(phone, intent);
      console.log('=== DEBUG: processIntent result ===', { result });
      return result;
    } catch (intentError) {
      console.log('=== DEBUG: Intent parsing failed ===', { 
        error: intentError.message,
        stack: intentError.stack 
      });
      const result = await this.processIntent(phone, { action: 'greeting' });
      return result;
    }
  } catch (error) {
    console.log('=== DEBUG: Error in handleWhatsAppMessage ===', error);
    logger.error('WhatsApp message processing error', { phone, error });
    return this.sendWhatsAppMessage(phone, 'Sorry, an error occurred. Please try again.');
  }
}  // ✅ This closes handleWhatsAppMessage

  

     
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

      const intent = await openaiService.parseJobQuery(message);
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
switch (intent.action) {
  case 'greeting':
    const usage = await this.checkDailyUsage(identifier);
    return this.sendMessage(identifier,
      `👋 Hello! Welcome to SmartCVNaija!\n\n📊 Applications today: ${usage.totalToday}/10\n📊 Remaining: ${usage.remaining}/10\n\n💬 I can help you:\n• "find jobs in Lagos"\n• "remote developer jobs"\n• Upload your CV (PDF/DOCX)`
    );
    
  case 'search_jobs': {
    // ... your existing search_jobs code    
        // Job search is free, no usage check needed
        const cacheKey = `jobs:${JSON.stringify(intent.filters)}`;
        const cached = await redis.get(cacheKey);
        if (cached) {
          let parsed;
          try {
            parsed = JSON.parse(cached);
          } catch (e) {
            logger.error('Failed to parse cached jobs', { cached, error: e.message });
          }
          if (parsed) {
            await redis.set(`last_jobs:${identifier}`, JSON.stringify(parsed.rows), 'EX', 3600);
            const usage = await this.checkDailyUsage(identifier);
            const responseWithUsage = `${parsed.response}\n\n📊 Applications remaining today: ${usage.remaining}/10`;
            return this.sendMessage(identifier, responseWithUsage);
          }
        }

        const { title, location, company, remote } = intent.filters;
        const query = `
          SELECT * FROM jobs 
          WHERE ($1::text IS NULL OR title ILIKE $1)
          AND ($2::text IS NULL OR location ILIKE $2)
          AND ($3::text IS NULL OR company ILIKE $3)
          AND ($4::boolean IS NULL OR is_remote = $4)
          LIMIT 10`;
        
        const { rows } = await pool.query(query, [
          title ? `%${title}%` : null,
          location ? `%${location}%` : null,
          company ? `%${company}%` : null,
          typeof remote === 'boolean' ? remote : null
        ]);

        if (rows.length === 0) {
          return this.sendMessage(identifier, '❌ No jobs found. Try different search terms.');
        }

        const usage = await this.checkDailyUsage(identifier);
        const response = `🎯 Found ${rows.length} jobs:\n\n${rows.map((job, i) => 
          `${i + 1}. ${job.title} at ${job.company}\n   📍 ${job.location}${job.is_remote ? ' (Remote)' : ''}`
        ).join('\n\n')}\n\n📊 Applications remaining today: ${usage.remaining}/10\n\n💬 Reply:\n• "apply all" - Apply to all jobs\n• "apply 1,3,5" - Apply to specific jobs\n• "apply 2" - Apply to job #2`;

        await redis.set(`last_jobs:${identifier}`, JSON.stringify(rows), 'EX', 3600);
        await redis.set(cacheKey, JSON.stringify({ response, rows }), 'EX', 3600);
        
        return this.sendMessage(identifier, response);
      }

      case 'apply_job': {
        return await this.handleJobApplication(identifier, intent);
      }

      default: {
        const usage = await this.checkDailyUsage(identifier);
        return this.sendMessage(identifier, 
          `ℹ️ Welcome to SmartCVNaija!\n\n📊 Applications today: ${usage.totalToday}/10\n📊 Remaining: ${usage.remaining}/10\n\n💬 Try:\n• "find jobs in Lagos"\n• "remote developer jobs"\n• Upload your CV (PDF/DOCX)`
        );
      }
    }
  }

  async handleJobApplication(identifier, intent) {
    const usage = await this.checkDailyUsage(identifier);

    // Check if user needs to pay first
    if (usage.needsPayment) {
      let jobIds = [];
      if (intent.applyAll) {
        const lastJobsRaw = await redis.get(`last_jobs:${identifier}`);
        if (lastJobsRaw) {
          try {
            jobIds = JSON.parse(lastJobsRaw).map(job => job.id);
          } catch (e) {
            logger.error('Failed to parse last_jobs', { lastJobsRaw, error: e.message });
          }
        }
      } else if (intent.jobNumbers && intent.jobNumbers.length > 0) {
        const lastJobsRaw = await redis.get(`last_jobs:${identifier}`);
        if (lastJobsRaw) {
          try {
            const allJobs = JSON.parse(lastJobsRaw);
            jobIds = intent.jobNumbers
              .filter(num => num >= 1 && num <= allJobs.length)
              .map(num => allJobs[num - 1].id);
          } catch (e) {
            logger.error('Failed to parse job numbers', { error: e.message });
          }
        }
      }

      await redis.set(`pending_jobs:${identifier}`, JSON.stringify(jobIds), 'EX', 86400);
      const paymentUrl = await this.initiateDailyPayment(identifier);
      
      return this.sendMessage(identifier, 
        `💰 Daily Payment Required\n\nGet 10 job applications for ₦500!\n\nAfter payment, I'll apply to your selected ${jobIds.length} job(s).\n\nPay here: ${paymentUrl}`
      );
    }

    // Check CV and cover letter
    const cvText = await redis.get(`cv:${identifier}`);
    if (!cvText) {
      return this.sendMessage(identifier, '📄 Please upload your CV (PDF or DOCX, max 5MB) first.');
    }

    const coverLetter = await redis.get(`cover_letter:${identifier}`);
    if (!coverLetter) {
      await redis.set(`state:${identifier}`, 'awaiting_cover_letter', 'EX', 86400);
      return this.sendMessage(identifier, '✍️ Please provide a cover letter or reply "generate" to create one.');
    }

    // Determine which jobs to apply to
    let jobIds = [];
    if (intent.applyAll) {
      const lastJobsRaw = await redis.get(`last_jobs:${identifier}`);
      if (lastJobsRaw) {
        try {
          jobIds = JSON.parse(lastJobsRaw).map(job => job.id);
        } catch (e) {
          logger.error('Failed to parse last_jobs', { lastJobsRaw, error: e.message });
        }
      }
    } else if (intent.jobNumbers && intent.jobNumbers.length > 0) {
      const lastJobsRaw = await redis.get(`last_jobs:${identifier}`);
      if (lastJobsRaw) {
        try {
          const allJobs = JSON.parse(lastJobsRaw);
          jobIds = intent.jobNumbers
            .filter(num => num >= 1 && num <= allJobs.length)
            .map(num => allJobs[num - 1].id);
        } catch (e) {
          logger.error('Failed to parse job numbers', { error: e.message });
        }
      }
    }

    if (jobIds.length === 0) {
      return this.sendMessage(identifier, '❌ No valid jobs selected. Please search for jobs first.');
    }

    // Check if user has enough applications remaining
    if (usage.remaining < jobIds.length) {
      return this.sendMessage(identifier, 
        `❌ Not enough applications remaining!\n\n📊 You need: ${jobIds.length} applications\n📊 You have: ${usage.remaining} remaining\n\n💡 You can apply to ${usage.remaining} job(s) now, or wait until tomorrow for a fresh 10 applications.`
      );
    }

    return this.applyToJobs(identifier, jobIds);
  }

  // ================================
  // JOB APPLICATION PROCESSING
  // ================================

  async applyToJobs(identifier, jobIds) {
    try {
      // Deduct applications first
      const usage = await this.deductApplications(identifier, jobIds.length);
      
      const cvText = await redis.get(`cv:${identifier}`);
      const coverLetter = await redis.get(`cover_letter:${identifier}`);
      const email = await redis.get(`email:${identifier}`);
      const applications = [];

      for (const jobId of jobIds) {
        const { rows: [job] } = await pool.query('SELECT * FROM jobs WHERE id = $1', [jobId]);
        if (!job) continue;

        const analysis = await openaiService.analyzeCV(cvText);
        const applicationId = uuidv4();
        
        await pool.query(
          'INSERT INTO applications (id, user_identifier, job_id, cv_text, cv_score, usage_date) VALUES ($1, $2, $3, $4, $5, CURRENT_DATE)',
          [applicationId, identifier, jobId, cvText, analysis]
        );

        await this.sendEmailToRecruiter(job.email, job.title, cvText, coverLetter, email);
        applications.push({ id: applicationId, title: job.title, company: job.company });
      }

      if (applications.length === 0) {
        return this.sendMessage(identifier, '❌ No valid jobs to apply to.');
      }

      const response = `✅ Successfully applied to ${applications.length} job(s):\n\n${applications.map(app => 
        `• ${app.title} at ${app.company}`
      ).join('\n')}\n\n📊 Applications remaining today: ${usage.applications_remaining}/10\n📧 Recruiters have been notified!`;
      
      return this.sendMessage(identifier, response);

    } catch (error) {
      if (error.message === 'Insufficient applications remaining') {
        const usage = await this.checkDailyUsage(identifier);
        return this.sendMessage(identifier, 
          `❌ Not enough applications remaining!\n\n📊 Applications remaining: ${usage.remaining}/10\n\n💡 Come back tomorrow for fresh applications!`
        );
      }
      throw error;
    }
  }

  async sendEmailToRecruiter(recruiterEmail, jobTitle, cvText, coverLetter, applicantEmail) {
    try {
      await transporter.sendMail({
        from: config.get('SMTP_USER'),
        to: recruiterEmail,
        subject: `New Application for ${jobTitle}`,
        text: `A new application has been submitted for ${jobTitle}.\n\nApplicant Email: ${applicantEmail}\n\nCover Letter:\n${coverLetter}\n\nCV:\n${cvText}`
      });
      logger.info('Email sent to recruiter', { recruiterEmail, jobTitle });
    } catch (error) {
      logger.error('Failed to send email to recruiter', { recruiterEmail, error });
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
      await pool.query(`
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
  // MESSAGING METHODS
  // ================================
async sendWhatsAppMessage(phone, message) {
  try {
    // Fix: Convert phone to correct WHAPI chat_id format
    let chatId = phone;
    if (!phone.includes('@')) {
      chatId = `${phone}@s.whatsapp.net`;
    }
    
    console.log('=== Sending WhatsApp message ===', { chatId, message });
    
    await axios.post('https://gate.whapi.cloud/messages/text', {
      to: chatId,  // ✅ Use correct WHAPI format
      body: message
    }, {
      headers: { 
        Authorization: `Bearer ${config.get('whatsapp.token')}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('=== WhatsApp message sent successfully ===');
    return message;
  } catch (error) {
    console.error('=== WhatsApp send error ===', {
      status: error.response?.status,
      data: error.response?.data
    });
    logger.error('WhatsApp message failed', { phone, error: error.message });
    throw error;
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
    if (identifier.startsWith('+')) {
      return this.sendWhatsAppMessage(identifier, message);
    } else {
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
