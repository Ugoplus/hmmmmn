// workers/cv.js - OPTIMIZED FOR 4 CPU + 16GB RAM

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

// OPTIMAL SETTINGS FOR YOUR HARDWARE
const OPTIMAL_CONCURRENCY = 12; // 3x your CPU cores
const MAX_MEMORY_USAGE = 12; // Use 12GB of your 16GB (leave 4GB for OS)

// Enhanced CV worker with high concurrency
const cvWorker = new Worker('cv-processing', async (job) => {
  const { file, identifier, jobId } = job.data;
  
  try {
    // Memory monitoring
    const memUsage = process.memoryUsage();
    logger.info('Starting CV processing', { 
      identifier, 
      jobId,
      filename: file.originalname,
      size: file.buffer?.length || 0,
      currentMemory: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB'
    });

    // Step 1: Validation (10%)
    await job.updateProgress(10);
    
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

    // Step 3: Text extraction (60%)
    await job.updateProgress(40);
    
    const extractedText = await extractTextFromFile(file.buffer, detectedType);
    if (!extractedText || extractedText.trim().length < 50) {
      throw new Error('Could not extract meaningful text from the CV.');
    }

    // Step 4: Text processing (80%)
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

    // Save file to disk (optional, for email attachments)
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
      jobId: jobId
    };

    await job.updateProgress(100);
    
    logger.info('CV processing completed', { 
      identifier, 
      jobId,
      textLength: cleanedText.length,
      processingTime: Date.now() - timestamp,
      finalMemory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB'
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
  concurrency: OPTIMAL_CONCURRENCY, // 12 concurrent CV processing
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

// Helper functions
function detectFileType(buffer, filename) {
  try {
    if (buffer.subarray(0, 4).toString() === '%PDF') {
      return { mime: 'application/pdf', ext: 'pdf' };
    }
    
    const zipSignature = buffer.subarray(0, 4);
    if (zipSignature[0] === 0x50 && zipSignature[1] === 0x4B && 
        (zipSignature[2] === 0x03 || zipSignature[2] === 0x05)) {
      const bufferStr = buffer.toString('binary', 0, Math.min(buffer.length, 1000));
      if (bufferStr.includes('word/')) {
        return { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' };
      }
    }
    
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
    logger.error('Text extraction failed', { error: error.message, type: detectedType });
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

// Event handlers
cvWorker.on('completed', (job, result) => {
  logger.info('CV processing completed', { 
    jobId: job.id,
    identifier: job.data.identifier,
    processingTime: result?.processingTime || 0
  });
});

cvWorker.on('failed', (job, error) => {
  logger.error('CV processing failed', { 
    jobId: job.id,
    identifier: job.data?.identifier,
    error: error.message 
  });
});

cvWorker.on('progress', (job, progress) => {
  logger.info('CV processing progress', { 
    jobId: job.id,
    identifier: job.data?.identifier,
    progress: `${progress}%`
  });
});

// Memory monitoring
setInterval(() => {
  const memUsage = process.memoryUsage();
  const memPercent = (memUsage.heapUsed / (16 * 1024 * 1024 * 1024)) * 100;
  
  if (memPercent > 75) {
    logger.warn('High memory usage detected', {
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB',
      percentage: Math.round(memPercent) + '%'
    });
  }
}, 30000);

logger.info(`🚀 CV Worker optimized for 4 CPU cores + 16GB RAM started!`, {
  concurrency: OPTIMAL_CONCURRENCY,
  estimatedCapacity: OPTIMAL_CONCURRENCY * 60 + ' CVs/hour'
});

module.exports = cvWorker;