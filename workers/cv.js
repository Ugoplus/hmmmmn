// workers/cv.js - OPTIMIZED FOR 1000+ USERS

const { Worker } = require('bullmq');
const { queueRedis } = require('../config/redis');
const config = require('../config');
const logger = require('../utils/logger');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const fs = require('fs');
const path = require('path');

// Ensure uploads directory exists
const uploadsDir = './uploads';
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  logger.info('Created uploads directory');
}

// ✅ SCALED SETTINGS FOR 1000+ USERS
const OPTIMAL_CONCURRENCY = 30; // Increased from 12 to 30
const MAX_MEMORY_USAGE = 12;    // Use 12GB of 16GB RAM
const MEMORY_CHECK_INTERVAL = 15000; // Check every 15 seconds

// Enhanced CV worker with high concurrency and memory management
const cvWorker = new Worker('cv-processing', async (job) => {
  const { file, identifier, jobId, priority } = job.data;
  
  try {
    // Memory monitoring at job start
    const startMemory = process.memoryUsage();
    logger.info('Starting CV processing', { 
      identifier, 
      jobId,
      priority: priority || 'normal',
      filename: file.originalname,
      size: file.buffer?.length || 0,
      currentMemory: Math.round(startMemory.heapUsed / 1024 / 1024) + 'MB'
    });

    // Step 1: Validation (10%)
    await job.updateProgress(100);
    
    // Memory cleanup after processing
    const endMemory = process.memoryUsage();
    const memoryUsed = endMemory.heapUsed - startMemory.heapUsed;
    
    logger.info('CV processing completed', { 
      identifier, 
      jobId,
      textLength: cleanedText.length,
      processingTime: Date.now() - timestamp,
      memoryUsed: Math.round(memoryUsed / 1024 / 1024) + 'MB',
      finalMemory: Math.round(endMemory.heapUsed / 1024 / 1024) + 'MB'
    });

    return {
      text: cleanedText,
      metadata: cvMetadata,
      success: true,
      processingTime: Date.now() - timestamp
    };

  } catch (error) {
    logger.error('CV processing failed', { 
      identifier, 
      jobId,
      error: error.message
    });
    throw error;
  }
}, { 
  connection: queueRedis,
  concurrency: OPTIMAL_CONCURRENCY, // 30 concurrent CV processing
  settings: {
    retryProcessDelay: 2000,
    maxStalledCount: 3,
    stalledInterval: 30000,
    maxFailedJobs: 100,
    maxCompletedJobs: 200
  },
  removeOnComplete: 50,
  removeOnFail: 25
});

// ================================
// OPTIMIZED TEXT EXTRACTION
// ================================

function detectFileType(buffer, filename) {
  try {
    // PDF signature check
    if (buffer.subarray(0, 4).toString() === '%PDF') {
      return { mime: 'application/pdf', ext: 'pdf' };
    }
    
    // ZIP-based formats (DOCX)
    const zipSignature = buffer.subarray(0, 4);
    if (zipSignature[0] === 0x50 && zipSignature[1] === 0x4B && 
        (zipSignature[2] === 0x03 || zipSignature[2] === 0x05)) {
      const bufferStr = buffer.toString('binary', 0, Math.min(buffer.length, 1000));
      if (bufferStr.includes('word/')) {
        return { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' };
      }
    }
    
    // Fallback to filename extension
    if (filename) {
      const ext = filename.toLowerCase().split('.').pop();
      switch (ext) {
        case 'pdf': return { mime: 'application/pdf', ext: 'pdf' };
        case 'docx': return { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' };
        case 'doc': return { mime: 'application/msword', ext: 'doc' };
        default: return null;
      }
    }
    return null;
  } catch (error) {
    logger.error('File type detection failed', { error: error.message });
    return null;
  }
}

async function extractTextFromFileOptimized(buffer, detectedType) {
  try {
    if (detectedType.mime === 'application/pdf') {
      // ✅ Optimized PDF parsing with memory limits
      const pdfData = await pdfParse(buffer, { 
        max: 0,              // Process all pages
        version: 'v1.10.100' // Use stable version
      });
      return pdfData.text;
      
    } else if (detectedType.mime.includes('wordprocessingml') || detectedType.ext === 'docx') {
      // ✅ Optimized DOCX parsing
      const result = await mammoth.extractRawText({ 
        buffer: buffer,
        options: {
          includeEmbeddedStyleMap: false,
          includeDefaultStyleMap: false
        }
      });
      return result.value;
      
    } else if (detectedType.mime === 'application/msword' || detectedType.ext === 'doc') {
      // ✅ DOC file handling
      const result = await mammoth.extractRawText({ buffer: buffer });
      return result.value;
      
    } else {
      throw new Error(`Unsupported file type: ${detectedType.mime}`);
    }
  } catch (error) {
    logger.error('Text extraction failed', { error: error.message, type: detectedType });
    throw error;
  }
}

function cleanExtractedText(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return '';
  }
  
  return rawText
    // Normalize line endings
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    
    // Remove excessive whitespace
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s{2,}/g, ' ')
    .replace(/\t+/g, ' ')
    
    // Remove control characters
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    
    // Fix punctuation spacing
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/([,.!?;:])\s+/g, '$1 ')
    
    // Remove extra spaces and trim
    .replace(/\s+/g, ' ')
    .trim();
}

// ================================
// MEMORY MANAGEMENT SYSTEM
// ================================

// Global memory monitoring
let memoryWarningCount = 0;
const MAX_MEMORY_WARNINGS = 3;

function checkMemoryUsage() {
  const memUsage = process.memoryUsage();
  const memoryUsageGB = memUsage.heapUsed / (1024 * 1024 * 1024);
  const memoryUsagePercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;
  
  if (memoryUsageGB > MAX_MEMORY_USAGE) {
    memoryWarningCount++;
    
    logger.warn('High memory usage detected', {
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB',
      percentage: Math.round(memoryUsagePercent) + '%',
      warningCount: memoryWarningCount
    });
    
    // Force garbage collection if available
    if (global.gc) {
      global.gc();
      logger.info('Forced garbage collection triggered');
    }
    
    // If memory warnings persist, reduce concurrency temporarily
    if (memoryWarningCount >= MAX_MEMORY_WARNINGS) {
      logger.error('Critical memory usage - consider reducing load', {
        currentMemoryGB: Math.round(memoryUsageGB * 100) / 100,
        maxMemoryGB: MAX_MEMORY_USAGE
      });
      memoryWarningCount = 0; // Reset counter
    }
  } else {
    // Reset warning count if memory usage is normal
    if (memoryWarningCount > 0) {
      memoryWarningCount = Math.max(0, memoryWarningCount - 1);
    }
  }
}

// ================================
// PERFORMANCE MONITORING
// ================================

let processedCount = 0;
let totalProcessingTime = 0;
let failedCount = 0;

function logPerformanceStats() {
  if (processedCount > 0) {
    const avgProcessingTime = Math.round(totalProcessingTime / processedCount);
    const successRate = Math.round(((processedCount - failedCount) / processedCount) * 100);
    
    logger.info('CV Worker Performance Stats', {
      totalProcessed: processedCount,
      averageProcessingTime: avgProcessingTime + 'ms',
      successRate: successRate + '%',
      failedCount: failedCount,
      currentConcurrency: OPTIMAL_CONCURRENCY,
      estimatedHourlyCapacity: Math.round((3600000 / avgProcessingTime) * OPTIMAL_CONCURRENCY)
    });
  }
}

// ================================
// WORKER EVENT HANDLERS
// ================================

cvWorker.on('completed', (job, result) => {
  processedCount++;
  if (result?.processingTime) {
    totalProcessingTime += result.processingTime;
  }
  
  logger.info('CV processing completed', { 
    jobId: job.id,
    identifier: job.data.identifier,
    processingTime: result?.processingTime || 0,
    textLength: result?.text?.length || 0
  });
});

cvWorker.on('failed', (job, error) => {
  failedCount++;
  
  logger.error('CV processing failed', { 
    jobId: job.id,
    identifier: job.data?.identifier,
    error: error.message,
    attempts: job.attemptsMade
  });
});

cvWorker.on('progress', (job, progress) => {
  if (progress % 25 === 0) { // Log every 25% progress
    logger.info('CV processing progress', { 
      jobId: job.id,
      identifier: job.data?.identifier,
      progress: `${progress}%`
    });
  }
});

cvWorker.on('stalled', (jobId) => {
  logger.warn('CV processing job stalled', { jobId });
});

// ================================
// MONITORING INTERVALS
// ================================

// Memory monitoring every 15 seconds
setInterval(checkMemoryUsage, MEMORY_CHECK_INTERVAL);

// Performance stats every 5 minutes
setInterval(logPerformanceStats, 300000);

// System health check every minute
setInterval(() => {
  const memUsage = process.memoryUsage();
  const memPercent = Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100);
  
  logger.info('CV Worker Health Check', {
    memoryUsage: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
    memoryPercent: memPercent + '%',
    processedJobs: processedCount,
    failedJobs: failedCount,
    uptime: Math.round(process.uptime() / 60) + ' minutes'
  });
}, 60000);

// ================================
// GRACEFUL SHUTDOWN
// ================================

process.on('SIGTERM', async () => {
  logger.info('CV Worker received SIGTERM, starting graceful shutdown');
  await cvWorker.close();
  logger.info('CV Worker shutdown completed');
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('CV Worker received SIGINT, starting graceful shutdown');
  await cvWorker.close();
  logger.info('CV Worker shutdown completed');
  process.exit(0);
});

// ================================
// STARTUP LOGGING
// ================================

logger.info(`🚀 Scaled CV Worker started with high-performance settings!`, {
  concurrency: OPTIMAL_CONCURRENCY,
  maxMemoryGB: MAX_MEMORY_USAGE,
  memoryCheckInterval: MEMORY_CHECK_INTERVAL,
  estimatedCapacity: (OPTIMAL_CONCURRENCY * 60) + ' CVs/hour',
  nodeVersion: process.version,
  platform: process.platform
});

module.exports = cvWorker;(10);
    
    if (!file || !file.buffer) {
      throw new Error('No file buffer provided');
    }

    if (file.buffer.length > 5 * 1024 * 1024) {
      throw new Error('File size exceeds 5MB limit');
    }

    if (file.buffer.length < 100) {
      throw new Error('File is too small to be a valid document');
    }

    // Step 2: File type detection (20%)
    await job.updateProgress(20);
    
    let detectedType = detectFileType(file.buffer, file.originalname);
    if (!detectedType) {
      throw new Error('Unsupported file type. Please upload PDF, DOCX, or DOC files only.');
    }

    // Step 3: Text extraction with memory optimization (60%)
    await job.updateProgress(40);
    
    const extractedText = await extractTextFromFileOptimized(file.buffer, detectedType);
    if (!extractedText || extractedText.trim().length < 50) {
      throw new Error('Could not extract meaningful text from the CV.');
    }

    // Step 4: Text processing and cleanup (80%)
    await job.updateProgress(80);
    
    const cleanedText = cleanExtractedText(extractedText);
    if (cleanedText.length < 100) {
      throw new Error('CV text is too short. Please upload a complete CV.');
    }

    // Step 5: Save and finalize (100%)
    await job.updateProgress(95);

    // Generate filename
    const timestamp = Date.now();
    const safeIdentifier = identifier.replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `cv_${safeIdentifier}_${timestamp}.${detectedType.ext}`;
    const filepath = path.join(uploadsDir, filename);

    // Save file to disk (for email attachments)
    try {
      fs.writeFileSync(filepath, file.buffer);
      logger.info('File saved to disk', { identifier, filepath });
    } catch (fileError) {
      logger.warn('Failed to save file to disk', { identifier, error: fileError.message });
    }

    // Store CV metadata
    const cvMetadata = {
      filename: filename,
      originalName: file.originalname,
      filepath: filepath,
      mimeType: detectedType.mime,
      size: file.buffer.length,
      uploadedAt: new Date().toISOString(),
      textContent: cleanedText,
      processingStatus: 'completed',
      textLength: cleanedText.length,
      jobId: jobId,
      priority: priority || 'normal'
    };

    await job.updateProgress