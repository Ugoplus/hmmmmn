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

const cvWorker = new Worker('cv-processing', async (job) => {
  const { file, identifier } = job.data;
  
  try {
    logger.info('Processing CV with file storage', { 
      identifier, 
      filename: file.originalname,
      size: file.buffer.length 
    });

    // Detect file type
    const fileType = await import('file-type');
    let detectedType = await fileType.fileTypeFromBuffer(file.buffer);

    if (!detectedType && file.originalname) {
      const ext = file.originalname.toLowerCase().split('.').pop();
      if (ext === 'pdf') {
        detectedType = { mime: 'application/pdf', ext: 'pdf' };
      } else if (ext === 'docx') {
        detectedType = { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' };
      }
    }

    // Generate unique filename
    const timestamp = Date.now();
    const safeIdentifier = identifier.replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `cv_${safeIdentifier}_${timestamp}.pdf`;
    const filepath = path.join(uploadsDir, filename);

    // Save file to disk
    fs.writeFileSync(filepath, file.buffer);

    // Extract text
    let extractedText;
    
    if (detectedType?.mime === 'application/pdf') {
      const pdfData = await pdfParse(file.buffer);
      extractedText = pdfData.text;
    } else {
      const wordResult = await mammoth.extractRawText({ buffer: file.buffer });
      extractedText = wordResult.value;
    }

    if (!extractedText || extractedText.trim().length < 50) {
      fs.unlinkSync(filepath);
      throw new Error('Could not extract text from CV');
    }

    // Clean text
    const cleanedText = extractedText
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\s{2,}/g, ' ')
      .trim();

    // Store both text and filename (24 hour expiry)
    await redis.set(`cv_text:${identifier}`, cleanedText, 'EX', 86400);
    await redis.set(`cv_file:${identifier}`, filename, 'EX', 86400);

    logger.info('CV processing completed', { identifier, filename });

    return cleanedText;

  } catch (error) {
    logger.error('CV processing failed', { identifier, error: error.message });
    throw new Error('Failed to process CV');
  }
}, { 
  connection: redis,
  concurrency: 2
});

cvWorker.on('completed', (job) => {
  logger.info('CV processing completed', { jobId: job.id });
});

cvWorker.on('failed', (job, error) => {
  logger.error('CV processing failed', { jobId: job.id, error: error.message });
});

module.exports = cvWorker;