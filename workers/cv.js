// workers/cv.js - FIXED VERSION with better error handling

const { Worker } = require('bullmq');
const Redis = require('ioredis');
const config = require('../config');
const logger = require('../utils/logger');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const fs = require('fs');
const path = require('path');

const redis = new Redis({
  host: config.get('redis.host'),
  port: config.get('redis.port'),
  password: config.get('redis.password'),
  maxRetriesPerRequest: null
});

// Ensure uploads directory exists
const uploadsDir = './uploads';
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  logger.info('Created uploads directory');
}

// FIXED: Better file type detection
function detectFileType(buffer, filename) {
  try {
    // Check PDF magic bytes
    if (buffer.subarray(0, 4).toString() === '%PDF') {
      return { mime: 'application/pdf', ext: 'pdf' };
    }
    
    // Check DOCX magic bytes (ZIP signature)
    const zipSignature = buffer.subarray(0, 4);
    if (zipSignature[0] === 0x50 && zipSignature[1] === 0x4B && 
        (zipSignature[2] === 0x03 || zipSignature[2] === 0x05)) {
      
      // Look for DOCX specific content
      const bufferStr = buffer.toString('binary', 0, Math.min(buffer.length, 1000));
      if (bufferStr.includes('word/')) {
        return { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' };
      }
    }
    
    // Check old DOC format
    if (buffer.subarray(0, 8).includes(Buffer.from([0xD0, 0xCF, 0x11, 0xE0]))) {
      return { mime: 'application/msword', ext: 'doc' };
    }
    
    // Fallback to filename extension
    if (filename) {
      const ext = filename.toLowerCase().split('.').pop();
      switch (ext) {
        case 'pdf':
          return { mime: 'application/pdf', ext: 'pdf' };
        case 'docx':
          return { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' };
        case 'doc':
          return { mime: 'application/msword', ext: 'doc' };
        default:
          return null;
      }
    }
    
    return null;
  } catch (error) {
    logger.error('File type detection failed', { error: error.message });
    return null;
  }
}

// FIXED: Better text extraction
async function extractTextFromFile(buffer, detectedType) {
  try {
    if (detectedType.mime === 'application/pdf') {
      logger.info('Extracting text from PDF');
      const pdfData = await pdfParse(buffer, {
        max: 0, // No page limit
        version: 'v1.10.88'
      });
      return pdfData.text;
      
    } else if (detectedType.mime.includes('wordprocessingml') || detectedType.ext === 'docx') {
      logger.info('Extracting text from DOCX');
      const result = await mammoth.extractRawText({ buffer: buffer });
      return result.value;
      
    } else if (detectedType.mime === 'application/msword' || detectedType.ext === 'doc') {
      logger.info('Extracting text from DOC');
      // For old DOC files, try mammoth first
      try {
        const result = await mammoth.extractRawText({ buffer: buffer });
        return result.value;
      } catch (docError) {
        throw new Error('Old DOC format not fully supported. Please convert to PDF or DOCX.');
      }
    } else {
      throw new Error(`Unsupported file type: ${detectedType.mime}`);
    }
  } catch (error) {
    logger.error('Text extraction failed', { error: error.message, type: detectedType });
    throw error;
  }
}

// FIXED: Enhanced text cleaning
function cleanExtractedText(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return '';
  }
  
  return rawText
    // Remove excessive whitespace
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s{2,}/g, ' ')
    .replace(/\t+/g, ' ')
    // Remove special characters that might cause issues
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    // Clean up spacing around punctuation
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/([,.!?;:])\s+/g, '$1 ')
    .trim();
}

// FIXED: Main CV worker with comprehensive error handling
const cvWorker = new Worker('cv-processing', async (job) => {
  const { file, identifier } = job.data;
  
  try {
    logger.info('Starting CV processing', { 
      identifier, 
      filename: file.originalname,
      size: file.buffer?.length || 0,
      mimeType: file.mimetype 
    });

    // Validate input
    if (!file || !file.buffer) {
      throw new Error('No file buffer provided');
    }

    if (!identifier) {
      throw new Error('No identifier provided');
    }

    // File size check (5MB limit)
    if (file.buffer.length > 5 * 1024 * 1024) {
      throw new Error('File size exceeds 5MB limit');
    }

    // Minimum file size check (avoid empty files)
    if (file.buffer.length < 100) {
      throw new Error('File is too small to be a valid document');
    }

    // Detect file type with enhanced detection
    let detectedType = detectFileType(file.buffer, file.originalname);
    
    if (!detectedType) {
      throw new Error('Unsupported file type. Please upload PDF, DOCX, or DOC files only.');
    }

    logger.info('File type detected', { 
      identifier, 
      detectedType,
      originalMimeType: file.mimetype 
    });

    // Validate file type against allowed types
    const allowedTypes = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword'
    ];

    if (!allowedTypes.includes(detectedType.mime)) {
      throw new Error(`File type ${detectedType.mime} is not supported. Please use PDF or DOCX.`);
    }

    // Generate unique filename with proper extension
    const timestamp = Date.now();
    const safeIdentifier = identifier.replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `cv_${safeIdentifier}_${timestamp}.${detectedType.ext}`;
    const filepath = path.join(uploadsDir, filename);

    // Extract text from file
    logger.info('Extracting text from file', { identifier, type: detectedType.mime });
    const extractedText = await extractTextFromFile(file.buffer, detectedType);
    
    if (!extractedText || extractedText.trim().length < 50) {
      throw new Error('Could not extract meaningful text from the CV. Please ensure the file contains readable text.');
    }

    // Clean the extracted text
    const cleanedText = cleanExtractedText(extractedText);
    
    if (cleanedText.length < 100) {
      throw new Error('CV text is too short. Please upload a complete CV with your work experience and skills.');
    }

    // Save original file to disk for email attachments and backup
    try {
      fs.writeFileSync(filepath, file.buffer);
      logger.info('File saved to disk', { identifier, filepath });
    } catch (fileError) {
      logger.warn('Failed to save file to disk', { identifier, error: fileError.message });
      // Continue processing even if file save fails
    }

    // Store CV metadata in Redis (24 hour expiry)
    const cvMetadata = {
      filename: filename,
      originalName: file.originalname,
      filepath: filepath,
      mimeType: detectedType.mime,
      size: file.buffer.length,
      uploadedAt: new Date().toISOString(),
      textContent: cleanedText,
      processingStatus: 'completed',
      textLength: cleanedText.length
    };

    // Store multiple keys for different access patterns
    await Promise.all([
      redis.set(`cv:${identifier}`, JSON.stringify(cvMetadata), 'EX', 86400),
      redis.set(`cv_text:${identifier}`, cleanedText, 'EX', 86400),
      redis.set(`cv_file:${identifier}`, filename, 'EX', 86400),
      redis.set(`cv_status:${identifier}`, 'completed', 'EX', 86400)
    ]);

    logger.info('CV processing completed successfully', { 
      identifier, 
      filename,
      textLength: cleanedText.length,
      processingTime: Date.now() - timestamp
    });

    return {
      text: cleanedText,
      metadata: cvMetadata,
      success: true
    };

  } catch (error) {
    logger.error('CV processing failed', { 
      identifier, 
      error: error.message,
      stack: error.stack 
    });

    // Store error status in Redis
    try {
      await redis.set(`cv_status:${identifier}`, `error:${error.message}`, 'EX', 3600);
    } catch (redisError) {
      logger.error('Failed to store error status', { identifier, error: redisError.message });
    }

    // Re-throw with user-friendly message
    const userFriendlyMessages = {
      'Unsupported file type': 'Please upload a PDF or DOCX file only.',
      'Could not extract': 'Unable to read the CV. Please ensure it\'s a valid PDF or DOCX file.',
      'File size exceeds': 'File is too large. Please upload a CV smaller than 5MB.',
      'too short': 'CV content is too brief. Please upload a complete CV.',
      'Old DOC format': 'Please convert your DOC file to PDF or DOCX format.'
    };

    const friendlyMessage = Object.keys(userFriendlyMessages).find(key => 
      error.message.includes(key)
    );

    throw new Error(friendlyMessage ? userFriendlyMessages[friendlyMessage] : 'Failed to process CV. Please try again with a valid PDF or DOCX file.');
  }
}, { 
  connection: redis,
  concurrency: 2,
  settings: {
    retryProcessDelay: 5000,
    maxStalledCount: 3
  }
});

// Enhanced event handlers
cvWorker.on('completed', (job, result) => {
  logger.info('CV processing job completed', { 
    jobId: job.id,
    identifier: job.data.identifier,
    textLength: result?.text?.length || 0
  });
});

cvWorker.on('failed', (job, error) => {
  logger.error('CV processing job failed', { 
    jobId: job.id,
    identifier: job.data?.identifier,
    error: error.message 
  });
});

cvWorker.on('stalled', (jobId) => {
  logger.warn('CV processing job stalled', { jobId });
});

cvWorker.on('error', (error) => {
  logger.error('CV worker error', { error: error.message });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, closing CV worker');
  await cvWorker.close();
});

logger.info('CV worker started with enhanced processing capabilities');

module.exports = cvWorker;
