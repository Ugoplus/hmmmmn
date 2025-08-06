const { Worker } = require('bullmq');
const Redis = require('ioredis');
const config = require('../config');
const logger = require('../utils/logger');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');

const execPromise = util.promisify(exec);

const redis = new Redis({
  host: config.get('redis.host'),
  port: config.get('redis.port'),
  password: config.get('redis.password'),
  maxRetriesPerRequest: null  // ✅ REQUIRED for BullMQ
});


const cvWorker = new Worker('cv-processing', async (job) => {
  const { file, identifier } = job.data;
  try {
    // Fixed dynamic import
    const fileType = await import('file-type');
    const type = await fileType.fileTypeFromBuffer(file.buffer);

    if (
      ![
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      ].includes(type?.mime)
    ) {
      throw new Error('Unsupported file type');
    }

    const tempFile = `/tmp/${identifier}_${Date.now()}.${type.ext}`;
    fs.writeFileSync(tempFile, file.buffer);

    // Only scan if clamscan is available
    try {
      await execPromise(`which clamscan`);
      await execPromise(`clamscan ${tempFile}`);
    } catch (error) {
      logger.warn('ClamAV not available, skipping virus scan', { identifier });
    }

    let text;
    if (type.mime === 'application/pdf') {
      const data = await pdfParse(file.buffer);
      text = data.text;
    } else {
      const { value } = await mammoth.extractRawText({ buffer: file.buffer });
      text = value;
    }

    fs.unlinkSync(tempFile);
    return text;

  } catch (error) {
    logger.error('CV processing error', { identifier, error });
    throw error;
  }
}, { connection: redis });

cvWorker.on('completed', (job) => {
  logger.info('CV processing completed', { jobId: job.id });
});

cvWorker.on('failed', (job, err) => {
  logger.error('CV processing failed', {
    jobId: job.id,
    error: err.message
  });
});

module.exports = cvWorker;
