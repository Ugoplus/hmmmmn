// workers/application.js - FIXED VERSION WITH PDF ATTACHMENTS

const { Worker } = require('bullmq');
const { queueRedis } = require('../config/redis');
const redis = require('../config/redis');
const dbManager = require('../config/database');
const logger = require('../utils/logger');
const nodemailer = require('nodemailer');
const config = require('../config');
const openaiService = require('../services/openai');
const fs = require('fs');
const path = require('path');

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

// Application processing worker - FIXED FOR PDF ATTACHMENTS
const applicationWorker = new Worker('job-applications', async (job) => {
  const { identifier, file, jobs, applicationId } = job.data;
  
  try {
    logger.info('Starting application processing with PDF attachments', { 
      identifier: identifier.substring(0, 6) + '***',
      applicationId,
      jobCount: jobs.length 
    });

    // Step 1: Process CV and save PDF file (20%)
    await job.updateProgress(20);
    const { cvText, pdfFilePath, userInfo } = await processCVAndSaveFile(file, identifier);
    
    // Step 2: Generate cover letters for all jobs (40%)
    await job.updateProgress(40);
    const coverLetters = await generateCoverLettersForJobs(cvText, jobs);
    
    // Step 3: Create application records (60%)
    await job.updateProgress(60);
    const applicationRecords = await createApplicationRecords(identifier, jobs, cvText);
    
    // Step 4: Send emails with PDF attachments (80%)
    await job.updateProgress(80);
    const emailResults = await sendProfessionalEmails(identifier, jobs, pdfFilePath, coverLetters, applicationRecords, userInfo);
    
    // Step 5: Clean up and notify user only if needed (100%)
    await job.updateProgress(100);
    await cleanupAndNotifyUser(identifier, jobs, emailResults, pdfFilePath);

    logger.info('Application processing completed with PDF attachments', {
      identifier: identifier.substring(0, 6) + '***',
      applicationId,
      jobCount: jobs.length,
      emailsSent: emailResults.successful.length,
      emailsFailed: emailResults.failed.length
    });

    return {
      success: true,
      applicationsProcessed: jobs.length,
      emailsSent: emailResults.successful.length,
      emailsFailed: emailResults.failed.length,
      applicationRecords: applicationRecords
    };

  } catch (error) {
    logger.error('Application processing failed', { 
      identifier: identifier.substring(0, 6) + '***',
      applicationId,
      error: error.message 
    });
    
    // Notify user of major system failure (after delay)
    setTimeout(async () => {
      try {
        const ycloud = require('../services/ycloud');
        await ycloud.sendTextMessage(identifier,
          `⚠️ **System Issue**\n\nThere was a technical problem processing your applications. Our team has been notified.\n\n💡 **You can try again or contact support if this continues.**`
        );
      } catch (notificationError) {
        logger.error('Failed to send error notification', { error: notificationError.message });
      }
    }, 600000); // 10 minute delay
    
    throw error;
  }
}, { 
  connection: queueRedis,
  concurrency: 5,
  settings: {
    retryProcessDelay: 10000,
    maxStalledCount: 2,
    stalledInterval: 60000
  },
  removeOnComplete: 30,
  removeOnFail: 15
});

// ================================
// STEP 1: PROCESS CV AND SAVE PDF FILE
// ================================

async function processCVAndSaveFile(file, identifier) {
  try {
    // Extract text for AI processing (same as before)
    const { Worker: CVWorker } = require('bullmq');
    const cvQueue = new (require('bullmq').Queue)('cv-processing', { connection: queueRedis });
    
    const cvJob = await cvQueue.add('process-cv', {
      file: file,
      identifier: 'background_process',
      priority: 'high'
    });
    
    const result = await cvJob.waitUntilFinished(cvQueue, 60000);
    
    if (!result || !result.text) {
      throw new Error('CV processing failed to return text');
    }

    // Save PDF file for email attachment
    const timestamp = Date.now();
    const safeIdentifier = identifier.replace(/[^a-zA-Z0-9]/g, '_');
    const originalExtension = path.extname(file.originalname) || '.pdf';
    const pdfFileName = `cv_${safeIdentifier}_${timestamp}${originalExtension}`;
    const pdfFilePath = path.join('./uploads', pdfFileName);

    // Ensure uploads directory exists
    if (!fs.existsSync('./uploads')) {
      fs.mkdirSync('./uploads', { recursive: true });
    }

    // Save the original PDF file
    fs.writeFileSync(pdfFilePath, file.buffer);
    
    logger.info('PDF file saved for email attachment', { 
      identifier: identifier.substring(0, 6) + '***',
      filePath: pdfFilePath,
      fileSize: file.buffer.length 
    });

    // Extract user information from CV or use defaults
    const userInfo = extractUserInfo(result.text, identifier);

    return {
      cvText: result.text,
      pdfFilePath: pdfFilePath,
      userInfo: userInfo
    };
    
  } catch (error) {
    logger.error('CV processing for application failed', { error: error.message });
    throw new Error('Failed to process CV: ' + error.message);
  }
}

// Extract user info from CV text
function extractUserInfo(cvText, identifier) {
  try {
    // Try to extract name and contact info from CV
    const nameMatch = cvText.match(/(?:name|Name)[:\s]*([A-Za-z\s]{2,30})/i);
    const emailMatch = cvText.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    const phoneMatch = cvText.match(/(?:\+234|234|0)[\d\s-]{10,14}/);

    return {
      name: nameMatch ? nameMatch[1].trim() : 'Job Applicant',
      email: emailMatch ? emailMatch[1] : `applicant.${identifier}@smartcvnaija.com`,
      phone: phoneMatch ? phoneMatch[0].trim() : null
    };
  } catch (error) {
    logger.warn('Failed to extract user info from CV', { error: error.message });
    return {
      name: 'Job Applicant',
      email: `applicant.${identifier}@smartcvnaija.com`,
      phone: null
    };
  }
}

// ================================
// STEP 2: GENERATE COVER LETTERS (SAME AS BEFORE)
// ================================

async function generateCoverLettersForJobs(cvText, jobs) {
  try {
    const coverLetters = {};
    
    // Generate a default cover letter first
    const defaultCoverLetter = await generateDefaultCoverLetter(cvText);
    coverLetters.default = defaultCoverLetter;
    
    // Generate personalized cover letters for each job (in batches)
    const batchSize = 3;
    for (let i = 0; i < jobs.length; i += batchSize) {
      const batch = jobs.slice(i, i + batchSize);
      
      await Promise.all(
        batch.map(async (job) => {
          try {
            const personalizedLetter = await openaiService.generateCoverLetter(cvText, job.title, job.company);
            coverLetters[job.id] = personalizedLetter;
          } catch (error) {
            logger.warn('Failed to generate personalized cover letter, using default', { 
              jobId: job.id, 
              error: error.message 
            });
            coverLetters[job.id] = defaultCoverLetter;
          }
        })
      );
      
      // Small delay between batches
      if (i + batchSize < jobs.length) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    return coverLetters;
    
  } catch (error) {
    logger.error('Cover letter generation failed', { error: error.message });
    return {
      default: generateBasicCoverLetter(),
      ...Object.fromEntries(jobs.map(job => [job.id, generateBasicCoverLetter()]))
    };
  }
}

async function generateDefaultCoverLetter(cvText) {
  try {
    return await openaiService.generateCoverLetter(cvText);
  } catch (error) {
    return generateBasicCoverLetter();
  }
}

function generateBasicCoverLetter() {
  return `Dear Hiring Manager,

I am writing to express my strong interest in this position at your company. My background and professional experience make me well-qualified for this role in Nigeria's competitive market.

I have developed strong skills that align with your requirements and am confident in my ability to contribute effectively to your team. I am eager to bring my expertise and enthusiasm to help drive your organization's continued success.

I would welcome the opportunity to discuss how my experience can benefit your team. Thank you for considering my application, and I look forward to hearing from you.

Best regards,
[Applicant Name]`;
}

// ================================
// STEP 3: CREATE APPLICATION RECORDS (SAME AS BEFORE)
// ================================

async function createApplicationRecords(identifier, jobs, cvText) {
  try {
    const applicationRecords = [];
    
    for (const job of jobs) {
      const applicationId = require('uuid').v4();
      
      // Basic CV score (can be enhanced with AI later)
      let cvScore = 75;
      try {
        const analysis = await openaiService.analyzeCV(cvText, job.title, identifier);
        cvScore = analysis.job_match_score || 75;
      } catch (error) {
        logger.warn('CV analysis failed, using default score', { jobId: job.id });
      }
      
      await dbManager.query(
        `INSERT INTO applications (id, user_identifier, job_id, cv_text, cv_score, status, applied_at) 
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [applicationId, identifier, job.id, cvText, cvScore, 'submitted']
      );
      
      applicationRecords.push({
        id: applicationId,
        jobId: job.id,
        jobTitle: job.title,
        company: job.company,
        cvScore: cvScore,
        status: 'submitted'
      });
    }
    
    return applicationRecords;
    
  } catch (error) {
    logger.error('Failed to create application records', { error: error.message });
    throw error;
  }
}

// ================================
// STEP 4: SEND PROFESSIONAL EMAILS WITH PDF ATTACHMENTS
// ================================

async function sendProfessionalEmails(identifier, jobs, pdfFilePath, coverLetters, applicationRecords, userInfo) {
  const results = {
    successful: [],
    failed: []
  };
  
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const applicationRecord = applicationRecords[i];
    
    try {
      // Skip if no recruiter email
      if (!job.email || job.email.trim() === '') {
        results.failed.push({
          jobId: job.id,
          jobTitle: job.title,
          company: job.company,
          reason: 'No recruiter email provided'
        });
        continue;
      }
      
      const coverLetter = coverLetters[job.id] || coverLetters.default;
      
      // Prepare email with PDF attachment
      const emailOptions = {
        from: `"${userInfo.name} via SmartCVNaija" <${config.get('SMTP_USER')}>`,
        to: job.email,
        replyTo: userInfo.email,
        subject: `Application for ${job.title} Position - ${userInfo.name}`,
        html: generateProfessionalEmailHTML(job, coverLetter, userInfo, applicationRecord.id),
        text: generateProfessionalEmailText(job, coverLetter, userInfo, applicationRecord.id),
        attachments: [
          {
            filename: `${userInfo.name.replace(/\s+/g, '_')}_CV.pdf`,
            path: pdfFilePath,
            contentType: 'application/pdf'
          }
        ]
      };
      
      // Send email
      await transporter.sendMail(emailOptions);
      
      // Update application status
      await dbManager.query(
        'UPDATE applications SET status = $1, email_sent_at = NOW() WHERE id = $2',
        ['email_sent', applicationRecord.id]
      );
      
      results.successful.push({
        jobId: job.id,
        jobTitle: job.title,
        company: job.company,
        recruiterEmail: job.email,
        applicationId: applicationRecord.id
      });
      
      logger.info('Professional email sent with PDF attachment', { 
        jobId: job.id, 
        company: job.company,
        recruiterEmail: job.email,
        applicationId: applicationRecord.id,
        attachmentPath: pdfFilePath
      });
      
      // Delay between emails (professional spacing)
      if (i < jobs.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 30000)); // 30 second delay
      }
      
    } catch (error) {
      logger.error('Failed to send professional email', { 
        jobId: job.id, 
        recruiterEmail: job.email,
        error: error.message 
      });
      
      results.failed.push({
        jobId: job.id,
        jobTitle: job.title,
        company: job.company,
        recruiterEmail: job.email,
        reason: error.message
      });
      
      // Update application status as failed
      try {
        await dbManager.query(
          'UPDATE applications SET status = $1, error_message = $2 WHERE id = $3',
          ['email_failed', error.message, applicationRecord.id]
        );
      } catch (updateError) {
        logger.error('Failed to update application status', { 
          applicationId: applicationRecord.id, 
          error: updateError.message 
        });
      }
    }
  }
  
  return results;
}

// ================================
// PROFESSIONAL EMAIL TEMPLATES
// ================================

function generateProfessionalEmailHTML(job, coverLetter, userInfo, applicationId) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>Job Application - ${job.title}</title>
        <style>
            body { 
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
                line-height: 1.6; 
                color: #333; 
                max-width: 600px; 
                margin: 0 auto; 
                padding: 20px; 
                background-color: #f9f9f9;
            }
            .email-container {
                background: white;
                border-radius: 8px;
                padding: 30px;
                box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            }
            .header { 
                border-bottom: 3px solid #2c3e50; 
                padding-bottom: 20px; 
                margin-bottom: 25px; 
            }
            .header h1 {
                color: #2c3e50;
                margin: 0;
                font-size: 24px;
            }
            .job-details { 
                background: #f8f9fa; 
                padding: 15px; 
                border-radius: 5px; 
                margin: 20px 0;
                border-left: 4px solid #3498db;
            }
            .cover-letter {
                margin: 25px 0;
                line-height: 1.8;
            }
            .footer { 
                border-top: 1px solid #eee; 
                padding-top: 20px; 
                margin-top: 30px; 
                color: #666; 
                font-size: 0.9em; 
                text-align: center;
            }
            .contact-info {
                background: #e8f6f3;
                padding: 15px;
                border-radius: 5px;
                margin: 20px 0;
            }
            .attachment-note {
                background: #fff3cd;
                border: 1px solid #ffeeba;
                color: #856404;
                padding: 10px;
                border-radius: 5px;
                margin: 20px 0;
            }
        </style>
    </head>
    <body>
        <div class="email-container">
            <div class="header">
                <h1>Job Application</h1>
            </div>
            
            <div class="job-details">
                <h3 style="margin-top: 0; color: #2c3e50;">Position: ${job.title}</h3>
                <p><strong>Company:</strong> ${job.company}</p>
                <p><strong>Location:</strong> ${job.location}</p>
                ${job.salary ? `<p><strong>Salary:</strong> ${job.salary}</p>` : ''}
            </div>
            
            <div class="contact-info">
                <h3 style="margin-top: 0; color: #2c3e50;">Applicant Information</h3>
                <p><strong>Name:</strong> ${userInfo.name}</p>
                <p><strong>Email:</strong> ${userInfo.email}</p>
                ${userInfo.phone ? `<p><strong>Phone:</strong> ${userInfo.phone}</p>` : ''}
            </div>
            
            <div class="attachment-note">
                <strong>📎 CV/Resume:</strong> Please find the complete CV attached as a PDF file.
            </div>
            
            <div class="cover-letter">
                <h3 style="color: #2c3e50;">Cover Letter</h3>
                <div style="white-space: pre-line;">${coverLetter.replace(userInfo.name ? '[Applicant Name]' : /\[Your Name\]/g, userInfo.name)}</div>
            </div>
            
            <div style="text-align: center; margin: 30px 0; padding: 20px; background: #f8f9fa; border-radius: 5px;">
                <p style="margin: 0;"><strong>Best regards,</strong></p>
                <p style="margin: 5px 0 0 0; color: #2c3e50; font-size: 1.1em;"><strong>${userInfo.name}</strong></p>
                <p style="margin: 5px 0 0 0; color: #666;">${userInfo.email}</p>
                ${userInfo.phone ? `<p style="margin: 5px 0 0 0; color: #666;">${userInfo.phone}</p>` : ''}
            </div>
            
            <div class="footer">
                <p>This application was submitted through <strong>SmartCVNaija</strong> - Nigeria's professional job application platform.</p>
                <p style="font-size: 0.8em; color: #999;">Application ID: ${applicationId}</p>
            </div>
        </div>
    </body>
    </html>
  `;
}

function generateProfessionalEmailText(job, coverLetter, userInfo, applicationId) {
  return `
Job Application - ${job.title}

Position: ${job.title}
Company: ${job.company}
Location: ${job.location}
${job.salary ? `Salary: ${job.salary}` : ''}

Applicant Information:
Name: ${userInfo.name}
Email: ${userInfo.email}
${userInfo.phone ? `Phone: ${userInfo.phone}` : ''}

CV/Resume: Please find the complete CV attached as a PDF file.

Cover Letter:
${coverLetter.replace(userInfo.name ? '[Applicant Name]' : /\[Your Name\]/g, userInfo.name)}

Best regards,
${userInfo.name}
${userInfo.email}
${userInfo.phone || ''}

---
This application was submitted through SmartCVNaija - Nigeria's professional job application platform.
Application ID: ${applicationId}
  `;
}

// ================================
// STEP 5: CLEANUP AND USER NOTIFICATION
// ================================

async function cleanupAndNotifyUser(identifier, jobs, emailResults, pdfFilePath) {
  try {
    // Clean up PDF file after sending (optional - you might want to keep for records)
    setTimeout(() => {
      try {
        if (fs.existsSync(pdfFilePath)) {
          fs.unlinkSync(pdfFilePath);
          logger.info('PDF file cleaned up after email sending', { pdfFilePath });
        }
      } catch (cleanupError) {
        logger.warn('Failed to cleanup PDF file', { pdfFilePath, error: cleanupError.message });
      }
    }, 300000); // Delete after 5 minutes
    
    // Only notify user about failures (with delay)
    const failedApplications = emailResults.failed;
    
    if (failedApplications.length > 0) {
      setTimeout(async () => {
        try {
          const ycloud = require('../services/ycloud');
          
          let message = `⚠️ **Application Update**\n\n`;
          
          if (failedApplications.length === 1) {
            const failed = failedApplications[0];
            message += `Could not send application to **${failed.company}** for **${failed.jobTitle}**\n\n`;
            message += `💡 **You can apply manually if interested**\n\n`;
          } else {
            message += `${failedApplications.length} applications could not be sent:\n\n`;
            failedApplications.slice(0, 3).forEach((failed, index) => {
              message += `${index + 1}. ${failed.jobTitle} - ${failed.company}\n`;
            });
            if (failedApplications.length > 3) {
              message += `...and ${failedApplications.length - 3} more\n\n`;
            }
            message += `💡 **You can apply to these manually if interested**\n\n`;
          }
          
          message += `🔍 **All other applications were sent successfully!**`;
          
          await ycloud.sendTextMessage(identifier, message);
          
        } catch (notificationError) {
          logger.error('Failed to send failure notification', { error: notificationError.message });
        }
      }, 1800000); // Send after 30 minutes
    }
    
    // Log successful completion (for admin monitoring)
    logger.info('Applications processed with PDF attachments', {
      identifier: identifier.substring(0, 6) + '***',
      totalJobs: jobs.length,
      successful: emailResults.successful.length,
      failed: failedApplications.length,
      successfulCompanies: emailResults.successful.map(s => s.company)
    });
    
  } catch (error) {
    logger.error('Failed cleanup and notification', { error: error.message });
  }
}

// Event handlers
applicationWorker.on('completed', (job, result) => {
  logger.info('Application processing with PDF attachments completed', { 
    jobId: job.id,
    identifier: job.data.identifier?.substring(0, 6) + '***',
    applicationsProcessed: result.applicationsProcessed,
    emailsSent: result.emailsSent
  });
});

applicationWorker.on('failed', (job, error) => {
  logger.error('Application processing with PDF attachments failed', { 
    jobId: job.id,
    identifier: job.data?.identifier?.substring(0, 6) + '***',
    error: error.message 
  });
});

logger.info('🚀 Application processing worker started with PDF attachment capabilities');

module.exports = applicationWorker;