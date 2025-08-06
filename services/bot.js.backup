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
  maxRetriesPerRequest: null   // ✅ IMPORTANT for BullMQ!
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
  async handleWhatsAppMessage(phone, message, file = null) {
    try {
      if (file) {
        const paymentStatus = await this.checkPaymentStatus(phone);
        if (paymentStatus !== 'completed') {
          const paymentUrl = await this.initiatePayment(phone);
          return this.sendWhatsAppMessage(phone, `Please complete the payment of ₦${(config.get('paystack.amount') / 100).toFixed(2)} before uploading your CV: ${paymentUrl}`);
        }
        if (file.buffer.length > 5 * 1024 * 1024) {
          return this.sendWhatsAppMessage(phone, 'File is too large. Please upload a CV smaller than 5MB.');
        }
        const job = await cvQueue.add('process-cv', { file, identifier: phone });
        const cvText = await job.waitUntilFinished(cvQueue);
        await redis.set(`cv:${phone}`, cvText, 'EX', 86400);
        await redis.set(`email:${phone}`, file.email || `${phone}@example.com`, 'EX', 86400);
        await redis.set(`state:${phone}`, 'awaiting_cover_letter', 'EX', 86400);
        return this.sendWhatsAppMessage(phone, 'CV uploaded successfully! Please provide a cover letter for your application or reply "generate" to create one.');
      }

      const state = await redis.get(`state:${phone}`);
      if (state === 'awaiting_cover_letter' && message) {
        let coverLetter = message;
        if (message.toLowerCase() === 'generate') {
          const cvText = await redis.get(`cv:${phone}`);
          coverLetter = await openaiService.generateCoverLetter(cvText);
        }
        await redis.set(`cover_letter:${phone}`, coverLetter, 'EX', 86400);
        await redis.del(`state:${phone}`);
        const pendingJobs = await redis.get(`pending_jobs:${phone}`);
        if (pendingJobs) {
          let jobs = [];
          try {
            jobs = JSON.parse(pendingJobs);
          } catch (e) {
            logger.error('Failed to parse pending jobs', { pendingJobs, error: e.message });
          }
          await redis.del(`pending_jobs:${phone}`);
          return this.applyToJobs(phone, jobs);
        }
        return this.sendWhatsAppMessage(phone, 'Cover letter saved! You can now search for jobs or apply.');
      }

      const intent = await openaiService.parseJobQuery(message);
      return await this.processIntent(phone, intent);
    } catch (error) {
      logger.error('WhatsApp message processing error', { phone, error });
      return this.sendWhatsAppMessage(phone, 'Sorry, an error occurred. Please try again.');
    }
  }

  async handleTelegramMessage(chatId, message, file = null) {
    try {
      if (file) {
        const paymentStatus = await this.checkPaymentStatus(chatId);
        if (paymentStatus !== 'completed') {
          const paymentUrl = await this.initiatePayment(chatId);
          return this.sendTelegramMessage(chatId, `Please complete the payment of ₦${(config.get('paystack.amount') / 100).toFixed(2)} before uploading your CV: ${paymentUrl}`);
        }
        if (file.buffer.length > 5 * 1024 * 1024) {
          return this.sendTelegramMessage(chatId, 'File is too large. Please upload a CV smaller than 5MB.');
        }
        const job = await cvQueue.add('process-cv', { file, identifier: chatId });
        const cvText = await job.waitUntilFinished(cvQueue);
        await redis.set(`cv:${chatId}`, cvText, 'EX', 86400);
        await redis.set(`email:${chatId}`, file.email || `${chatId}@example.com`, 'EX', 86400);
        await redis.set(`state:${chatId}`, 'awaiting_cover_letter', 'EX', 86400);
        return this.sendTelegramMessage(chatId, 'CV uploaded successfully! Please provide a cover letter for your application or reply "generate" to create one.');
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
        return this.sendTelegramMessage(chatId, 'Cover letter saved! You can now search for jobs or apply.');
      }

      const intent = await openaiService.parseJobQuery(message);
      return await this.processIntent(chatId, intent);
    } catch (error) {
      logger.error('Telegram message processing error', { chatId, error });
      return this.sendTelegramMessage(chatId, 'Sorry, an error occurred. Please try again.');
    }
  }

  async checkPaymentStatus(identifier) {
    const { rows: [payment] } = await pool.query('SELECT payment_status FROM payments WHERE user_identifier = $1', [identifier]);
    return payment ? payment.payment_status : 'pending';
  }

  async initiatePayment(identifier) {
    const email = await redis.get(`email:${identifier}`) || `${identifier}@example.com`;
    const reference = `${uuidv4()}_${identifier}`;
    await pool.query(
      'INSERT INTO payments (user_identifier, payment_status, payment_reference) VALUES ($1, $2, $3) ON CONFLICT (user_identifier) DO UPDATE SET payment_reference = $3',
      [identifier, 'pending', reference]
    );
    return paystackService.initializePayment(identifier, reference, email);
  }

  async processIntent(identifier, intent) {
    switch (intent.action) {
      case 'search_jobs': {
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
            return this.sendMessage(identifier, parsed.response);
          }
        }
        const { title, location, company, remote } = intent.filters;
        const query = `
          SELECT * FROM jobs 
          WHERE ($1::text IS NULL OR title ILIKE $1)
          AND ($2::text IS NULL OR location ILIKE $2)
          AND ($3::text IS NULL OR company ILIKE $3)
          AND ($4::boolean IS NULL OR is_remote = $4)
          LIMIT 5`;
        const { rows } = await pool.query(query, [
          title ? `%${title}%` : null,
          location ? `%${location}%` : null,
          company ? `%${company}%` : null,
          typeof remote === 'boolean' ? remote : null
        ]);
        if (rows.length === 0) {
          return this.sendMessage(identifier, 'No jobs found. Try different filters.');
        }
        const response = `Found ${rows.length} jobs:\n${rows.map((job, i) => `${i + 1}. ${job.title} at ${job.company} (${job.location})`).join('\n')}\nReply with 'apply all' or 'apply <number>' (e.g., 'apply 1').`;
        await redis.set(`last_jobs:${identifier}`, JSON.stringify(rows), 'EX', 3600);
        await redis.set(cacheKey, JSON.stringify({ response, rows }), 'EX', 3600);
        return this.sendMessage(identifier, response);
      }
      case 'apply_job': {
        const paymentStatus = await this.checkPaymentStatus(identifier);
        if (paymentStatus !== 'completed') {
          const paymentUrl = await this.initiatePayment(identifier);
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
          } else if (intent.jobId) {
            jobIds = [intent.jobId];
          }
          await redis.set(`pending_jobs:${identifier}`, JSON.stringify(jobIds), 'EX', 86400);
          return this.sendMessage(identifier, `Please pay ₦${(config.get('paystack.amount') / 100).toFixed(2)} to proceed with CV upload and application: ${paymentUrl}`);
        }
        const cvText = await redis.get(`cv:${identifier}`);
        if (!cvText) {
          return this.sendMessage(identifier, 'Please upload your CV (PDF or DOCX, max 5MB) in this chat.');
        }
        const coverLetter = await redis.get(`cover_letter:${identifier}`);
        if (!coverLetter) {
          await redis.set(`state:${identifier}`, 'awaiting_cover_letter', 'EX', 86400);
          return this.sendMessage(identifier, 'Please provide a cover letter for your application or reply "generate" to create one.');
        }
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
        } else if (intent.jobId) {
          jobIds = [intent.jobId];
        }
        return this.applyToJobs(identifier, jobIds);
      }
      default:
        return this.sendMessage(identifier, intent.response || 'I didn\'t understand that. Try "find jobs" or "upload CV".');
    }
  }

  async applyToJobs(identifier, jobIds) {
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
        'INSERT INTO applications (id, user_identifier, job_id, cv_text, cv_score) VALUES ($1, $2, $3, $4, $5)',
        [applicationId, identifier, jobId, cvText, analysis]
      );
      await this.sendEmailToRecruiter(job.email, job.title, cvText, coverLetter, email);
      applications.push({ id: applicationId, title: job.title });
    }
    if (applications.length === 0) {
      return this.sendMessage(identifier, 'No valid jobs to apply to.');
    }
    const response = `Applied to ${applications.length} job(s):\n${applications.map(app => `- ${app.title} (ID: ${app.id})`).join('\n')}`;
    return this.sendMessage(identifier, response);
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

  async processPayment(reference) {
    const [, identifier] = reference.split('_');
    const paymentSuccess = await paystackService.verifyPayment(reference);
    if (paymentSuccess) {
      await pool.query(
        'UPDATE payments SET payment_status = $1 WHERE user_identifier = $2 AND payment_reference = $3',
        ['completed', identifier, reference]
      );
      const pendingJobs = await redis.get(`pending_jobs:${identifier}`);
      return this.sendMessage(identifier, `Payment successful! Please upload your CV (PDF or DOCX, max 5MB) in this chat${pendingJobs ? ' to proceed with your application(s)' : ' to apply for jobs'}.`);
    } else {
      return this.sendMessage(identifier, 'Payment failed. Please try again.');
    }
  }

  async sendWhatsAppMessage(phone, message) {
    try {
      await axios.post('https://gate.whapi.cloud/messages/text', {
        to: phone,
        body: message
      }, {
        headers: { Authorization: `Bearer ${config.get('whatsapp.token')}` }
      });
      return message;
    } catch (error) {
      logger.error('WhatsApp message failed', { phone, error: error.message });
      throw error;
    }
  }

  // ✅ This is the method you were looking for!
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
}

module.exports = new CVJobMatchingBot();