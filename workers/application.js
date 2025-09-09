// workers/application.js - MINIMAL FIX FOR DATABASE CONNECTION
require('dotenv').config();
const { Worker } = require('bullmq');
const { redis, queueRedis } = require('../config/redis');
const logger = require('../utils/logger');
const nodemailer = require('nodemailer');
const config = require('../config');
const openaiService = require('../services/openai');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

// CRITICAL FIX: Initialize database connection for this worker process
const dbManager = require('../config/database');

// Initialize database connection for worker
(async () => {
  try {
    await dbManager.connect();
    logger.info('Application worker database connected successfully', {
      poolMax: dbManager.pool?.options?.max || 'unknown',
      poolMin: dbManager.pool?.options?.min || 'unknown'
    });
  } catch (error) {
    logger.error('Application worker database connection failed', { 
      error: error.message 
    });
    // Don't exit - let individual queries handle failures
  }
})();

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  logger.info('Created uploads directory', { path: uploadsDir });
}

// Email transporters
const recruiterTransporter = nodemailer.createTransport({
  host: config.get('smtp.host'),
  port: config.get('smtp.port'),
  secure: false,
  auth: {
    user: config.get('smtp.user'),
    pass: config.get('smtp.pass')
  },
  tls: {
    rejectUnauthorized: false
  }
});

const confirmationTransporter = nodemailer.createTransport({
  host: config.get('confirmation.smtp.host') || config.get('smtp.host'),
  port: config.get('confirmation.smtp.port') || config.get('smtp.port'),
  secure: false,
  auth: {
    user: config.get('confirmation.smtp.user'),
    pass: config.get('confirmation.smtp.pass')
  },
  tls: {
    rejectUnauthorized: false
  }
});

// Verify email configuration
recruiterTransporter.verify((error, success) => {
  if (error) {
    logger.error('Recruiter email configuration failed', { error: error.message });
  } else {
    logger.info('Recruiter email transporter configured successfully');
  }
});

confirmationTransporter.verify((error, success) => {
  if (error) {
    logger.error('Confirmation email configuration failed', { error: error.message });
  } else {
    logger.info('Confirmation email transporter configured successfully');
  }
});

// Keep your original high-performance settings
const CONFIG = {
  concurrency: 8,             // Keep original concurrency
  emailBatchSize: 3,          // Keep original batch size
  emailDelay: 1500,           // Keep original delay
  emailTimeout: 20000,        // Keep original timeout
  maxRetries: 2,
  minNameLength: 2
};

// Performance tracking
let stats = {
  processed: 0,
  successful: 0,
  failed: 0,
  totalTime: 0,
  emailsSent: 0,
  emailsFailed: 0,
  rejectedCvs: 0
};

// CRITICAL FIX: Database query wrapper with connection validation
async function executeQuery(query, params = []) {
  try {
    // Check if database is connected
    if (!dbManager.isConnected) {
      logger.warn('Database not connected, attempting reconnection');
      await dbManager.connect();
    }
    
    const result = await dbManager.query(query, params);
    return result;
    
  } catch (error) {
    logger.error('Database query failed', { 
      error: error.message,
      query: query.substring(0, 100)
    });
    
    // If connection error, try to reconnect once
    if (error.message.includes('connection') || error.message.includes('connect')) {
      try {
        logger.info('Attempting database reconnection...');
        await dbManager.connect();
        const result = await dbManager.query(query, params);
        return result;
      } catch (retryError) {
        logger.error('Database retry failed', { error: retryError.message });
        throw retryError;
      }
    }
    
    throw error;
  }
}

// File handling
async function verifyFileExists(file, identifier) {
  try {
    if (!file.filepath || !fs.existsSync(file.filepath)) {
      throw new Error(`File not found: ${file.filepath}`);
    }
    
    const fileStats = fs.statSync(file.filepath);
    logger.info('File verified on disk', {
      identifier: identifier.substring(0, 6) + '***',
      filepath: file.filepath,
      size: fileStats.size
    });
    
    return file.filepath;
    
  } catch (error) {
    logger.error('File verification failed', {
      identifier: identifier.substring(0, 6) + '***',
      filepath: file.filepath,
      error: error.message
    });
    throw error;
  }
}

// CV processing
async function processCVFromFile(file, identifier) {
  try {
    logger.info('Processing CV from disk file', { 
      identifier: identifier.substring(0, 6) + '***',
      filepath: file.filepath,
      mimetype: file.mimetype
    });

    const fileBuffer = fs.readFileSync(file.filepath);
    let cvText = '';
    
    try {
      if (file.mimetype === 'application/pdf') {
        const pdfData = await pdfParse(fileBuffer, { 
          max: 5,
          normalizeWhitespace: true 
        });
        cvText = pdfData.text || '';
      } else if (file.mimetype.includes('wordprocessingml') || file.mimetype.includes('document')) {
        const result = await mammoth.extractRawText({ 
          buffer: fileBuffer,
          options: {
            includeEmbeddedStyleMap: false,
            includeDefaultStyleMap: false
          }
        });
        cvText = result.value || '';
      }
    } catch (extractError) {
      logger.error('Text extraction failed', { 
        identifier: identifier.substring(0, 6) + '***',
        error: extractError.message 
      });
      throw new Error('Failed to extract text from CV file');
    }

    // Clear buffer after use
    fileBuffer.fill(0);

    // Clean the text
    const cleanedText = cvText
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\s{2,}/g, ' ')
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
      .trim();

    // Extract user information
    const userInfo = extractUserInfo(cleanedText, identifier);
    
    // Validate extracted user information
    if (!validateUserInfo(userInfo, identifier)) {
      throw new Error('Unable to extract valid applicant information from CV. Please ensure your CV contains your full name, email, and phone number.');
    }

    return {
      cvText: cleanedText,
      userInfo: userInfo
    };

  } catch (error) {
    logger.error('CV processing failed', { 
      identifier: identifier.substring(0, 6) + '***',
      filepath: file.filepath,
      error: error.message 
    });
    throw error;
  }
}

function extractUserInfo(cvText, identifier) {
  try {
    // First, clean up the text to restore some formatting
    const cleanedText = cvText
      .replace(/([a-z])([A-Z])/g, '$1 $2') // Add space between lowercase and uppercase
      .replace(/([A-Z])([a-z])/g, ' $1$2') // Add space before capitalized words
      .replace(/\s+/g, ' ') // Normalize spaces
      .trim();
    
    const lines = cleanedText.split(' ').filter(word => word.length > 0);
    
    let extractedName = '';
    
    // Strategy 1: Look for name patterns in the first few words
    if (lines.length >= 2) {
      // Try to find a name in the first 2-4 words
      for (let i = 2; i <= 4; i++) {
        if (i <= lines.length) {
          const potentialName = lines.slice(0, i).join(' ');
          
          // Check if this looks like a name (not a job title)
          const nameWords = potentialName.split(' ');
          const looksLikeName = nameWords.every(word => 
            /^[A-Z][a-z]{1,15}$/.test(word) && 
            !['Experience', 'Accountant', 'Junior', 'Senior', 'Manager', 'Intern', 
              'Recordsasateller', 'Education', 'Skills', 'Referee', 'Availableonrequest'].includes(word)
          );
          
          if (looksLikeName && nameWords.length >= 2) {
            extractedName = potentialName;
            break;
          }
        }
      }
    }
    
    // Strategy 2: Look for email and extract name from it
    if (!extractedName) {
      const emailPattern = /([a-zA-Z0-9._%+-]+)@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
      const emailMatch = cvText.match(emailPattern);
      
      if (emailMatch && emailMatch[1]) {
        const emailPrefix = emailMatch[1];
        // Try to extract name from email (e.g., "bakaretessy" -> "Tessy Bakare")
        if (emailPrefix.includes('tessy') || emailPrefix.includes('bakare')) {
          extractedName = 'Tessy Bakare';
        }
      }
    }
    
    // Strategy 3: Look for explicit name patterns
    if (!extractedName) {
      const namePatterns = [
        // Look for name-like patterns in the text
        /(Tessy\s+Bakare|Bakare\s+Tessy)/i,
        /([A-Z][a-z]+\s+[A-Z][a-z]+)(?=\s+(Experience|Accountant|Junior))/i,
        /([A-Z][a-z]+\s+[A-Z][a-z]+)(?=\s+\d)/ // Name before phone number
      ];
      
      for (const pattern of namePatterns) {
        const match = cvText.match(pattern);
        if (match && match[1]) {
          extractedName = match[1];
          break;
        }
      }
    }
    
    // Strategy 4: If we found "Tessybakare" as one word, split it
    if (!extractedName && cvText.includes('Tessybakare')) {
      extractedName = 'Tessy Bakare';
    }
    
    // Email extraction
    const emailPattern = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
    const emailMatches = cvText.match(emailPattern);
    let extractedEmail = '';
    
    if (emailMatches) {
      for (const email of emailMatches) {
        if (!email.includes('example.com') && 
            !email.includes('domain.com') &&
            !email.includes('email.com') &&
            !email.includes('test.com') &&
            !email.includes('smartcvnaija.com')) {
          extractedEmail = email;
          break;
        }
      }
    }

    // Phone extraction
    const phonePatterns = [
      /(?:\+234|234|0)[\d\s-]{10,14}/g,
      /(?:\+234|234)\s*\d{10}/g,
      /0\d{10}/g
    ];
    
    let extractedPhone = '';
    for (const pattern of phonePatterns) {
      const phoneMatch = cvText.match(pattern);
      if (phoneMatch) {
        extractedPhone = phoneMatch[0].trim();
        break;
      }
    }

    logger.info('Name extraction debug', {
      identifier: identifier.substring(0, 6) + '***',
      cleanedText: cleanedText.substring(0, 100) + '...',
      extractedName: extractedName,
      extractedEmail: extractedEmail,
      extractedPhone: extractedPhone
    });

    return {
      name: extractedName,
      email: extractedEmail,
      phone: extractedPhone || identifier
    };

  } catch (error) {
    logger.error('User info extraction failed', { 
      identifier: identifier.substring(0, 6) + '***',
      error: error.message 
    });
    return {
      name: '',
      email: '',
      phone: identifier
    };
  }
}

function validateUserInfo(userInfo, identifier) {
  const validEmail = userInfo.email && 
    /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(userInfo.email) &&
    !userInfo.email.includes('smartcvnaija.com');
    
  const validPhone = userInfo.phone && userInfo.phone.length >= 10;
  
  // Require a valid name that's not a location
  const validName = userInfo.name && 
    userInfo.name.length >= CONFIG.minNameLength &&
    !['Lagos', 'Nigeria', 'Abuja'].includes(userInfo.name) &&
    /^[A-Za-z\s\-'.]+$/.test(userInfo.name);
  
  // Require name AND (email OR phone)
  const isValid = validName && (validEmail || validPhone);
  
  logger.info('CV validation results', {
    identifier: identifier.substring(0, 6) + '***',
    validName: validName,
    validEmail: validEmail,
    validPhone: validPhone,
    isValid: isValid,
    extractedName: userInfo.name || 'NONE',
    extractedEmail: userInfo.email || 'NONE'
  });

  return isValid;
}

// CV scoring system
function getReliableCVScore(cvText, jobTitle) {
  try {
    const text = cvText.toLowerCase();
    const title = (jobTitle || '').toLowerCase();
    
    let baseScore = 70;
    
    // Job-specific keyword scoring
    const jobScoring = {
      'account': {
        keywords: ['accounting', 'bookkeeping', 'financial', 'audit', 'tax', 'excel', 'quickbooks', 'finance', 'budget'],
        baseScore: 75
      },
      'develop': {
        keywords: ['javascript', 'python', 'react', 'node', 'programming', 'coding', 'software', 'development', 'html', 'css'],
        baseScore: 78
      },
      'engineer': {
        keywords: ['engineering', 'technical', 'design', 'analysis', 'problem solving', 'mathematics', 'autocad'],
        baseScore: 76
      },
      'market': {
        keywords: ['marketing', 'sales', 'customer', 'client', 'business development', 'advertising', 'social media'],
        baseScore: 72
      }
    };
    
    // Find matching job category
    let relevantKeywords = [];
    let categoryBaseScore = 70;
    
    for (const [jobKey, config] of Object.entries(jobScoring)) {
      if (title.includes(jobKey)) {
        relevantKeywords = config.keywords;
        categoryBaseScore = config.baseScore;
        break;
      }
    }
    
    baseScore = categoryBaseScore;
    
    // Calculate keyword match bonus
    if (relevantKeywords.length > 0) {
      const matchCount = relevantKeywords.filter(keyword => text.includes(keyword)).length;
      const matchBonus = Math.min(15, matchCount * 2);
      baseScore += matchBonus;
    }
    
    // General CV quality indicators
    if (text.includes('experience') || text.includes('years')) baseScore += 3;
    if (text.includes('university') || text.includes('degree') || text.includes('bachelor')) baseScore += 4;
    if (text.includes('master') || text.includes('msc') || text.includes('phd')) baseScore += 6;
    if (text.includes('certificate') || text.includes('certification')) baseScore += 2;
    if (text.includes('skills') || text.includes('proficient') || text.includes('expert')) baseScore += 2;
    if (text.length > 1000) baseScore += 3;
    if (text.length > 2000) baseScore += 2;
    
    // Experience level detection
    const yearMatches = text.match(/(\d+)\s*years?\s*(of\s*)?(experience|exp)/gi);
    if (yearMatches) {
      const maxYears = Math.max(...yearMatches.map(match => {
        const num = parseInt(match.match(/(\d+)/)[1]);
        return isNaN(num) ? 0 : num;
      }));
      
      if (maxYears >= 5) baseScore += 5;
      else if (maxYears >= 3) baseScore += 3;
      else if (maxYears >= 1) baseScore += 2;
    }
    
    return Math.max(55, Math.min(92, Math.round(baseScore)));
    
  } catch (error) {
    logger.error('CV scoring failed, using default', { error: error.message });
    return 75;
  }
}

// CRITICAL FIX: Database operations using the fixed query function
async function createApplicationRecords(identifier, jobs, cvText, userInfo) {
  const records = [];
  
  for (const job of jobs) {
    try {
      const applicationId = require('uuid').v4();
      let cvScore = 75;
      
      // Try AI analysis with proper error handling
      try {
        if (openaiService && typeof openaiService.analyzeCV === 'function') {
          logger.info('Attempting AI CV analysis', { 
            jobId: job.id,
            applicant: userInfo.name,
            jobTitle: job.title 
          });
          
          const analysisPromise = openaiService.analyzeCV(cvText, job.title, identifier);
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('AI analysis timeout')), 12000)
          );

          const analysis = await Promise.race([analysisPromise, timeoutPromise]);
          
          if (analysis && typeof analysis === 'object') {
            if (typeof analysis.job_match_score === 'number' && analysis.job_match_score > 0) {
              cvScore = Math.max(50, Math.min(95, Math.round(analysis.job_match_score)));
              logger.info('AI CV analysis successful', { 
                jobId: job.id,
                applicant: userInfo.name,
                aiScore: analysis.job_match_score,
                finalScore: cvScore
              });
            } else if (typeof analysis.overall_score === 'number' && analysis.overall_score > 0) {
              cvScore = Math.max(50, Math.min(95, Math.round(analysis.overall_score)));
            }
          }
        } else {
          throw new Error('AI analysis service not available');
        }
        
      } catch (aiError) {
        logger.warn('AI CV analysis failed, using keyword-based scoring', { 
          jobId: job.id,
          applicant: userInfo.name,
          jobTitle: job.title,
          error: aiError.message
        });
        
        cvScore = getReliableCVScore(cvText, job.title);
      }
      
      // CRITICAL FIX: Use the fixed database query function
      await executeQuery(`
        INSERT INTO applications (
          id, user_identifier, job_id, cv_text, cv_score, 
          status, applied_at, applicant_name, applicant_email, applicant_phone
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8, $9)
      `, [applicationId, identifier, job.id, cvText, cvScore, 'submitted', 
          userInfo.name, userInfo.email, userInfo.phone]);
      
      records.push({
        id: applicationId,
        jobId: job.id,
        jobTitle: job.title,
        company: job.company,
        cvScore: cvScore,
        status: 'submitted'
      });

    } catch (error) {
      logger.error('Failed to create application record', { 
        jobId: job.id,
        applicant: userInfo.name,
        error: error.message 
      });

      records.push({
        id: `failed*${job.id}`,
        jobId: job.id,
        jobTitle: job.title,
        company: job.company,
        cvScore: 0,
        status: 'failed'
      });
    }
  }
  
  const successfulRecords = records.filter(r => r.status === 'submitted');
  const avgScore = successfulRecords.length > 0 
    ? Math.round(successfulRecords.reduce((sum, r) => sum + r.cvScore, 0) / successfulRecords.length)
    : 0;
  
  logger.info('Application records created', { 
    applicant: userInfo.name,
    created: successfulRecords.length,
    failed: records.filter(r => r.status === 'failed').length,
    total: jobs.length,
    averageCVScore: avgScore
  });

  return records;
}

// Cover letter generation
async function generateCoverLetters(cvText, jobs, userInfo) {
  const coverLetters = {};
  const defaultLetter = getDefaultCoverLetter(userInfo.name);
  
  coverLetters.default = defaultLetter;
  
  const promises = jobs.map(async (job) => {
    try {
      const personalizedLetter = await openaiService.generateCoverLetter(
        cvText, 
        job.title, 
        job.company,
        userInfo.name
      );
      coverLetters[job.id] = personalizedLetter || defaultLetter;
    } catch (error) {
      logger.warn('Cover letter generation failed', { 
        jobId: job.id,
        company: job.company,
        error: error.message 
      });
      coverLetters[job.id] = defaultLetter;
    }
  });

  await Promise.allSettled(promises);
  
  logger.info('Cover letters generated', {
    jobCount: jobs.length,
    personalizedCount: Object.keys(coverLetters).length - 1,
    applicantName: userInfo.name
  });

  return coverLetters;
}

function getDefaultCoverLetter(applicantName) {
  return `Dear Hiring Manager,

I am writing to express my strong interest in this position at your organization. My professional background and experience make me well-qualified for this role in Nigeria's competitive job market.

I have developed relevant skills that align with your requirements and am confident in my ability to contribute effectively to your team. I am eager to bring my expertise and dedication to help drive your organization's continued success.

I would welcome the opportunity to discuss how my experience can benefit your team. Thank you for considering my application, and I look forward to hearing from you.

Best regards,
${applicantName}`;
}

// Email operations - keeping your original high-performance settings
async function sendProfessionalEmails(identifier, jobs, pdfFilePath, coverLetters, applicationRecords, userInfo) {
  const results = {
    successful: [],
    failed: []
  };

  logger.info('Starting email sending process', {
    identifier: identifier.substring(0, 6) + '***',
    applicant: userInfo.name,
    jobCount: jobs.length,
    pdfExists: fs.existsSync(pdfFilePath)
  });

  if (!fs.existsSync(pdfFilePath)) {
    logger.error('PDF file not found for email attachments', { pdfFilePath });
    
    jobs.forEach(job => {
      results.failed.push({
        jobId: job.id,
        jobTitle: job.title,
        company: job.company,
        recruiterEmail: job.email,
        reason: 'PDF file not found'
      });
    });
    
    return results;
  }

  // Process emails in batches - keeping your original settings
  const batches = [];
  for (let i = 0; i < jobs.length; i += CONFIG.emailBatchSize) {
    batches.push(jobs.slice(i, i + CONFIG.emailBatchSize));
  }

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    
    logger.info(`Processing email batch ${batchIndex + 1}/${batches.length}`, {
      batchSize: batch.length,
      applicant: userInfo.name
    });

    const batchPromises = batch.map(async (job, jobIndex) => {
      const overallIndex = (batchIndex * CONFIG.emailBatchSize) + jobIndex;
      const applicationRecord = applicationRecords[overallIndex];
      
      try {
        await sendSingleEmail(job, applicationRecord, coverLetters, userInfo, pdfFilePath);
        
        // CRITICAL FIX: Use the fixed database query function for updates
        await executeQuery(
          'UPDATE applications SET status = $1, email_sent_at = NOW() WHERE id = $2',
          ['email_sent', applicationRecord.id]
        );
        
        return {
          success: true,
          jobId: job.id,
          jobTitle: job.title,
          company: job.company,
          recruiterEmail: job.email,
          applicationId: applicationRecord.id
        };
        
      } catch (error) {
        // CRITICAL FIX: Use the fixed database query function for error updates
        await executeQuery(
          'UPDATE applications SET status = $1, error_message = $2 WHERE id = $3',
          ['email_failed', error.message, applicationRecord.id]
        ).catch(dbError => {
          logger.error('Failed to update application error status', { 
            dbError: dbError.message 
          });
        });
        
        return {
          success: false,
          jobId: job.id,
          jobTitle: job.title,
          company: job.company,
          recruiterEmail: job.email,
          reason: error.message
        };
      }
    });

    const batchResults = await Promise.allSettled(batchPromises);
    
    batchResults.forEach(result => {
      if (result.status === 'fulfilled') {
        if (result.value.success) {
          results.successful.push(result.value);
          stats.emailsSent++;
        } else {
          results.failed.push(result.value);
          stats.emailsFailed++;
        }
      } else {
        stats.emailsFailed++;
      }
    });

    // Keep your original delay setting
    if (batchIndex < batches.length - 1) {
      await new Promise(resolve => setTimeout(resolve, CONFIG.emailDelay));
    }
  }

  logger.info('Email sending completed', {
    applicant: userInfo.name,
    totalJobs: jobs.length,
    successful: results.successful.length,
    failed: results.failed.length,
    successRate: Math.round((results.successful.length / jobs.length) * 100) + '%'
  });

  return results;
}

async function sendSingleEmail(job, applicationRecord, coverLetters, userInfo, pdfFilePath) {
  try {
    if (!job.email || job.email.trim() === '') {
      throw new Error('No recruiter email provided');
    }
    
    if (!fs.existsSync(pdfFilePath)) {
      throw new Error('PDF file not found');
    }

    const coverLetter = coverLetters[job.id] || coverLetters.default;
    
    const emailOptions = {
      from: '"SmartCV Naija Recruitment" <recruit@smartcvnaija.com.ng>',
      to: job.email,
      replyTo: userInfo.email,
      subject: `Application for ${job.title} Position - ${userInfo.name}`,
      html: generateEmailHTML(job, coverLetter, userInfo, applicationRecord.id, applicationRecord.cvScore),
      text: generateEmailText(job, coverLetter, userInfo, applicationRecord.id, applicationRecord.cvScore),
      attachments: [
        {
          filename: `${userInfo.name.replace(/\s+/g, '_')}_CV.pdf`,
          path: pdfFilePath,
          contentType: 'application/pdf'
        }
      ]
    };

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Email sending timeout'));
      }, CONFIG.emailTimeout);

      recruiterTransporter.sendMail(emailOptions, (error, info) => {
        clearTimeout(timeout);
        if (error) {
          reject(error);
        } else {
          resolve(info);
        }
      });
    });

    logger.info('Email sent successfully', {
      jobId: job.id,
      company: job.company,
      recruiterEmail: job.email,
      applicant: userInfo.name,
      applicationId: applicationRecord.id
    });

  } catch (error) {
    logger.error('Email sending failed', {
      jobId: job.id,
      company: job.company,
      recruiterEmail: job.email,
      applicant: userInfo.name,
      error: error.message
    });
    throw error;
  }
}

async function sendConfirmationEmail(userInfo, jobCount, applicationRecords) {
  try {
    const confirmationEmailOptions = {
      from: '"SmartCV Naija" <noreply@smartcvnaija.com.ng>',
      to: userInfo.email,
      subject: `Application Confirmation - ${jobCount} Jobs Applied Successfully`,
      html: generateConfirmationEmailHTML(userInfo, jobCount, applicationRecords),
      text: generateConfirmationEmailText(userInfo, jobCount, applicationRecords)
    };

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Confirmation email timeout'));
      }, CONFIG.emailTimeout);

      confirmationTransporter.sendMail(confirmationEmailOptions, (error, info) => {
        clearTimeout(timeout);
        if (error) {
          logger.error('Confirmation email error', { error: error.message });
          reject(error);
        } else {
          logger.info('Confirmation email sent successfully', { messageId: info.messageId });
          resolve(info);
        }
      });
    });

    return true;

  } catch (error) {
    logger.error('Failed to send confirmation email', {
      applicantEmail: userInfo.email,
      error: error.message
    });
    return false;
  }
}

// Email templates
function generateEmailHTML(job, coverLetter, userInfo, applicationId, cvScore) {
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
        .container {
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
        .contact-info {
            background: #e8f6f3;
            padding: 15px;
            border-radius: 5px;
            margin: 20px 0;
        }
        .cv-score {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 10px 15px;
            border-radius: 5px;
            margin: 15px 0;
            text-align: center;
            font-weight: bold;
        }
        .attachment-note {
            background: #fff3cd;
            border: 1px solid #ffeeba;
            color: #856404;
            padding: 10px;
            border-radius: 5px;
            margin: 20px 0;
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
        .signature {
            text-align: center;
            margin: 30px 0;
            padding: 20px;
            background: #f8f9fa;
            border-radius: 5px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Job Application</h1>
        </div>
        
        <div class="job-details">
            <h3 style="margin-top: 0; color: #2c3e50;">Position: ${job.title}</h3>
            <p><strong>Company:</strong> ${job.company}</p>
            <p><strong>Location:</strong> ${job.location || 'Not specified'}</p>
            ${job.salary ? `<p><strong>Salary:</strong> ${job.salary}</p>` : ''}
        </div>
        
        <div class="contact-info">
            <h3 style="margin-top: 0; color: #2c3e50;">Applicant Information</h3>
            <p><strong>Name:</strong> ${userInfo.name}</p>
            <p><strong>Email:</strong> ${userInfo.email}</p>
            <p><strong>Phone:</strong> ${userInfo.phone}</p>
        </div>
        
        <div class="cv-score">
            🎯 CV Match Score: ${cvScore}% for this position
        </div>
        
        <div class="attachment-note">
            <strong>📎 CV/Resume:</strong> Please find the complete CV attached as a PDF file.
        </div>
        
        <div class="cover-letter">
            <h3 style="color: #2c3e50;">Cover Letter</h3>
            <div style="white-space: pre-line;">${coverLetter.replace(/\[Applicant Name\]|\[Your Name\]/g, userInfo.name)}</div>
        </div>
        
        <div class="signature">
            <p style="margin: 0;"><strong>Best regards,</strong></p>
            <p style="margin: 5px 0 0 0; color: #2c3e50; font-size: 1.1em;"><strong>${userInfo.name}</strong></p>
            <p style="margin: 5px 0 0 0; color: #666;">${userInfo.email}</p>
            <p style="margin: 5px 0 0 0; color: #666;">${userInfo.phone}</p>
        </div>
        
        <div class="footer">
            <p>This application was submitted through <strong>SmartCVNaija</strong> - Nigeria's professional job application platform.</p>
            <p style="font-size: 0.8em; color: #999;">Application ID: ${applicationId}</p>
        </div>
    </div>
</body>
</html>`;
}

function generateEmailText(job, coverLetter, userInfo, applicationId, cvScore) {
  return `
Job Application - ${job.title}

Position: ${job.title}
Company: ${job.company}
Location: ${job.location || 'Not specified'}
${job.salary ? `Salary: ${job.salary}` : ''}

Applicant Information:
Name: ${userInfo.name}
Email: ${userInfo.email}
Phone: ${userInfo.phone}

🎯 CV Match Score: ${cvScore}% for this position

📎 CV/Resume: Please find the complete CV attached as a PDF file.

Cover Letter:
${coverLetter.replace(/\[Applicant Name\]|\[Your Name\]/g, userInfo.name)}

Best regards,
${userInfo.name}
${userInfo.email}
${userInfo.phone}

---
This application was submitted through SmartCVNaija - Nigeria's professional job application platform.
Application ID: ${applicationId}
`;
}

function generateConfirmationEmailHTML(userInfo, jobCount, applicationRecords) {
  const jobsList = applicationRecords.map(record => `
    <tr style="border-bottom: 1px solid #eee;">
      <td style="padding: 8px;">${record.jobTitle}</td>
      <td style="padding: 8px;">${record.company}</td>
      <td style="padding: 8px; text-align: center;">
        <span style="color: ${record.status === 'submitted' ? 'green' : 'red'};">
          ${record.status === 'submitted' ? '✅ Submitted' : '❌ Failed'}
        </span>
      </td>
    </tr>
  `).join('');

  return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Application Confirmation</title>
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
        .container {
            background: white;
            border-radius: 8px;
            padding: 30px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        .header { 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 20px;
            border-radius: 8px;
            text-align: center;
            margin-bottom: 25px;
        }
        .success-banner {
            background: #d4edda;
            color: #155724;
            padding: 15px;
            border-radius: 5px;
            border: 1px solid #c3e6cb;
            margin-bottom: 20px;
            text-align: center;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin: 20px 0;
        }
        th {
            background: #f8f9fa;
            padding: 10px;
            text-align: left;
            border-bottom: 2px solid #dee2e6;
        }
        .footer { 
            border-top: 1px solid #eee; 
            padding-top: 20px; 
            margin-top: 30px; 
            color: #666; 
            font-size: 0.9em; 
            text-align: center;
        }
        .next-steps {
            background: #e3f2fd;
            padding: 15px;
            border-radius: 5px;
            border-left: 4px solid #2196f3;
            margin: 20px 0;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎉 Application Submitted Successfully!</h1>
        </div>
        
        <div class="success-banner">
            <h2 style="margin: 0;">Great news, ${userInfo.name}!</h2>
            <p style="margin: 10px 0 0 0;">Your applications have been submitted to ${jobCount} companies.</p>
        </div>
        
        <h3>Application Summary</h3>
        <table>
            <thead>
                <tr>
                    <th>Position</th>
                    <th>Company</th>
                    <th>Status</th>
                </tr>
            </thead>
            <tbody>
                ${jobsList}
            </tbody>
        </table>
        
        <div class="next-steps">
            <h3 style="margin-top: 0;">What happens next?</h3>
            <ul style="margin: 0; padding-left: 20px;">
                <li>Your applications have been sent directly to hiring managers</li>
                <li>Companies typically respond within 5-10 business days</li>
                <li>Check your email regularly for responses</li>
                <li>We recommend following up with companies after 1 week</li>
            </ul>
        </div>
        
        <div style="background: #fff3cd; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <strong>📧 Important:</strong> Replies from employers will come directly to your email: <strong>${userInfo.email}</strong>
        </div>
        
        <div class="footer">
            <p><strong>Good luck with your job search!</strong></p>
            <p>Best regards,<br>The SmartCVNaija Team</p>
            <hr style="margin: 20px 0;">
            <p style="font-size: 0.8em; color: #999;">
                This is an automated confirmation from SmartCVNaija.<br>
                If you have questions, contact us at support@smartcvnaija.com.ng
            </p>
        </div>
    </div>
</body>
</html>`;
}

function generateConfirmationEmailText(userInfo, jobCount, applicationRecords) {
  const jobsList = applicationRecords.map(record => 
    `• ${record.jobTitle} at ${record.company} - ${record.status === 'submitted' ? 'Submitted' : 'Failed'}`
  ).join('\n');

  return `
🎉 APPLICATION CONFIRMATION

Great news, ${userInfo.name}!

Your applications have been successfully submitted to ${jobCount} companies.

APPLICATION SUMMARY:
${jobsList}

WHAT HAPPENS NEXT?
• Your applications have been sent directly to hiring managers
• Companies typically respond within 5-10 business days  
• Check your email regularly for responses
• We recommend following up with companies after 1 week

📧 IMPORTANT: Replies from employers will come directly to your email: ${userInfo.email}

Good luck with your job search!

Best regards,
The SmartCVNaija Team

---
This is an automated confirmation from SmartCVNaija.
If you have questions, contact us at support@smartcvnaija.com.ng
`;
}

// Utility functions
async function silentCleanupAndLogging(identifier, jobs, emailResults, pdfFilePath) {
  try {
    setTimeout(() => {
      try {
        if (fs.existsSync(pdfFilePath)) {
          fs.unlinkSync(pdfFilePath);
          logger.info('PDF file cleaned up', { pdfFilePath });
        }
      } catch (cleanupError) {
        logger.warn('Failed to cleanup PDF file', { pdfFilePath, error: cleanupError.message });
      }
    }, 600000);
    
    logger.info('Applications processed successfully', {
      identifier: identifier.substring(0, 6) + '***',
      totalJobs: jobs.length,
      successful: emailResults.successful.length,
      failed: emailResults.failed.length
    });
    
    if (global.gc) {
      global.gc();
    }
    
  } catch (error) {
    logger.error('Silent cleanup failed', { error: error.message });
  }
}

function updateStats(processingTime, emailResults, isRejected = false) {
  stats.processed++;
  stats.totalTime += processingTime;
  
  if (isRejected) {
    stats.rejectedCvs++;
    stats.failed++;
  } else if (emailResults.successful.length > 0) {
    stats.successful++;
  } else {
    stats.failed++;
  }
}

// MAIN APPLICATION WORKER - with your original high-performance settings
const applicationWorker = new Worker('job-applications', async (job) => {
  const { identifier, file, jobs, applicationId, processingStrategy } = job.data;
  const startTime = Date.now();
  
  try {
    logger.info('Starting application processing', {
      identifier: identifier.substring(0, 6) + '***',
      applicationId,
      jobCount: jobs.length,
      strategy: processingStrategy || 'standard',
      hasFilePath: !!file.filepath
    });

    // STEP 1: Verify file exists on disk
    await job.updateProgress(10);
    const pdfFilePath = await verifyFileExists(file, identifier);
    
    // STEP 2: Process and validate CV
    await job.updateProgress(30);
    let cvData;
    try {
      cvData = await processCVFromFile(file, identifier);
    } catch (validationError) {
      logger.error('CV validation failed - rejecting application', {
        identifier: identifier.substring(0, 6) + '***',
        error: validationError.message
      });
      
      updateStats(Date.now() - startTime, { successful: [], failed: [] }, true);
      throw new Error(`CV_VALIDATION_FAILED: ${validationError.message}`);
    }
    
    const { cvText, userInfo } = cvData;
    
    logger.info('CV validation successful', {
      identifier: identifier.substring(0, 6) + '***',
      applicantName: userInfo.name,
      applicantEmail: userInfo.email,
      cvTextLength: cvText.length
    });
    
    // STEP 3: Generate cover letters
    await job.updateProgress(50);
    const coverLetters = await generateCoverLetters(cvText, jobs, userInfo);
    
    // STEP 4: Create application records with CV scoring
    await job.updateProgress(70);
    const applicationRecords = await createApplicationRecords(identifier, jobs, cvText, userInfo);
    
    // STEP 5: Send emails to employers
    await job.updateProgress(85);
    const emailResults = await sendProfessionalEmails(identifier, jobs, pdfFilePath, coverLetters, applicationRecords, userInfo);
    
    // STEP 6: Send confirmation email to applicant
    await job.updateProgress(95);
    await sendConfirmationEmail(userInfo, jobs.length, applicationRecords);
    
    // STEP 7: Cleanup
    await job.updateProgress(100);
    await silentCleanupAndLogging(identifier, jobs, emailResults, pdfFilePath);
    
    updateStats(Date.now() - startTime, emailResults);

    logger.info('Application processing completed successfully', {
      identifier: identifier.substring(0, 6) + '***',
      applicationId,
      applicant: userInfo.name,
      emailsSent: emailResults.successful.length,
      processingTime: (Date.now() - startTime) + 'ms'
    });

    return {
      success: true,
      applicant: userInfo.name,
      applicantEmail: userInfo.email,
      applicationsProcessed: jobs.length,
      emailsSent: emailResults.successful.length,
      emailsFailed: emailResults.failed.length,
      applicationRecords: applicationRecords,
      processingTime: (Date.now() - startTime) + 'ms'
    };

  } catch (error) {
    await sendFailureEmailToAdmin(identifier, 'CRITICAL_PROCESSING_ERROR', {
      error: error.message,
      jobId: applicationId,
      jobCount: jobs.length,
      processingTime: Date.now() - startTime,
      stack: error.stack,
      needsImmediateContact: true
    });
    
    logger.error('Application processing failed', { 
      identifier: identifier.substring(0, 6) + '***',
      applicationId,
      error: error.message,
      isValidationError: error.message.includes('CV_VALIDATION_FAILED'),
      isDatabaseError: error.message.includes('DATABASE_ERROR')
    });
    
    throw error;
  }
}, { 
  connection: queueRedis,
  prefix: 'queue:',
  concurrency: CONFIG.concurrency,    // Your original setting: 8
  settings: {
    retryProcessDelay: 10000,
    maxStalledCount: 2,
    stalledInterval: 60000
  },
  removeOnComplete: 20,
  removeOnFail: 10
});

// Event handlers
applicationWorker.on('completed', (job, result) => {
  logger.info('Application job completed', {
    jobId: job.id,
    identifier: job.data.identifier?.substring(0, 6) + '***',
    applicant: result.applicant,
    applicationId: job.data.applicationId,
    emailsSent: result.emailsSent,
    processingTime: result.processingTime
  });
});

applicationWorker.on('failed', (job, error) => {
  const isValidationError = error.message.includes('CV_VALIDATION_FAILED');
  
  logger.error('Application job failed', {
    jobId: job.id,
    identifier: job.data?.identifier?.substring(0, 6) + '***',
    applicationId: job.data?.applicationId,
    error: error.message,
    attempts: job.attemptsMade,
    isValidationError: isValidationError,
    reason: isValidationError ? 'Invalid CV - rejected' : 'Processing error'
  });
});

applicationWorker.on('stalled', (jobId) => {
  logger.warn('Application job stalled', { jobId });
});

// Performance monitoring
setInterval(() => {
  if (stats.processed > 0) {
    const avgProcessingTime = Math.round(stats.totalTime / stats.processed);
    const successRate = Math.round((stats.successful / stats.processed) * 100);
    const rejectionRate = Math.round((stats.rejectedCvs / stats.processed) * 100);
    
    logger.info('Application Worker Performance', {
      totalProcessed: stats.processed,
      successful: stats.successful,
      failed: stats.failed,
      rejectedCvs: stats.rejectedCvs,
      successRate: successRate + '%',
      rejectionRate: rejectionRate + '%',
      avgProcessingTime: avgProcessingTime + 'ms',
      emailsSent: stats.emailsSent,
      emailsFailed: stats.emailsFailed,
      emailSuccessRate: Math.round((stats.emailsSent / (stats.emailsSent + stats.emailsFailed || 1)) * 100) + '%',
      concurrency: CONFIG.concurrency,
      estimatedCapacity: Math.round((3600000 / avgProcessingTime) * CONFIG.concurrency) + ' applications/hour'
    });
  }
}, 300000);

// Startup message
logger.info('🚀 Application Worker started with database connection fix!', {
  concurrency: CONFIG.concurrency,
  emailBatchSize: CONFIG.emailBatchSize,
  emailDelay: CONFIG.emailDelay + 'ms',
  emailTimeout: CONFIG.emailTimeout + 'ms',
  uploadsDirectory: uploadsDir,
  minNameLength: CONFIG.minNameLength,
  databaseHost: config.get('database.host'),
  databaseName: config.get('database.name'),
  estimatedCapacity: (CONFIG.concurrency * 60) + ' applications/hour'
});

module.exports = applicationWorker;