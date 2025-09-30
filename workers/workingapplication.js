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
// Add this near the top with other requires


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
  concurrency: 8,                    // Slightly reduced for stability
  emailBatchSize: 3,
  emailDelay: 1500,
  emailTimeout: 20000,
  coverLetterTimeout: 25000,         // FIXED: Increased from 12000
  cvAnalysisTimeout: 20000,
  maxRetries: 2,
  minNameLength: 2,
  jobTTL: 30000                      // Job timeout
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
  const maxRetries = 3;
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Simple connection check without getConnectionStatus
      if (!dbManager.pool || !dbManager.isConnected) {
        logger.warn(`Database not connected (attempt ${attempt}), reconnecting...`);
        await dbManager.connect();
      }
      
      const result = await dbManager.query(query, params);
      
      // Log successful retry if this wasn't the first attempt
      if (attempt > 1) {
        logger.info('Database query succeeded after retry', { 
          attempt,
          query: query.substring(0, 100)
        });
        stats.dbRetries++;
      }
      
      return result;
      
    } catch (error) {
      lastError = error;
      const isConnectionError = error.message.includes('connection') || 
                               error.code === 'ECONNRESET' || 
                               error.code === 'ENOTFOUND' ||
                               error.code === 'ECONNREFUSED';
      
      logger.warn(`Database query failed (attempt ${attempt}/${maxRetries})`, { 
        error: error.message,
        code: error.code,
        isConnectionError,
        query: query.substring(0, 100)
      });
      
      if (attempt === maxRetries) {
        break; // Exit retry loop
      }
      
      // Wait before retry - exponential backoff
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
      await new Promise(resolve => setTimeout(resolve, delay));
      
      // Force reconnection on connection errors
      if (isConnectionError) {
        try {
          await dbManager.connect();
        } catch (reconnectError) {
          logger.error('Failed to reconnect to database', { 
            error: reconnectError.message 
          });
        }
      }
    }
  }
  
  logger.error('Database query failed after all retries', { 
    error: lastError.message,
    query: query.substring(0, 100),
    attempts: maxRetries
  });
  
  throw lastError;
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
    const userInfo = await extractUserInfoWithAI(cleanedText, identifier);
    
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
async function extractUserInfoWithAI(cvText, identifier) {
  try {
    logger.info('Starting AI-first user info extraction', {
      identifier: identifier.substring(0, 6) + '***',
      cvTextLength: cvText.length
    });

    // STEP 1: Try AI extraction first
    try {
      const extractPromise = openaiService.extractUserInfo(cvText, identifier);
      
      // THIS IS WHERE YOU CHANGE THE TIMEOUT
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('User info extraction timeout')), 120000)  // Changed from 60000 to 90000
      );

      const aiExtraction = await Promise.race([extractPromise, timeoutPromise]);
      
      if (validateUserInfo(aiExtraction, identifier)) {
        logger.info('AI extraction successful', {
          identifier: identifier.substring(0, 6) + '***',
          extractedName: aiExtraction.name,
          extractedEmail: aiExtraction.email,
          confidence: aiExtraction.confidence,
          source: 'AI'
        });
        return aiExtraction;
      } else {
        // AI returned invalid data, try regex backup
        logger.warn('AI returned invalid data, trying regex', {
          identifier: identifier.substring(0, 6) + '***',
          aiName: aiExtraction.name || 'NONE'
        });
        
        const regexExtraction = extractUserInfoTraditional(cvText, identifier);
        
        if (validateUserInfo(regexExtraction, identifier)) {
          logger.info('Regex backup successful', {
            identifier: identifier.substring(0, 6) + '***',
            extractedName: regexExtraction.name,
            source: 'Regex_Backup'
          });
          return regexExtraction;
        }

        // Both failed, use enhanced fallback
        return enhancedFallbackExtraction(cvText, identifier, regexExtraction, aiExtraction);
      }

    } catch (aiError) {
      logger.warn('AI extraction failed, using regex backup', {
        identifier: identifier.substring(0, 6) + '***',
        error: aiError.message
      });
      
      // AI failed, fall back to proven regex
      const regexExtraction = extractUserInfoTraditional(cvText, identifier);
      
      if (validateUserInfo(regexExtraction, identifier)) {
        logger.info('Regex backup successful after AI failure', {
          identifier: identifier.substring(0, 6) + '***',
          extractedName: regexExtraction.name,
          source: 'Regex_Backup'
        });
        return regexExtraction;
      }
      
      // Both failed, enhanced fallback
      return enhancedFallbackExtraction(cvText, identifier, regexExtraction);
    }

  } catch (error) {
    logger.error('User info extraction completely failed', {
      identifier: identifier.substring(0, 6) + '***',
      error: error.message
    });
    
    // Return basic structure to prevent total failure
    return {
      name: '',
      email: '',
      phone: identifier,
      source: 'fallback'
    };
  }
}
function extractUserInfoTraditional(cvText, identifier) {
  try {
     let extractedName = '';
    
    // Look for name patterns anywhere in the document
    const namePatterns = [
      // Look for "Cynthia Igbonai Bakare" pattern
      /([A-Z][a-z]+\s+[A-Z][a-z]+\s+[A-Z][a-z]+)\s*Nationality:/i,
      // Name before nationality
      /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\s*(?:Nationality|Date of birth|Gender):/i,
      // Name in structured format
      /(?:Name|Full Name)[:\s]*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/i,
      // Name at document start (original pattern)
      /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/m
    ];
    
    for (const pattern of namePatterns) {
      const match = cvText.match(pattern);
      if (match && match[1]) {
        const candidate = match[1].trim();
        if (candidate !== 'ABOUT ME' && !candidate.includes('Experience')) {
          extractedName = candidate;
          break;
        }
      }
    }
    
    // STRATEGY 2: Check first non-header lines
    if (!extractedName) {
      // Skip common headers and look for actual content
      let startIndex = 0;
      for (let i = 0; i < Math.min(10, lines.length); i++) {
        const line = lines[i].toLowerCase();
        if (line.includes('personal information') || 
            line.includes('contact details') ||
            line.includes('cv') || 
            line.includes('resume')) {
          startIndex = i + 1;
          break;
        }
      }
      
      // Look at lines after headers
      for (let i = startIndex; i < Math.min(startIndex + 5, lines.length); i++) {
        const line = lines[i];
        // Remove bullet points and clean
        const cleaned = line.replace(/^[•\-\*]\s*/, '').trim();
        
        // Check if this looks like a name
        const namePattern = /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})$/;
        const match = cleaned.match(namePattern);
        
        if (match) {
          const candidate = match[1];
          // Exclude known non-names
          const excludeTerms = ['Team Leadership', 'Team Leader', 'Project Manager', 
                               'Skills', 'Experience', 'Education', 'Professional'];
          
          const isExcluded = excludeTerms.some(term => 
            candidate.toLowerCase().includes(term.toLowerCase())
          );
          
          if (!isExcluded) {
            extractedName = candidate;
            break;
          }
        }
      }
    }
    
    // STRATEGY 3: Look near email addresses (names often appear right before email)
    if (!extractedName) {
      const emailPattern = /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s*\n[•\-\*]?\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/;
      const match = cvText.match(emailPattern);
      if (match && match[1]) {
        const candidate = match[1].trim();
        if (!candidate.toLowerCase().includes('team') && 
            !candidate.toLowerCase().includes('leadership')) {
          extractedName = candidate;
        }
      }
    }

    // Rest of your email and phone extraction code remains the same...
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
      extractedName: extractedName || 'NOT FOUND',
      extractedEmail: extractedEmail,
      extractedPhone: extractedPhone,
      firstFewLines: lines.slice(0, 5).join(' | ')
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

// Add these functions after your extractUserInfoTraditional function (around line 416)

function enhancedFallbackExtraction(cvText, identifier, regexData = {}, aiData = {}) {
  logger.info('Performing enhanced fallback extraction', {
    identifier: identifier.substring(0, 6) + '***',
    hasRegex: !!regexData.name,
    hasAI: !!aiData.name
  });

  const result = {
    name: selectBestName(regexData.name, aiData.name, cvText),
    email: selectBestEmail(regexData.email, aiData.email, cvText),
    phone: selectBestPhone(regexData.phone, aiData.phone, identifier),
    source: 'enhanced_fallback'
  };

  // Final validation and cleanup
  if (!result.name) {
    result.name = extractNameFromEmail(result.email) || extractNameFromText(cvText) || '';
  }

  logger.info('Enhanced fallback extraction completed', {
    identifier: identifier.substring(0, 6) + '***',
    finalName: result.name || 'NONE',
    finalEmail: result.email || 'NONE',
    source: result.source
  });

  return result;
}

function selectBestName(regex, ai, cvText) {
  // ALWAYS prefer AI if it has a valid name
  if (ai && ai.length >= 4 && ai.split(' ').length >= 2 && 
      !ai.toLowerCase().includes('team') && 
      !ai.toLowerCase().includes('leadership')) {
    return ai;
  }
  
  // Only use regex if AI completely failed
  if (regex && regex.length >= 4 && 
      !regex.toLowerCase().includes('team') && 
      !regex.toLowerCase().includes('leadership')) {
    return regex;
  }
  
  
  // Last resort: try direct extraction
  return extractNameFromText(cvText) || '';
}

function selectBestEmail(regex, ai, cvText) {
  // Prefer AI if valid
  if (ai && ai.includes('@') && ai.includes('.')) {
    return ai;
  }
  
  // Fallback to regex
  if (regex && regex.includes('@')) {
    return regex;
  }
  
  return '';
}

function selectBestPhone(regex, ai, identifier) {
  // Prefer AI if it looks like a proper phone number
  if (ai && (ai.startsWith('+234') || ai.startsWith('0') || ai.startsWith('234'))) {
    return ai;
  }
  
  // Fallback to regex
  if (regex && regex !== identifier) {
    return regex;
  }
  
  return identifier;
}

function extractNameFromEmail(email) {
  if (!email || !email.includes('@')) return '';
  
  const prefix = email.split('@')[0];
  // Simple name extraction for common patterns
  if (prefix.includes('.')) {
    return prefix.split('.').map(part => 
      part.charAt(0).toUpperCase() + part.slice(1)
    ).join(' ');
  }
  
  return '';
}

function extractNameFromText(cvText) {
  if (!cvText) return '';
  
  const lines = cvText.split('\n').slice(0, 10); // First 10 lines
  
  for (const line of lines) {
    const words = line.trim().split(/\s+/);
    if (words.length >= 2 && words.length <= 4) {
      const potential = words.join(' ');
      // Simple validation
      if (potential.length >= 4 && /^[A-Za-z\s\-'.]+$/.test(potential)) {
        return potential;
      }
    }
  }
  
  return '';
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


// CRITICAL FIX: Database operations using the fixed query function
async function createApplicationRecords(identifier, jobs, cvText, userInfo) {
  const records = [];
  
  for (const job of jobs) {
    try {
      const applicationId = require('uuid').v4();
      
      // CRITICAL FIX: Use the fixed database query function
      await executeQuery(`
        INSERT INTO applications (
          id, user_identifier, job_id, cv_text, 
          status, applied_at, applicant_name, applicant_email, applicant_phone
        ) VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8)
      `, [applicationId, identifier, job.id, cvText, 'submitted', 
          userInfo.name, userInfo.email, userInfo.phone]);
      
      records.push({
        id: applicationId,
        jobId: job.id,
        jobTitle: job.title,
        company: job.company,
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
        status: 'failed'
      });
    }
  }
  
  const successfulRecords = records.filter(r => r.status === 'submitted');
  
  logger.info('Application records created', { 
    applicant: userInfo.name,
    created: successfulRecords.length,
    failed: records.filter(r => r.status === 'failed').length,
    total: jobs.length
  });

  return records;
}

// Cover letter generation
// FIXED: Enhanced cover letter generation with proper timeout
async function generateCoverLetters(cvText, jobs, userInfo) {
  const coverLetters = {};
  const defaultLetter = getDefaultCoverLetter(userInfo.name);
  
  coverLetters.default = defaultLetter;
  
  // CRITICAL: Process with faster timeout
  const promises = jobs.map(async (job) => {
    try {
      // CRITICAL: Reduced timeout from 20000 to 8000ms
      const coverLetterPromise = openaiService.generateCoverLetter(
        cvText, 
        job.title, 
        job.company,
        userInfo.name,
        job.id // Pass job ID as identifier
      );
      
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Cover letter timeout')), 60000)
      );
      
      const personalizedLetter = await Promise.race([coverLetterPromise, timeoutPromise]);
      
      if (personalizedLetter && personalizedLetter.length > 100) {
        coverLetters[job.id] = personalizedLetter;
        logger.info('Cover letter generated successfully', {
          jobId: job.id,
          company: job.company,
          applicant: userInfo.name,
          letterLength: personalizedLetter.length,
          source: 'AI'
        });
      } else {
        throw new Error('AI returned insufficient content');
      }
      
    } catch (error) {
      logger.info('Cover letter generation failed, using enhanced fallback', { 
        jobId: job.id,
        company: job.company,
        applicant: userInfo.name,
        error: error.message,
        source: 'Fallback'
      });
      
      // ENHANCED: Generate personalized fallback instead of generic one
      coverLetters[job.id] = generateEnhancedFallbackCoverLetter(
        cvText, job.title, job.company, userInfo.name
      );
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
// ADD this function to your application worker file:
function generateEnhancedFallbackCoverLetter(cvText, jobTitle, companyName, applicantName) {
  try {
    const text = (cvText || '').toLowerCase();
    
    // Quick experience detection
    const yearMatches = text.match(/(\d+)\s*years?\s*(of\s*)?(experience|exp)/gi);
    let experienceText = 'relevant professional background';
    
    if (yearMatches) {
      const years = parseInt(yearMatches[0].match(/(\d+)/)[1]);
      experienceText = years >= 5 ? `${years}+ years of extensive experience` : 
                      years >= 2 ? `${years} years of solid experience` : 
                      `${years} years of foundational experience`;
    }
    
    // Education detection
    let educationText = '';
    if (text.includes('master') || text.includes('msc')) {
      educationText = 'advanced degree and ';
    } else if (text.includes('bachelor') || text.includes('bsc')) {
      educationText = 'university education and ';
    } else if (text.includes('diploma') || text.includes('hnd')) {
      educationText = 'professional qualification and ';
    }
    
    // Job-specific content
    const title = (jobTitle || '').toLowerCase();
    let jobSpecificText = 'professional expertise that aligns with your requirements';
    
    if (title.includes('account') || title.includes('finance')) {
      jobSpecificText = 'financial analysis and accounting expertise';
    } else if (title.includes('develop') || title.includes('software')) {
      jobSpecificText = 'technical skills and programming knowledge';
    } else if (title.includes('engineer')) {
      jobSpecificText = 'engineering background and technical problem-solving abilities';
    } else if (title.includes('market') || title.includes('sales')) {
      jobSpecificText = 'business development and client relationship expertise';
    } else if (title.includes('manag')) {
      jobSpecificText = 'leadership experience and team management capabilities';
    } else if (title.includes('admin')) {
      jobSpecificText = 'organizational skills and administrative efficiency';
    }
    
    return `Dear Hiring Manager,

I am writing to express my strong interest in the ${jobTitle} position at ${companyName}. With my ${educationText}${experienceText}, I am well-positioned to contribute effectively to your team.

My background has equipped me with ${jobSpecificText}, making me a strong candidate for this role. I am particularly excited about the opportunity to join ${companyName} and apply my skills in a dynamic environment where I can continue to grow professionally.

I would welcome the opportunity to discuss how my experience and enthusiasm can contribute to your organization's continued success. Thank you for considering my application.

Best regards,
${applicantName}`;

  } catch (error) {
    logger.error('Enhanced fallback cover letter failed', { error: error.message });
    
    // Ultimate fallback
    return getDefaultCoverLetter(applicantName);
  }
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
      html: generateEmailHTML(job, coverLetter, userInfo, applicationRecord.id),
      text: generateEmailText(job, coverLetter, userInfo, applicationRecord.id),
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
function generateEmailHTML(job, coverLetter, userInfo, applicationId) {
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

function generateEmailText(job, coverLetter, userInfo, applicationId) {
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
// Add this function to your workers/application.js file:
async function sendFailureEmailToAdmin(identifier, errorType, errorDetails) {
  try {
    const adminEmailOptions = {
      from: '"SmartCV Naija System" <noreply@smartcvnaija.com.ng>',
      to: process.env.ADMIN_EMAIL || 'profitplay9ja@gmail.com', // Set this in your .env file
      subject: `🚨 Critical Error: ${errorType} - ${identifier.substring(0, 6)}***`,
      html: generateAdminErrorEmailHTML(identifier, errorType, errorDetails),
      text: generateAdminErrorEmailText(identifier, errorType, errorDetails)
    };

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Admin email timeout'));
      }, 10000); // 10 second timeout for admin emails

      confirmationTransporter.sendMail(adminEmailOptions, (error, info) => {
        clearTimeout(timeout);
        if (error) {
          logger.error('Admin notification email failed', { error: error.message });
          reject(error);
        } else {
          logger.info('Admin notification email sent successfully', { 
            messageId: info.messageId,
            errorType,
            identifier: identifier.substring(0, 6) + '***'
          });
          resolve(info);
        }
      });
    });

    return true;

  } catch (error) {
    logger.error('Failed to send admin notification email', {
      errorType,
      identifier: identifier.substring(0, 6) + '***',
      error: error.message
    });
    return false;
  }
}

function generateAdminErrorEmailHTML(identifier, errorType, errorDetails) {
  const timestamp = new Date().toISOString();
  
  return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Critical System Error - SmartCV Naija</title>
    <style>
        body { 
            font-family: 'Courier New', monospace; 
            line-height: 1.6; 
            color: #333; 
            max-width: 800px; 
            margin: 0 auto; 
            padding: 20px; 
            background-color: #f8f9fa;
        }
        .container {
            background: white;
            border-radius: 8px;
            padding: 30px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            border-left: 5px solid #dc3545;
        }
        .header { 
            background: #dc3545;
            color: white;
            padding: 15px;
            border-radius: 5px;
            margin-bottom: 20px;
            text-align: center;
        }
        .error-details {
            background: #f8f9fa;
            padding: 15px;
            border-radius: 5px;
            margin: 15px 0;
            border: 1px solid #dee2e6;
        }
        .urgent {
            background: #fff3cd;
            border: 1px solid #ffeeba;
            color: #856404;
            padding: 15px;
            border-radius: 5px;
            margin: 20px 0;
            font-weight: bold;
        }
        .stack-trace {
            background: #2d3748;
            color: #e2e8f0;
            padding: 15px;
            border-radius: 5px;
            font-size: 12px;
            overflow-x: auto;
            white-space: pre-wrap;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚨 CRITICAL SYSTEM ERROR</h1>
            <p>SmartCV Naija Application Processing Failure</p>
        </div>
        
        <div class="error-details">
            <h3>Error Summary</h3>
            <p><strong>Error Type:</strong> ${errorType}</p>
            <p><strong>User Identifier:</strong> ${identifier.substring(0, 6)}***</p>
            <p><strong>Timestamp:</strong> ${timestamp}</p>
            <p><strong>Processing Time:</strong> ${errorDetails.processingTime}ms</p>
            <p><strong>Job Count:</strong> ${errorDetails.jobCount || 'Unknown'}</p>
        </div>
        
        <div class="error-details">
            <h3>Error Message</h3>
            <p style="color: #dc3545; font-weight: bold;">${errorDetails.error}</p>
        </div>
        
        ${errorDetails.needsImmediateContact ? `
        <div class="urgent">
            ⚠️ IMMEDIATE ATTENTION REQUIRED: This error may require immediate investigation and user contact.
        </div>
        ` : ''}
        
        ${errorDetails.stack ? `
        <div class="error-details">
            <h3>Stack Trace</h3>
            <div class="stack-trace">${errorDetails.stack}</div>
        </div>
        ` : ''}
        
        <div class="error-details">
            <h3>System Information</h3>
            <p><strong>Environment:</strong> ${process.env.NODE_ENV || 'development'}</p>
            <p><strong>Server Time:</strong> ${new Date().toLocaleString()}</p>
            <p><strong>Process ID:</strong> ${process.pid}</p>
            <p><strong>Memory Usage:</strong> ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB</p>
        </div>
        
        <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #dee2e6;">
            <p><strong>Action Required:</strong></p>
            <ul>
                <li>Check application logs for additional context</li>
                <li>Verify database and external service connectivity</li>
                ${errorDetails.needsImmediateContact ? '<li><strong>Contact user immediately if processing failed</strong></li>' : ''}
                <li>Monitor for similar errors in the next hour</li>
            </ul>
        </div>
    </div>
</body>
</html>`;
}

function generateAdminErrorEmailText(identifier, errorType, errorDetails) {
  const timestamp = new Date().toISOString();
  
  return `
🚨 CRITICAL SYSTEM ERROR - SmartCV Naija

ERROR SUMMARY:
- Type: ${errorType}
- User: ${identifier.substring(0, 6)}***
- Time: ${timestamp}
- Processing Time: ${errorDetails.processingTime}ms
- Job Count: ${errorDetails.jobCount || 'Unknown'}

ERROR MESSAGE:
${errorDetails.error}

${errorDetails.needsImmediateContact ? '⚠️  IMMEDIATE ATTENTION REQUIRED' : ''}

SYSTEM INFO:
- Environment: ${process.env.NODE_ENV || 'development'}
- Process ID: ${process.pid}
- Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB

${errorDetails.stack ? `STACK TRACE:\n${errorDetails.stack}` : ''}

ACTION REQUIRED:
- Check application logs for additional context
- Verify database and external service connectivity
${errorDetails.needsImmediateContact ? '- Contact user immediately if processing failed' : ''}
- Monitor for similar errors in the next hour

---
SmartCV Naija Automated System Alert
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
  concurrency: CONFIG.concurrency,
  settings: {
    retryProcessDelay: 10000,
    maxStalledCount: 2,
    stalledInterval: 60000
  },
  removeOnComplete: 20,
  removeOnFail: 10,
  // ADD THIS:
  defaultJobOptions: {
    ttl: 300000  // 5 minute job timeout
  }
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