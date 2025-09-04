// workers/cv.js - COMPLETE REWRITE - MEMORY OPTIMIZED FOR 1000+ USERS

const { Worker } = require('bullmq');
const { redis, queueRedis } = require('../config/redis');
const config = require('../config');
const logger = require('../utils/logger');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const fs = require('fs');
const path = require('path');
// ✅ REMOVE getMemoryUsage from imports since we're defining it locally


// ✅ OPTIMIZED SETTINGS FOR STABLE PERFORMANCE
const CONCURRENCY = 8;           // Reduced from 30 to 8
const MAX_MEMORY_PERCENT = 90;   // Stop processing at 90% memory
const MAX_ABSOLUTE_MEMORY_MB = 3000; 
const MEMORY_CHECK_INTERVAL = 5000; // Check every 5 seconds

// ✅ ENSURE UPLOADS DIRECTORY EXISTS
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  logger.info('Created uploads directory', { path: uploadsDir });
}

// ✅ PERFORMANCE TRACKING
let processedCount = 0;
let totalProcessingTime = 0;
let failedCount = 0;

// ================================
// ✅ MEMORY MANAGEMENT FUNCTIONS - FIXED VERSION
// ================================

function getMemoryUsage() {
  const usage = process.memoryUsage();
  const heapLimit = require('v8').getHeapStatistics().heap_size_limit;
  
  return {
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    heapLimit: heapLimit,
    usedMB: Math.round(usage.heapUsed / 1024 / 1024),
    totalMB: Math.round(usage.heapTotal / 1024 / 1024),
    limitMB: Math.round(heapLimit / 1024 / 1024),
    percentage: Math.round((usage.heapUsed / heapLimit) * 100)  // Calculate against heap limit
  };
}

function forceCleanup() {
  try {
    if (global.gc) {
      global.gc();
    }
    
    // Force cleanup of large objects
    setImmediate(() => {
      if (global.gc) global.gc();
    });
  } catch (error) {
    logger.warn('Memory cleanup failed', { error: error.message });
  }
}

function checkMemoryHealth() {
  const memory = getMemoryUsage();
  
  if (memory.usedMB > MAX_ABSOLUTE_MEMORY_MB || memory.percentage > MAX_MEMORY_PERCENT) {
    logger.warn('High memory usage detected', {
      usedMB: memory.usedMB,
      totalMB: memory.totalMB,
      limitMB: memory.limitMB,
      percentage: memory.percentage + '%'
    });
    
    forceCleanup();
    
    if (memory.percentage > 90) {
      logger.error('Critical memory usage - pausing processing', {
        percentage: memory.percentage + '%'
      });
      return false; // Stop processing new jobs
    }
  }
  
  return true; // Continue processing
}

// ================================
// ✅ FILE TYPE DETECTION (LOCAL VERSION)
// ================================

function detectFileTypeLocal(buffer, filename) {
  try {
    // Check PDF signature
    if (buffer.subarray(0, 4).toString() === '%PDF') {
      return { mime: 'application/pdf', ext: 'pdf' };
    }
    
    // Check ZIP signature (for DOCX)
    const zipSig = buffer.subarray(0, 4);
    if (zipSig[0] === 0x50 && zipSig[1] === 0x4B) {
      const content = buffer.toString('binary', 0, 1000);
      if (content.includes('word/')) {
        return { 
          mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 
          ext: 'docx' 
        };
      }
    }
    
    // Fallback to filename extension
    if (filename) {
      const ext = filename.toLowerCase().split('.').pop();
      const types = {
        'pdf': { mime: 'application/pdf', ext: 'pdf' },
        'docx': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' },
        'doc': { mime: 'application/msword', ext: 'doc' }
      };
      return types[ext] || null;
    }
    
    return null;
  } catch (error) {
    logger.error('File type detection failed', { error: error.message });
    return null;
  }
}

// ================================
// ✅ MEMORY-OPTIMIZED TEXT EXTRACTION (LOCAL VERSION)
// ================================

async function extractTextLocal(buffer, fileType) {
  let text = '';
  
  try {
    if (fileType.mime === 'application/pdf') {
      // ✅ MEMORY-OPTIMIZED PDF PROCESSING
      const result = await pdfParse(buffer, {
        max: 10,                    // Only first 10 pages
        pagerender: undefined,      // Don't render pages (saves memory)
        normalizeWhitespace: true,  // Clean whitespace
      });
      text = result.text;
      
    } else if (fileType.ext === 'docx' || fileType.mime.includes('wordprocessingml')) {
      // ✅ MEMORY-OPTIMIZED DOCX PROCESSING
      const result = await mammoth.extractRawText({ 
        buffer: buffer,
        options: {
          includeEmbeddedStyleMap: false,
          includeDefaultStyleMap: false,
          convertImage: () => null    // Don't process images
        }
      });
      text = result.value;
      
    } else if (fileType.ext === 'doc' || fileType.mime === 'application/msword') {
      // ✅ DOC FILE PROCESSING
      const result = await mammoth.extractRawText({ buffer: buffer });
      text = result.value;
    }
    
    // ✅ CLEAR BUFFER REFERENCE
    buffer = null;
    
    return text;
    
  } catch (error) {
    logger.error('Text extraction failed', { 
      error: error.message, 
      fileType: fileType.ext 
    });
    
    // ✅ CLEANUP ON ERROR
    buffer = null;
    throw error;
  }
}

// ================================
// ✅ TEXT CLEANING (LOCAL VERSION)
// ================================

function cleanTextLocal(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return '';
  }
  
  return rawText
    .replace(/\r\n/g, '\n')           // Normalize line endings
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')       // Remove excessive line breaks
    .replace(/\s{2,}/g, ' ')          // Remove excessive spaces
    .replace(/\t+/g, ' ')             // Replace tabs with spaces
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ') // Remove control chars
    .replace(/\s+([,.!?;:])/g, '$1')  // Fix punctuation spacing
    .replace(/([,.!?;:])\s+/g, '$1 ')
    .replace(/\s+/g, ' ')             // Final space cleanup
    .trim();
}

// ================================
// ✅ FILE SAVING (LOCAL VERSION)
// ================================

function saveToUploadsLocal(buffer, identifier, originalName) {
  try {
    const timestamp = Date.now();
    const safeId = identifier.replace(/[^a-zA-Z0-9]/g, '_');
    const extension = path.extname(originalName) || '.pdf';
    const filename = `cv_${safeId}_${timestamp}${extension}`;
    const filepath = path.join(uploadsDir, filename);
    
    // ✅ SAVE FILE SYNCHRONOUSLY (MORE RELIABLE)
    fs.writeFileSync(filepath, buffer);
    
    logger.info('File saved successfully', {
      identifier: identifier.substring(0, 6) + '***',
      filename: filename,
      size: buffer.length
    });
    
    return {
      filename: filename,
      filepath: filepath,
      size: buffer.length
    };
    
  } catch (error) {
    logger.error('File save failed', {
      identifier: identifier.substring(0, 6) + '***',
      error: error.message
    });
    return null;
  }
}


async function sendFailureEmailToAdmin(identifier, failureType, details = {}) {
  try {
    const nodemailer = require('nodemailer');
    const adminEmail = 'profitplay9ja@gmail.com'; // Replace with your email
    
    const priority = details.needsImmediateContact ? 'HIGH' : 'NORMAL';
    const emailSubject = `[${priority}] SmartCVNaija CV Processing Failure - ${failureType}`;
    
    let actionRequired = '';
    switch (failureType) {
      case 'CV_PROCESSING_FAILED':
        actionRequired = `
ACTION REQUIRED:
1. Contact user via WhatsApp: ${identifier}
2. Help them upload a proper CV file (PDF/DOCX)
3. Check if file is corrupted or wrong format
4. Offer manual assistance if needed`;
        break;
        
      case 'MEMORY_ERROR':
        actionRequired = `
URGENT SYSTEM ACTION REQUIRED:
1. Check server memory usage immediately
2. Contact user via WhatsApp: ${identifier}
3. Restart CV worker if necessary
4. Consider server scaling`;
        break;
    }
    
    let emailBody = `
SMARTCVNAIJA CV PROCESSING FAILURE ALERT

PRIORITY: ${priority}
Failure Type: ${failureType}
Timestamp: ${new Date().toLocaleString('en-NG', {timeZone: 'Africa/Lagos'})}

USER CONTACT INFORMATION:
WhatsApp: ${identifier}

CV PROCESSING DETAILS:
File Name: ${details.fileName || 'Unknown'}
File Size: ${details.fileSize || 0} bytes
Processing Time: ${details.processingTime || 0}ms
Job ID: ${details.jobId || 'N/A'}

TECHNICAL DETAILS:
Error: ${details.error || 'No specific error'}
Memory Usage: ${getMemoryUsage().usedMB}MB (${getMemoryUsage().percentage}%)
Worker Concurrency: ${CONCURRENCY}

${actionRequired}

SYSTEM LOGS:
Check CV worker logs for Job ID: ${details.jobId}

---
SmartCVNaija CV Processing System
Generated: ${new Date().toISOString()}
`;

    // Create transporter for this notification
    const transporter = nodemailer.createTransport({
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

    await transporter.sendMail({
      from: '"SmartCVNaija CV System" <recruit@smartcvnaija.com.ng>',
      to: adminEmail,
      subject: emailSubject,
      text: emailBody,
      html: emailBody.replace(/\n/g, '<br>'),
      priority: priority === 'HIGH' ? 'high' : 'normal'
    });

    logger.info('CV failure notification sent to admin', { 
      identifier: identifier.substring(0, 6) + '***', 
      failureType,
      priority 
    });

  } catch (emailError) {
    logger.error('Failed to send CV failure notification', { 
      identifier: identifier.substring(0, 6) + '***',
      error: emailError.message 
    });
  }
}




// ================================
// ✅ MAIN CV WORKER
// ================================

const cvWorker = new Worker('cv-processing', async (job) => {
  const startTime = Date.now();
  const { file, identifier, jobId, priority } = job.data;
  
  try {
    // ✅ MEMORY CHECK BEFORE PROCESSING
    if (!checkMemoryHealth()) {
      throw new Error('System memory usage too high, job deferred');
    }

    if (!file?.buffer) {
      throw new Error('No file provided');
    }

    const memoryBefore = getMemoryUsage();

    logger.info('Starting CV processing', {
      identifier: identifier.substring(0, 6) + '***',
      jobId,
      filename: file.originalname,
      fileSize: file.buffer.length,
      memoryBefore: memoryBefore.usedMB + 'MB'
    });
    
    // ✅ STEP 1: VALIDATION (10%)
    await job.updateProgress(10);
    
    if (file.buffer.length > 5 * 1024 * 1024) {
      throw new Error('File too large (max 5MB)');
    }
    
    if (file.buffer.length < 100) {
      throw new Error('File too small');
    }
    
    // ✅ STEP 2: DETECT FILE TYPE (20%)
    await job.updateProgress(20);
    
    const fileType = detectFileTypeLocal(file.buffer, file.originalname);
    if (!fileType) {
      throw new Error('Unsupported file type - use PDF, DOCX, or DOC');
    }
    
    // ✅ STEP 3: EXTRACT TEXT (60%)
    await job.updateProgress(60);
    
    const extractedText = await extractTextLocal(file.buffer, fileType);
    if (!extractedText || extractedText.trim().length < 50) {
      throw new Error('Could not extract text from file');
    }
    
    // ✅ STEP 4: CLEAN TEXT (80%)
    await job.updateProgress(80);
    
    const cleanedText = cleanTextLocal(extractedText);
    if (cleanedText.length < 100) {
      throw new Error('CV text too short after cleaning');
    }
    
    // ✅ STEP 5: SAVE FILE (90%)
    await job.updateProgress(90);
    
    const savedFile = saveToUploadsLocal(file.buffer, identifier, file.originalname);
    
    // ✅ STEP 6: CREATE METADATA (100%)
    await job.updateProgress(100);
    
    const metadata = {
      filename: savedFile?.filename || `cv_${Date.now()}.pdf`,
      originalName: file.originalname,
      filepath: savedFile?.filepath || null,
      mimeType: fileType.mime,
      size: file.buffer.length,
      uploadedAt: new Date().toISOString(),
      textLength: cleanedText.length,
      processingTime: Date.now() - startTime,
      jobId: jobId,
      priority: priority || 'normal'
    };
    
    // ✅ CLEANUP AND STATS
    const memoryAfter = getMemoryUsage();
    forceCleanup();
    
    processedCount++;
    totalProcessingTime += (Date.now() - startTime);
    
    logger.info('CV processing completed successfully', {
      identifier: identifier.substring(0, 6) + '***',
      jobId: jobId,
      processingTime: (Date.now() - startTime) + 'ms',
      textLength: cleanedText.length,
      memoryBefore: memoryBefore.usedMB + 'MB',
      memoryAfter: memoryAfter.usedMB + 'MB',
      saved: savedFile ? 'yes' : 'no'
    });
    
    return {
      text: cleanedText,
      metadata: metadata,
      success: true,
      processingTime: Date.now() - startTime
    };
    
  } catch (error) {
    failedCount++;
    forceCleanup(); // Cleanup on error too
    
  await sendFailureEmailToAdmin(identifier, 'CV_PROCESSING_FAILED', {
      error: error.message,
      jobId: jobId,
      fileName: file.originalname,
      fileSize: file.buffer?.length || 0,
      processingTime: Date.now() - startTime,
      needsImmediateContact: error.message.includes('memory') || error.message.includes('timeout')
    });
    
   
     logger.error('CV processing failed', {
      identifier: identifier.substring(0, 6) + '***',
      jobId: jobId,
      error: error.message,
      processingTime: (Date.now() - startTime) + 'ms'
    });
    
    throw error;
  }
}, {
  // ✅ OPTIMIZED WORKER SETTINGS
  connection: queueRedis,
  prefix: 'queue:',
  concurrency: CONCURRENCY,
  settings: {
    retryProcessDelay: 3000,
    maxStalledCount: 2,
    stalledInterval: 30000
  },
  removeOnComplete: 20,
  removeOnFail: 10
});

// ================================
// ✅ EVENT HANDLERS
// ================================

cvWorker.on('completed', (job, result) => {
  logger.info('CV job completed', {
    jobId: job.id,
    identifier: job.data?.identifier?.substring(0, 6) + '***',
    processingTime: result?.processingTime || 0
  });
});

cvWorker.on('failed', (job, error) => {
  logger.error('CV job failed', {
    jobId: job.id,
    identifier: job.data?.identifier?.substring(0, 6) + '***',
    error: error.message
  });
});

cvWorker.on('stalled', (jobId) => {
  logger.warn('CV job stalled', { jobId });
});

// ================================
// ✅ MONITORING & HEALTH CHECKS
// ================================

// Memory monitoring every 5 seconds
setInterval(() => {
  checkMemoryHealth();
}, MEMORY_CHECK_INTERVAL);

// Performance stats every 2 minutes
setInterval(() => {
  if (processedCount > 0) {
    const avgTime = Math.round(totalProcessingTime / processedCount);
    const successRate = Math.round(((processedCount - failedCount) / processedCount) * 100);
    const memory = getMemoryUsage();
    
    logger.info('CV Worker Performance', {
      processed: processedCount,
      failed: failedCount,
      avgTime: avgTime + 'ms',
      successRate: successRate + '%',
      memory: memory.usedMB + 'MB (' + memory.percentage + '%)',
      concurrency: CONCURRENCY,
      estimatedCapacity: Math.round((3600000 / avgTime) * CONCURRENCY) + ' CVs/hour'
    });
  }
}, 120000);

// Health check every minute
setInterval(() => {
  const memory = getMemoryUsage();
  const uptime = Math.round(process.uptime() / 60);
  
  logger.info('CV Worker Health', {
    memory: memory.usedMB + 'MB (' + memory.percentage + '%)',
    processed: processedCount,
    failed: failedCount,
    uptime: uptime + ' minutes',
    status: memory.percentage > 90 ? 'critical' : memory.percentage > 75 ? 'warning' : 'healthy'
  });
}, 60000);

// ================================
// ✅ GRACEFUL SHUTDOWN
// ================================

async function gracefulShutdown(signal) {
  logger.info(`CV Worker received ${signal}, shutting down gracefully`);
  
  try {
    await cvWorker.close();
    logger.info('CV Worker closed successfully');
    process.exit(0);
  } catch (error) {
    logger.error('CV Worker shutdown error', { error: error.message });
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ================================
// ✅ STARTUP MESSAGE
// ================================

logger.info('🚀 CV Worker started successfully!', {
  concurrency: CONCURRENCY,
  maxMemoryPercent: MAX_MEMORY_PERCENT,
  maxAbsoluteMemoryMB: MAX_ABSOLUTE_MEMORY_MB,
  uploadsDir: uploadsDir,
  memoryCheckInterval: MEMORY_CHECK_INTERVAL + 'ms',
  estimatedCapacity: (CONCURRENCY * 60) + ' CVs/hour',
  nodeVersion: process.version
});

module.exports = cvWorker;