// workers/cv-background.js - BACKGROUND CV PROCESSING (NON-BLOCKING)

const { Worker } = require('bullmq');
const { queueRedis } = require('../config/redis');
const redis = require('../config/redis');
const logger = require('../utils/logger');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

// ✅ DEDICATED BACKGROUND CV PROCESSING 
// Processes CVs uploaded earlier while users are browsing jobs
const BACKGROUND_CONCURRENCY = 20; // High concurrency for background work

const backgroundCVWorker = new Worker('cv-processing-background', async (job) => {
  const { identifier, file, cvId, timestamp } = job.data;
  
  try {
    logger.info('Background CV processing started', { 
      identifier: identifier.substring(0, 6) + '***', 
      cvId 
    });
    
    // Step 1: Text extraction
    await job.updateProgress(20);
    const detectedType = detectFileType(file.buffer, file.originalname);
    
    if (!detectedType) {
      throw new Error('Unsupported file type for background processing');
    }
    
    // Step 2: Extract text content
    await job.updateProgress(50);
    const extractedText = await extractTextFromFile(file.buffer, detectedType);
    
    if (!extractedText || extractedText.trim().length < 50) {
      throw new Error('Could not extract meaningful text from CV');
    }
    
    // Step 3: Clean and process text
    await job.updateProgress(75);
    const cleanedText = cleanExtractedText(extractedText);
    
    if (cleanedText.length < 100) {
      throw new Error('CV text too short after cleaning');
    }
    
    // Step 4: Extract user information and store results
    await job.updateProgress(90);
    const userInfo = extractUserInfo(cleanedText, identifier);
    
    // Store processed CV data for future applications
    const cvData = {
      cvText: cleanedText,
      userInfo: userInfo,
      processedAt: new Date().toISOString(),
      cvId: cvId,
      fileInfo: {
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.buffer.length
      }
    };
    
    // ✅ Store processed CV (available for instant future applications)
    await redis.set(`processed_cv:${identifier}`, JSON.stringify(cvData), 'EX', 7200);
    
    // ✅ Mark processing status
    await redis.set(`cv_status:${identifier}`, 'processed', 'EX', 7200);
    
    await job.updateProgress(100);
    
    logger.info('Background CV processing completed', { 
      identifier: identifier.substring(0, 6) + '***', 
      cvId,
      textLength: cleanedText.length,
      processingTime: Date.now() - timestamp
    });
    
    return { 
      success: true, 
      cvId, 
      textLength: cleanedText.length,
      processingTime: Date.now() - timestamp
    };
    
  } catch (error) {
    logger.error('Background CV processing failed', { 
      identifier: identifier.substring(0, 6) + '***', 
      cvId, 
      error: error.message 
    });
    
    // ✅ Mark as failed but don't break user experience
    await redis.set(`cv_status:${identifier}`, 'failed', 'EX', 3600);
    
    throw error;
  }
}, {
  connection: queueRedis,
    prefix: "queue:",
  concurrency: BACKGROUND_CONCURRENCY, // 20 background processors
  settings: {
    retryProcessDelay: 5000,
    maxStalledCount: 2,
    stalledInterval: 45000
  },
  removeOnComplete: 50,
  removeOnFail: 20
});

// ================================
// HELPER FUNCTIONS (OPTIMIZED FOR BACKGROUND)
// ================================

function detectFileType(buffer, filename) {
  try {
    // Quick file type detection
    if (buffer.subarray(0, 4).toString() === '%PDF') {
      return { mime: 'application/pdf', ext: 'pdf' };
    }
    
    const zipSignature = buffer.subarray(0, 4);
    if (zipSignature[0] === 0x50 && zipSignature[1] === 0x4B) {
      const bufferStr = buffer.toString('binary', 0, Math.min(buffer.length, 1000));
      if (bufferStr.includes('word/')) {
        return { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' };
      }
    }
    
    // Fallback to filename
    if (filename) {
      const ext = filename.toLowerCase().split('.').pop();
      switch (ext) {
        case 'pdf': return { mime: 'application/pdf', ext: 'pdf' };
        case 'docx': return { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' };
        case 'doc': return { mime: 'application/msword', ext: 'doc' };
      }
    }
    
    return null;
  } catch (error) {
    logger.error('Background file type detection failed', { error: error.message });
    return null;
  }
}

async function extractTextFromFile(buffer, detectedType) {
  try {
    if (detectedType.mime === 'application/pdf') {
      const pdfData = await pdfParse(buffer, { max: 0 });
      return pdfData.text;
      
    } else if (detectedType.mime.includes('wordprocessingml') || detectedType.ext === 'docx') {
      const result = await mammoth.extractRawText({ buffer: buffer });
      return result.value;
      
    } else if (detectedType.mime === 'application/msword' || detectedType.ext === 'doc') {
      const result = await mammoth.extractRawText({ buffer: buffer });
      return result.value;
      
    } else {
      throw new Error(`Unsupported file type: ${detectedType.mime}`);
    }
  } catch (error) {
    logger.error('Background text extraction failed', { error: error.message });
    throw error;
  }
}

function cleanExtractedText(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return '';
  }
  
  return rawText
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s{2,}/g, ' ')
    .replace(/\t+/g, ' ')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/([,.!?;:])\s+/g, '$1 ')
    .trim();
}

function extractUserInfo(cvText, identifier) {
  try {
    // Extract name
    const namePatterns = [
      /(?:name|Name)[:\s]*([A-Za-z\s]{2,30})/i,
      /^([A-Za-z\s]{2,30})$/m, // First line might be name
      /(?:^|\n)([A-Z][a-z]+\s+[A-Z][a-z]+)/m // Proper name format
    ];
    
    let extractedName = 'Job Applicant';
    for (const pattern of namePatterns) {
      const match = cvText.match(pattern);
      if (match && match[1]) {
        extractedName = match[1].trim();
        break;
      }
    }
    
    // Extract email
    const emailMatch = cvText.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    const extractedEmail = emailMatch ? emailMatch[1] : 
      `applicant.${identifier.replace(/\+/g, '').replace(/\D/g, '')}@smartcvnaija.com`;
    
    // Extract phone
    const phonePattern = /(?:\+234|234|0)[\d\s-]{10,14}/;
    const phoneMatch = cvText.match(phonePattern);
    const extractedPhone = phoneMatch ? phoneMatch[0].trim() : identifier;
    
    return {
      name: extractedName,
      email: extractedEmail,
      phone: extractedPhone
    };
    
  } catch (error) {
    logger.warn('Failed to extract user info in background processing', { error: error.message });
    return {
      name: 'Job Applicant',
      email: `applicant.${identifier.replace(/\+/g, '').replace(/\D/g, '')}@smartcvnaija.com`,
      phone: identifier
    };
  }
}

// ================================
// BACKGROUND WORKER EVENTS
// ================================

backgroundCVWorker.on('completed', (job, result) => {
  logger.info('Background CV processing completed', { 
    jobId: job.id,
    identifier: job.data.identifier.substring(0, 6) + '***',
    cvId: result.cvId,
    processingTime: result.processingTime
  });
});

backgroundCVWorker.on('failed', (job, error) => {
  logger.error('Background CV processing failed', { 
    jobId: job.id,
    identifier: job.data?.identifier?.substring(0, 6) + '***',
    cvId: job.data?.cvId,
    error: error.message 
  });
});

backgroundCVWorker.on('progress', (job, progress) => {
  if (progress === 50 || progress === 100) { // Log at key milestones
    logger.info('Background CV processing progress', { 
      jobId: job.id,
      identifier: job.data?.identifier?.substring(0, 6) + '***',
      progress: `${progress}%`
    });
  }
});

// ================================
// PERFORMANCE MONITORING
// ================================

let backgroundProcessedCount = 0;
let backgroundFailedCount = 0;
let totalBackgroundTime = 0;

// Log background processing stats every 10 minutes
setInterval(() => {
  if (backgroundProcessedCount > 0) {
    const avgTime = Math.round(totalBackgroundTime / backgroundProcessedCount);
    const successRate = Math.round(((backgroundProcessedCount - backgroundFailedCount) / backgroundProcessedCount) * 100);
    
    logger.info('Background CV Worker Performance', {
      totalProcessed: backgroundProcessedCount,
      averageTime: avgTime + 'ms',
      successRate: successRate + '%',
      failedCount: backgroundFailedCount,
      concurrency: BACKGROUND_CONCURRENCY,
      estimatedCapacity: Math.round((3600000 / avgTime) * BACKGROUND_CONCURRENCY) + ' CVs/hour'
    });
  }
}, 600000);

// Track stats
backgroundCVWorker.on('completed', (job, result) => {
  backgroundProcessedCount++;
  if (result?.processingTime) {
    totalBackgroundTime += result.processingTime;
  }
});

backgroundCVWorker.on('failed', () => {
  backgroundFailedCount++;
});

// ================================
// CLEANUP AND OPTIMIZATION
// ================================

// Clean up old processed CV data every hour
setInterval(async () => {
  try {
    const keys = await redis.keys('processed_cv:*');
    let cleanedCount = 0;
    
    for (const key of keys) {
      const ttl = await redis.ttl(key);
      if (ttl < 0) { // No expiry set
        await redis.expire(key, 7200); // Set 2 hour expiry
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      logger.info('Background cleanup completed', { 
        processedCVsCleaned: cleanedCount 
      });
    }
  } catch (error) {
    logger.error('Background cleanup failed', { error: error.message });
  }
}, 3600000); // Every hour

// ================================
// STARTUP
// ================================

logger.info('🔄 Background CV Processing Worker started!', {
  concurrency: BACKGROUND_CONCURRENCY,
  purpose: 'Pre-process CVs for instant future applications',
  estimatedCapacity: (BACKGROUND_CONCURRENCY * 60) + ' CVs/hour background',
  redisPrefix: 'processed_cv:'
});

module.exports = backgroundCVWorker;