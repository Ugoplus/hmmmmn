// Clean services/bot.js - WhatsApp only, no Telegram

const ycloud = require('./ycloud');
const openaiService = require('./openai');
const paystackService = require('./paystack');
const { Queue } = require('bullmq');
const { v4: uuidv4 } = require('uuid');
const redis = require('../config/redis');
const dbManager = require('../config/database');
const logger = require('../utils/logger');
const nodemailer = require('nodemailer');
const config = require('../config');

const cvQueue = new Queue('cv-processing', { connection: redis });

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

class SmartCVNaijaBot {
  
  // ================================
  // MAIN MESSAGE HANDLER (WhatsApp Only)
  // ================================
  
  async handleWhatsAppMessage(phone, message, file = null) {
    try {
      console.log('Bot handling WhatsApp message:', { phone, hasMessage: !!message, hasFile: !!file });
      
      // Handle file uploads
      if (file) {
        return await this.handleFileUpload(phone, file);
      }

      // Handle text messages
      if (!message || typeof message !== 'string') {
        return this.sendWhatsAppMessage(phone, 
          'Hi! I help you find jobs in Nigeria. What can I do for you? 😊'
        );
      }

      // Check user state first
      const state = await redis.get(`state:${phone}`);
      
      if (state === 'awaiting_cover_letter') {
        return await this.handleCoverLetterInput(phone, message);
      }

      // Send to AI with conversation memory
      return await this.handleWithConversationMemory(phone, message);

    } catch (error) {
      console.error('WhatsApp message processing error:', error);
      return this.sendWhatsAppMessage(phone, 
        '❌ Sorry, something went wrong. Please try again.'
      );
    }
  }

  // ================================
  // CONVERSATION MEMORY HANDLER
  // ================================
  
  async handleWithConversationMemory(phone, message) {
    try {
      // Get user context for AI
      const userContext = await this.getUserContext(phone);
      
      // Rate limiting protection
      const rateLimitKey = `rate:${phone}`;
      const callCount = await redis.incr(rateLimitKey);
      
      if (callCount === 1) {
        await redis.expire(rateLimitKey, 60);
      }
      
      if (callCount > 15) {
        return this.sendWhatsAppMessage(phone,
          'Please slow down a bit! I need a moment to process. Try again in a minute. 😅'
        );
      }

      // Send to enhanced AI worker with context
      const intent = await Promise.race([
        openaiService.parseJobQuery(message, phone, {
          platform: 'whatsapp',
          userContext: userContext,
          timestamp: Date.now()
        }),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('AI timeout')), 6000)
        )
      ]);

      return await this.processEnhancedIntent(phone, intent, message);

    } catch (error) {
      console.error('Conversation memory processing error:', error);
      return this.handleEnhancedFallback(phone, message);
    }
  }

  // ================================
  // USER CONTEXT BUILDER
  // ================================
  
  async getUserContext(phone) {
    try {
      const [hasCV, hasCoverLetter, usage, conversationHistory] = await Promise.all([
        redis.exists(`cv:${phone}`),
        redis.exists(`cover_letter:${phone}`),
        this.checkDailyUsage(phone),
        this.getRecentConversation(phone)
      ]);

      return {
        hasCV: !!hasCV,
        hasCoverLetter: !!hasCoverLetter,
        applicationsToday: usage.totalToday || 0,
        applicationsRemaining: usage.remaining || 0,
        needsPayment: usage.needsPayment || false,
        recentMessages: conversationHistory,
        lastActive: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error building user context:', error);
      return { recentMessages: [] };
    }
  }

  async getRecentConversation(phone) {
    try {
      const historyKey = `conversation:${phone}`;
      const historyStr = await redis.get(historyKey);
      
      if (!historyStr) return [];
      
      const history = JSON.parse(historyStr);
      return history.slice(-4);
    } catch (error) {
      return [];
    }
  }

  // ================================
  // ENHANCED INTENT PROCESSING
  // ================================
  
  async processEnhancedIntent(phone, intent, originalMessage) {
    try {
      console.log('Processing enhanced intent:', { 
        action: intent?.action, 
        hasFilters: !!intent?.filters,
        phone 
      });

      switch (intent?.action) {
        
        case 'search_jobs': {
          if (intent.filters && (intent.filters.title || intent.filters.location || intent.filters.remote)) {
            await this.sendWhatsAppMessage(phone, intent.response || '🔍 Searching for jobs...');
            return await this.searchJobs(phone, intent.filters);
          }
          
          return this.sendWhatsAppMessage(phone, 
            intent.response || 'I can help you find jobs! What type of work interests you, and which city? 🏙️'
          );
        }

        case 'apply_job': {
          await this.sendWhatsAppMessage(phone, intent.response || 'Let me help you apply...');
          return await this.handleJobApplicationFromIntent(phone, intent, originalMessage);
        }

        case 'upload_cv': {
          return this.sendWhatsAppMessage(phone, 
            intent.response || '📄 Please upload your CV as a PDF or DOCX document.'
          );
        }

        case 'get_payment': {
          await this.sendWhatsAppMessage(phone, intent.response || 'Setting up payment...');
          return await this.handlePaymentRequest(phone);
        }

        case 'status': {
          return await this.handleStatusRequest(phone);
        }

        case 'help': {
          return this.sendWhatsAppMessage(phone, 
            intent.response || this.getHelpMessage()
          );
        }

        case 'clarify': {
          return this.sendWhatsAppMessage(phone, 
            intent.response || 'Could you tell me more about what you\'re looking for? 🤔'
          );
        }

        default: {
          return this.sendWhatsAppMessage(phone, 
            intent.response || 'I\'m here to help with job searches! What would you like to do? 💼'
          );
        }
      }
      
    } catch (error) {
      console.error('Enhanced intent processing error:', error);
      return this.sendWhatsAppMessage(phone, 
        '❌ Something went wrong processing your request. Please try again.'
      );
    }
  }

  // ================================
  // ENHANCED FALLBACK
  // ================================
  
  async handleEnhancedFallback(phone, message) {
    try {
      const recentMessages = await this.getRecentConversation(phone);
      const context = recentMessages.map(m => m.content || '').join(' ').toLowerCase();
      const text = message.toLowerCase().trim();
      
      const combinedText = `${context} ${text}`;
      
      const jobTypes = ['developer', 'marketing', 'sales', 'teacher', 'nurse', 'engineer', 'manager'];
      const locations = ['lagos', 'abuja', 'kano', 'port harcourt', 'kaduna', 'ibadan', 'remote'];
      
      let jobType = null;
      let location = null;
      
      for (const job of jobTypes) {
        if (combinedText.includes(job)) {
          jobType = job;
          break;
        }
      }
      
      for (const loc of locations) {
        if (combinedText.includes(loc)) {
          location = loc;
          break;
        }
      }
      
      if (jobType && location) {
        await this.sendWhatsAppMessage(phone, 
          `Got it! Searching for ${jobType} jobs in ${location.charAt(0).toUpperCase() + location.slice(1)}...`
        );
        return this.searchJobs(phone, { 
          title: jobType, 
          location: location.charAt(0).toUpperCase() + location.slice(1) 
        });
      }
      
      if (text.includes('hello') || text.includes('hi')) {
        return this.sendWhatsAppMessage(phone,
          'Hello! I help people find jobs across Nigeria. What kind of work are you looking for? 😊'
        );
      }
      
      if (text.includes('help')) {
        return this.sendWhatsAppMessage(phone, this.getHelpMessage());
      }
      
      return this.sendWhatsAppMessage(phone,
        'I can help you find jobs! Try telling me what type of work interests you and which city. 💼'
      );
      
    } catch (error) {
      console.error('Enhanced fallback error:', error);
      return this.sendWhatsAppMessage(phone,
        'I\'m here to help with job searches. What can I do for you? 🤝'
      );
    }
  }

  // ================================
  // MESSAGING (WhatsApp Only)
  // ================================
  
  async sendWhatsAppMessage(phone, message) {
    return await ycloud.sendTextMessage(phone, message);
  }

  // ================================
  // DAILY USAGE MANAGEMENT
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

  // ================================
  // FILE HANDLING
  // ================================
  
  async handleFileUpload(phone, file) {
    try {
      const usage = await this.checkDailyUsage(phone);
      if (usage.needsPayment) {
        const paymentUrl = await this.initiateDailyPayment(phone);
        return this.sendWhatsAppMessage(phone, 
          `💰 Payment Required\n\nGet 10 job applications for ₦500!\n\nPay: ${paymentUrl}`
        );
      }
      
      if (file.buffer.length > 5 * 1024 * 1024) {
        return this.sendWhatsAppMessage(phone, '❌ File too large (max 5MB).');
      }

      await this.sendWhatsAppMessage(phone, '⏳ Processing your CV...');
      this.processCVAsync(phone, file);
      return true;

    } catch (error) {
      console.error('File upload error:', error);
      return this.sendWhatsAppMessage(phone, 
        '❌ Failed to process CV. Please try again with a valid PDF or DOCX file.'
      );
    }
  }

  async processCVAsync(phone, file) {
    try {
      const job = await cvQueue.add('process-cv', { 
        file: {
          buffer: file.buffer,
          originalname: file.originalname,
          mimetype: file.mimetype
        }, 
        identifier: phone 
      });
      
      const cvText = await Promise.race([
        job.waitUntilFinished(cvQueue),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('CV processing timeout')), 60000)
        )
      ]);
      
      await redis.set(`cv:${phone}`, cvText, 'EX', 86400);
      await redis.set(`state:${phone}`, 'awaiting_cover_letter', 'EX', 86400);
      
      await this.sendWhatsAppMessage(phone, 
        `✅ CV processed successfully!\n\n📝 Send a cover letter or type "generate" to create one automatically.`
      );

    } catch (error) {
      console.error('Async CV processing failed:', error);
      await this.sendWhatsAppMessage(phone, 
        '❌ CV processing failed. Please try uploading again.'
      );
    }
  }

  async handleCoverLetterInput(phone, message) {
    try {
      const text = message.toLowerCase().trim();
      let coverLetter = message;
      
      if (text === 'generate') {
        await this.sendWhatsAppMessage(phone, '⏳ Generating cover letter...');
        
        const cvText = await redis.get(`cv:${phone}`);
        if (!cvText) {
          return this.sendWhatsAppMessage(phone, '❌ CV not found. Please upload again.');
        }
        
        coverLetter = await openaiService.generateCoverLetter(cvText);
      }
      
      await redis.set(`cover_letter:${phone}`, coverLetter, 'EX', 86400);
      await redis.del(`state:${phone}`);
      
      const usage = await this.checkDailyUsage(phone);
      return this.sendWhatsAppMessage(phone, 
        `✅ Cover letter saved!\n\n📊 Applications remaining: ${usage.remaining}/10\n\n🔍 Search for jobs:\n• "find developer jobs in Lagos"\n• "marketing jobs Abuja"`
      );

    } catch (error) {
      console.error('Cover letter processing error:', error);
      return this.sendWhatsAppMessage(phone, '❌ Please try again.');
    }
  }

  // ================================
  // JOB SEARCH
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
            return this.sendWhatsAppMessage(identifier, parsed.response);
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
        
        return this.sendWhatsAppMessage(identifier, 
          `🔍 No ${searchedJob} jobs found in ${searchedLocation}\n\n💡 Try these popular cities:\n• Lagos (most jobs)\n• Abuja (government & tech)\n• Port Harcourt (oil & gas)\n\nOr search for "remote ${searchedJob} jobs"`
        );
      }

      let response = `🔍 Found ${rows.length} ${filters.remote ? 'Remote ' : ''}Job${rows.length > 1 ? 's' : ''}\n\n`;

      rows.forEach((job, index) => {
        let expiryText = '';
        if (job.expires_at) {
          const daysLeft = Math.ceil((new Date(job.expires_at) - new Date()) / (1000 * 60 * 60 * 24));
          expiryText = `⏰ Expires in ${daysLeft} days`;
        }

        const salaryText = job.salary ? `💰 ${job.salary}` : '💰 Salary to be discussed';
        const jobNumber = index + 1;

        response += `*${jobNumber}.* 🚀 *${job.title.toUpperCase()}*\n`;
        response += `   🏢 ${job.company}\n`;
        response += `   📍 ${job.is_remote ? '🌍 Remote work' : job.location}\n`;
        response += `   ${salaryText}\n`;
        
        if (expiryText) {
          response += `   ${expiryText}\n`;
        }
        
        response += `   💬 Reply: "apply ${jobNumber}" to apply\n\n`;
      });

      response += `*Quick Actions:*\n`;
      response += `• "apply all" - Apply to all ${rows.length} jobs\n`;
      response += `• Type "apply 1" for first job, "apply 2" for second job\n`;
      
      if (rows.length === 10) {
        response += `• "more jobs" - See more results\n`;
      }
      
      response += `• Upload CV first if you haven't yet`;

      await redis.set(`last_jobs:${identifier}`, JSON.stringify(rows), 'EX', 3600);
      await redis.set(cacheKey, JSON.stringify({ response, rows }), 'EX', 3600);

      return this.sendWhatsAppMessage(identifier, response);

    } catch (error) {
      logger.error('Job search error', { identifier, filters, error: error.message });
      return this.sendWhatsAppMessage(identifier, '❌ Job search failed. Please try again or contact support.');
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
        let jobs = [];
        try {
          jobs = JSON.parse(pendingJobs);
        } catch (e) {
          logger.error('Failed to parse pending jobs', { pendingJobs, error: e.message });
        }
        await redis.del(`pending_jobs:${identifier}`);
        
        if (jobs.length > 0) {
          setTimeout(() => {
            this.applyToJobs(identifier, jobs);
          }, 1000);
          
          return this.sendWhatsAppMessage(identifier, 
            `✅ Payment successful!\n\n🎯 Applying to your ${jobs.length} selected job(s) now...\n\n📊 Applications remaining: ${10 - jobs.length}/10`
          );
        }
      }

      return this.sendWhatsAppMessage(identifier, 
        `✅ Payment successful!\n\n📊 You now have 10 job applications for today!\n\n💡 Upload your CV and start applying!`
      );
    } else {
      return this.sendWhatsAppMessage(identifier, '❌ Payment failed. Please try again.');
    }
  }

  // ================================
  // HELPER METHODS
  // ================================
  
  getHelpMessage() {
    return `🇳🇬 SmartCVNaija Help

💼 **What I can do:**
• Find jobs across Nigeria
• Help you apply to multiple positions
• Process your CV uploads
• Natural conversation about work

🔍 **Try saying:**
• "Find developer jobs in Lagos"
• "I'm looking for marketing work"
• "Apply to job 1, 2, 3"
• "What's my status?"

💰 **Pricing:** ₦500 for 10 job applications daily

Just talk to me naturally - I'll understand! 😊`;
  }

  async handleStatusRequest(phone) {
    const usage = await this.checkDailyUsage(phone);
    const hasCV = await redis.exists(`cv:${phone}`);
    const hasCoverLetter = await redis.exists(`cover_letter:${phone}`);
    
    return this.sendWhatsAppMessage(phone, 
      `📊 **Your Status**

📈 **Today's Usage:**
• Applications used: ${usage.totalToday}/10
• Remaining: ${usage.remaining}/10
• Payment: ${usage.needsPayment ? '⏳ Required' : '✅ Active'}

📄 **Your Files:**
• CV uploaded: ${hasCV ? '✅' : '❌'}
• Cover letter: ${hasCoverLetter ? '✅' : '❌'}

${usage.needsPayment ? '\n💰 Pay ₦500 to get 10 applications for today!' : '\n🚀 You\'re ready to apply to jobs!'}`
    );
  }

  async handlePaymentRequest(phone) {
    try {
      const paymentUrl = await this.initiateDailyPayment(phone);
      return this.sendWhatsAppMessage(phone, 
        `💰 **Get 10 Job Applications - ₦500**

Pay securely with Paystack:
${paymentUrl}

✅ Instant activation after payment
🔒 Secure payment processing
📱 Works with cards, bank transfer, USSD

After payment, you can apply to jobs immediately!`
      );
    } catch (error) {
      console.error('Payment request error:', error);
      return this.sendWhatsAppMessage(phone,
        '❌ Payment setup failed. Please try again or contact support.'
      );
    }
  }

  async handleResetCommand(identifier) {
    try {
      const keys = [
        `cv:${identifier}`,
        `cover_letter:${identifier}`,
        `email:${identifier}`,
        `state:${identifier}`,
        `last_jobs:${identifier}`,
        `pending_jobs:${identifier}`,
        `cv_text:${identifier}`,
        `cv_file:${identifier}`,
        `conversation:${identifier}`
      ];

      for (const key of keys) {
        await redis.del(key);
      }

      await redis.set(`state:${identifier}`, 'idle', 'EX', 86400);
      
      return this.sendWhatsAppMessage(identifier, 
        `🔄 **Session Reset Complete**

✅ All your data has been cleared:
• CV removed
• Cover letter removed
• Job search history cleared
• Conversation history cleared

💡 **Ready for a fresh start!**

What would you like to do?`
      );
    } catch (error) {
      logger.error('Reset command error', { identifier, error: error.message });
      return this.sendWhatsAppMessage(identifier, '❌ Reset failed. Please try again.');
    }
  }

  // Add placeholder methods for job application handling
  async handleJobApplicationFromIntent(phone, intent, message) {
    // Implementation for job applications
    return this.sendWhatsAppMessage(phone, 'Job application feature coming soon!');
  }

  async applyToJobs(identifier, jobs) {
    // Implementation for applying to jobs
    logger.info('Applying to jobs', { identifier, jobCount: jobs.length });
  }
}

module.exports = new SmartCVNaijaBot();