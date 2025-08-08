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

    const intent = await openaiService.parseJobQuery(message);
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
  try {
    // Handle special commands first
    if (
      intent.action === 'reset' ||
      (intent.response && intent.response.toLowerCase().includes('reset'))
    ) {
      return await this.handleResetCommand(identifier);
    }

    switch (intent.action) {
      case 'greeting': {
        await this.setUserState(identifier, 'idle');
        const usage = await this.checkDailyUsage(identifier);
        return this.sendMessage(
          identifier,
          `👋 Welcome to SmartCVNaija!\n\n📊 Today's Usage:\n• Applications sent: ${usage.totalToday}/10\n• Remaining: ${usage.remaining}/10\n\n💬 I can help you:\n• "find jobs in Lagos"\n• "remote developer jobs"\n• Upload CV (PDF/DOCX)\n• "help" for more options\n• "reset" to clear session`
        );
      }

      case 'help': {
        return this.sendMessage(
          identifier,
          `🆘 **SmartCVNaija Commands**\n\n🔍 **Job Search:**\n• "find jobs in Lagos"\n• "developer jobs"\n• "remote marketing jobs"\n\n📄 **CV & Applications:**\n• Upload your CV (PDF/DOCX)\n• "apply all" - Apply to all jobs\n• "apply 1,2,3" - Apply to specific jobs\n\n💰 **Pricing:** ₦500 for 10 applications daily\n\n🔄 **Other Commands:**\n• "reset" - Clear your session\n• "status" - Check your usage\n\n❓ Need help? Just ask!`
        );
      }

      case 'status': {
        const currentUsage = await this.checkDailyUsage(identifier);
        const userState = await this.getUserState(identifier);
        const hasCV = await redis.exists(`cv:${identifier}`);
        const hasCoverLetter = await redis.exists(`cover_letter:${identifier}`);

        return this.sendMessage(
          identifier,
          `📊 **Your SmartCVNaija Status**\n\n📈 **Usage:**\n• Applications today: ${currentUsage.totalToday}/10\n• Remaining: ${currentUsage.remaining}/10\n• Payment status: ${currentUsage.needsPayment ? '⏳ Required' : '✅ Active'}\n\n📄 **Your Data:**\n• CV uploaded: ${hasCV ? '✅ Yes' : '❌ No'}\n• Cover letter: ${hasCoverLetter ? '✅ Ready' : '❌ Needed'}\n• Current state: ${userState}\n\n💡 ${hasCV ? 'Ready to apply to jobs!' : 'Upload your CV to get started'}`
        );
      }

      case 'search_jobs': {
        await this.setUserState(identifier, 'browsing_jobs');
        return this.searchJobs(identifier, intent.filters);
      }

      case 'apply_job': {
        await this.setUserState(identifier, 'applying');
        const result = await this.handleJobApplication(identifier, intent);
        await this.setUserState(identifier, 'idle');
        return result;
      }

      default: {
        const usage = await this.checkDailyUsage(identifier);
        return this.sendMessage(
          identifier,
          `ℹ️ I didn't understand that request.\n\n📊 Applications today: ${usage.totalToday}/10 | Remaining: ${usage.remaining}/10\n\n💬 **Try:**\n• "find jobs in Lagos"\n• "help" - Full command list\n• "status" - Check your usage\n• Upload your CV (PDF/DOCX)\n\nWhat can I help you with?`
        );
      }
    }
  } catch (error) {
    logger.error('Intent processing error', {
      identifier,
      intent: intent.action,
      error: error.message
    });

    return this.sendMessage(
      identifier,
      '❌ Sorry, I encountered an error. Try "reset" to clear your session or "help" for commands.'
    );
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
      const { rows: [job] } = await dbManager.query('SELECT * FROM jobs WHERE id = $1', [jobId]);
      if (!job) continue;

      // Get CV analysis with job title context
      const analysis = await openaiService.analyzeCV(cvText, job.title);
      const applicationId = uuidv4();
      
      // Store application with CV score (no salary)
      await dbManager.query(
        'INSERT INTO applications (id, user_identifier, job_id, cv_text, cv_score, usage_date) VALUES ($1, $2, $3, $4, $5, CURRENT_DATE)',
        [applicationId, identifier, jobId, cvText, JSON.stringify(analysis)]
      );

      // Send enhanced email with CV score
      await this.sendEmailToRecruiter(job.email, job.title, cvText, coverLetter, email, identifier);
      
      applications.push({ 
        id: applicationId, 
        title: job.title, 
        company: job.company,
        overallScore: analysis.overall_score,
        jobMatchScore: analysis.job_match_score
      });
    }

    if (applications.length === 0) {
      return this.sendMessage(identifier, '❌ No valid jobs to apply to.');
    }

    const avgOverallScore = Math.round(applications.reduce((sum, app) => sum + app.overallScore, 0) / applications.length);
    const avgMatchScore = Math.round(applications.reduce((sum, app) => sum + app.jobMatchScore, 0) / applications.length);
    
    const response = `✅ Successfully applied to ${applications.length} job(s):\n\n${applications.map(app => 
      `• ${app.title} at ${app.company}\n  📊 CV Score: ${app.overallScore}/100 | Match: ${app.jobMatchScore}/100`
    ).join('\n\n')}\n\n📈 Your Performance:\n• Average CV Score: ${avgOverallScore}/100\n• Average Job Match: ${avgMatchScore}/100\n\n📊 Applications remaining: ${usage.applications_remaining}/10\n📧 Recruiters have been notified with detailed analysis!`;
    
    return this.sendMessage(identifier, response);

  } catch (error) {
    logger.error('Job application error', { error: error.message });
    throw error;
  }
}

  async sendEmailToRecruiter(recruiterEmail, jobTitle, cvText, coverLetter, applicantEmail, identifier) {
  try {
    // Get CV analysis/score
    const analysis = await openaiService.analyzeCV(cvText, jobTitle);
    
    // Get the stored CV file
    const cvFilename = await redis.get(`cv_file:${identifier}`);
    let cvBuffer = null;
    
    if (cvFilename && fs.existsSync(`./uploads/${cvFilename}`)) {
      cvBuffer = fs.readFileSync(`./uploads/${cvFilename}`);
    }

    // Create comprehensive email with CV score (no salary)
    const emailHTML = `
      <div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto;">
        <h2 style="color: #2c3e50;">New Job Application - SmartCVNaija</h2>
        
        <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h3 style="color: #27ae60; margin-top: 0;">📊 CV Analysis</h3>
          
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin: 15px 0;">
            <div style="text-align: center; padding: 15px; background: white; border-radius: 6px;">
              <div style="font-size: 24px; font-weight: bold; color: ${analysis.overall_score >= 70 ? '#27ae60' : analysis.overall_score >= 50 ? '#f39c12' : '#e74c3c'}">
                ${analysis.overall_score}/100
              </div>
              <div style="font-size: 12px; color: #7f8c8d;">Overall Score</div>
            </div>
            <div style="text-align: center; padding: 15px; background: white; border-radius: 6px;">
              <div style="font-size: 24px; font-weight: bold; color: ${analysis.job_match_score >= 70 ? '#27ae60' : analysis.job_match_score >= 50 ? '#f39c12' : '#e74c3c'}">
                ${analysis.job_match_score}/100
              </div>
              <div style="font-size: 12px; color: #7f8c8d;">Job Match</div>
            </div>
          </div>
          
          <div style="display: flex; justify-content: space-between; margin: 10px 0; padding: 10px; background: white; border-radius: 6px;">
            <strong>Recommendation:</strong> 
            <span style="padding: 4px 12px; border-radius: 20px; color: white; font-weight: bold; background: ${analysis.recommendation === 'Strong' ? '#27ae60' : analysis.recommendation === 'Good' ? '#3498db' : analysis.recommendation === 'Average' ? '#f39c12' : '#e74c3c'}">
              ${analysis.recommendation}
            </span>
          </div>
          
          <div style="display: flex; justify-content: space-between; margin: 10px 0;">
            <strong>Experience:</strong> <span>${analysis.experience_years} years</span>
          </div>
          <div style="display: flex; justify-content: space-between; margin: 10px 0;">
            <strong>Education:</strong> <span>${analysis.education_level}</span>
          </div>
          <div style="display: flex; justify-content: space-between; margin: 10px 0;">
            <strong>CV Quality:</strong> <span>${analysis.cv_quality}</span>
          </div>
        </div>

        <div style="background: #fff; border: 1px solid #ddd; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h3 style="color: #2c3e50;">📋 Application Details</h3>
          <p><strong>Position:</strong> ${jobTitle}</p>
          <p><strong>Applicant Email:</strong> <a href="mailto:${applicantEmail}">${applicantEmail}</a></p>
          <p><strong>Applied via:</strong> SmartCVNaija</p>
        </div>

        ${analysis.key_skills && analysis.key_skills.length > 0 ? `
        <div style="background: #e8f5e8; border: 1px solid #27ae60; padding: 15px; border-radius: 8px; margin: 20px 0;">
          <h4 style="color: #27ae60; margin-top: 0;">🛠️ Key Skills</h4>
          <p>${analysis.key_skills.join(' • ')}</p>
        </div>
        ` : ''}

        ${analysis.relevant_skills && analysis.relevant_skills.length > 0 ? `
        <div style="background: #e3f2fd; border: 1px solid #2196f3; padding: 15px; border-radius: 8px; margin: 20px 0;">
          <h4 style="color: #2196f3; margin-top: 0;">🎯 Job-Relevant Skills</h4>
          <p>${analysis.relevant_skills.join(' • ')}</p>
        </div>
        ` : ''}

        ${analysis.strengths && analysis.strengths.length > 0 ? `
        <div style="background: #e8f5e8; border: 1px solid #27ae60; padding: 15px; border-radius: 8px; margin: 20px 0;">
          <h4 style="color: #27ae60; margin-top: 0;">💪 Key Strengths</h4>
          <ul style="margin: 0; padding-left: 20px;">
            ${analysis.strengths.map(strength => `<li>${strength}</li>`).join('')}
          </ul>
        </div>
        ` : ''}

        ${analysis.areas_for_improvement && analysis.areas_for_improvement.length > 0 ? `
        <div style="background: #fff3e0; border: 1px solid #ff9800; padding: 15px; border-radius: 8px; margin: 20px 0;">
          <h4 style="color: #ff9800; margin-top: 0;">📈 Areas for Discussion</h4>
          <ul style="margin: 0; padding-left: 20px;">
            ${analysis.areas_for_improvement.map(area => `<li>${area}</li>`).join('')}
          </ul>
        </div>
        ` : ''}

        <div style="background: #fff; border: 1px solid #ddd; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h4 style="color: #2c3e50;">💼 Cover Letter</h4>
          <p style="line-height: 1.6; color: #555;">${coverLetter.replace(/\n/g, '<br>')}</p>
        </div>

        <div style="background: #f1f2f6; padding: 15px; border-radius: 8px; margin: 20px 0;">
          <h4 style="color: #2c3e50;">📎 Attachments</h4>
          <p>${cvBuffer ? '✅ CV attached to this email' : '❌ CV file not available - contact applicant directly'}</p>
        </div>

        <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">
        
        <div style="text-align: center; color: #7f8c8d; font-size: 14px;">
          <p>This application was intelligently processed by <a href="https://smartcvnaija.com.ng" style="color: #3498db;">SmartCVNaija</a></p>
          <p>For support, contact: <a href="mailto:hr@smartcvnaija.com.ng">hr@smartcvnaija.com.ng</a></p>
        </div>
      </div>
    `;

    // Send email with enhanced subject line (no salary)
    const emailOptions = {
      from: 'SmartCVNaija <hr@smartcvnaija.com.ng>',
      to: recruiterEmail,
      subject: `New Application: ${jobTitle} | CV Score: ${analysis.overall_score}/100 | Match: ${analysis.job_match_score}/100 | ${analysis.recommendation}`,
      html: emailHTML
    };

    if (cvBuffer) {
      emailOptions.attachments = [
        {
          filename: `CV_${applicantEmail.split('@')[0]}.pdf`,
          content: cvBuffer,
          contentType: 'application/pdf'
        }
      ];
    }

    await transporter.sendMail(emailOptions);
    
    logger.info('Enhanced email sent to recruiter with CV score', { 
      recruiterEmail, 
      jobTitle,
      overallScore: analysis.overall_score,
      jobMatchScore: analysis.job_match_score,
      recommendation: analysis.recommendation
    });

  } catch (error) {
    logger.error('Failed to send enhanced recruiter email', { 
      recruiterEmail, 
      jobTitle,
      error: error.message 
    });
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
        ORDER BY COALESCE(last_updated, scraped_at, NOW()) DESC
        LIMIT 10`;
        
      const { rows } = await dbManager.query(query, [
        title ? `%${title}%` : null,
        location ? `%${location}%` : null,
        company ? `%${company}%` : null,
        typeof remote === 'boolean' ? remote : null
      ]);

      if (rows.length === 0) {
        return this.sendMessage(identifier, 
          `🔍 **No Jobs Found**\n\nTry different search terms:\n• "developer jobs in Lagos"\n• "remote marketing jobs"\n• "manager positions"\n\n💡 **Tip:** Use broader terms for more results.`
        );
      }

      const response = `🎯 **Found ${rows.length} Job${rows.length > 1 ? 's' : ''}:**\n\n${rows.map((job, i) => 
        `**${i + 1}.** ${job.title}\n🏢 ${job.company}\n📍 ${job.location}${job.is_remote ? ' (Remote)' : ''}\n`
      ).join('\n')}\n💬 **Apply Now:**\n• "apply all" - Apply to all jobs\n• "apply 1,3,5" - Apply to specific jobs\n• Upload CV first if needed`;

      await redis.set(`last_jobs:${identifier}`, JSON.stringify(rows), 'EX', 3600);
      await redis.set(cacheKey, JSON.stringify({ response, rows }), 'EX', 3600);
      
      return this.sendMessage(identifier, response);

    } catch (error) {
      logger.error('Job search error', { identifier, filters, error: error.message });
      return this.sendMessage(identifier, 
        '❌ Job search failed. Please try again or contact support.'
      );
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
