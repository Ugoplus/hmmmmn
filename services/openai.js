const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');
const { Queue } = require('bullmq');
const Redis = require('ioredis');

const redis = new Redis({
  host: config.get('redis.host'),
  port: config.get('redis.port'),
  password: config.get('redis.password'),
  maxRetriesPerRequest: null  // ✅ ADD THIS
});

const openaiQueue = new Queue('openai-tasks', { connection: redis });

class MistralService {
  async parseJobQuery(message) {
    try {
      const job = await openaiQueue.add('parse-query', { message });
      const result = await job.waitUntilFinished(openaiQueue);

      if (!result || typeof result !== 'object' || !result.action) {
        logger.error('Invalid parse-query result', { result });
        return {
          action: 'unknown',
          response: 'I didn\'t understand your request. Try "find jobs in Lagos" or "apply for a job".'
        };
      }

      return result;

    } catch (error) {
      logger.error('Mistral parse-query error', { error: error.message });
      return {
        action: 'unknown',
        response: 'I didn\'t understand your request. Try "find jobs in Lagos" or "apply for a job".'
      };
    }
  }

  async analyzeCV(cvText) {
    try {
      const job = await openaiQueue.add('analyze-cv', { cvText });
      const result = await job.waitUntilFinished(openaiQueue);

      if (!result || typeof result !== 'object' ||
        !('skills' in result) || !('experience' in result) || !('education' in result)) {
        logger.error('Invalid analyze-cv result', { result });
        return {
          skills: 0, experience: 0, education: 0,
          summary: 'CV analysis failed due to invalid response format'
        };
      }

      return result;

    } catch (error) {
      logger.error('Mistral CV analysis error', { error: error.message });
      return {
        skills: 0, experience: 0, education: 0,
        summary: 'CV analysis failed'
      };
    }
  }

  async generateCoverLetter(cvText) {
    try {
      const job = await openaiQueue.add('generate-cover-letter', { cvText });
      const coverLetter = await job.waitUntilFinished(openaiQueue);

      if (!coverLetter || typeof coverLetter !== 'string' || coverLetter.length < 50) {
        logger.error('Invalid cover letter result', { coverLetter });
        return `Dear Hiring Manager,

I am excited to apply for this position. My skills and experience make me a strong candidate. Please find my CV attached.

Sincerely,
[Your Name]`;
      }

      return coverLetter;

    } catch (error) {
      logger.error('Mistral cover letter generation error', { error: error.message });
      return `Dear Hiring Manager,

I am excited to apply for this position. My skills and experience make me a strong candidate. Please find my CV attached.

Sincerely,
[Your Name]`;
    }
  }
}

module.exports = new MistralService();