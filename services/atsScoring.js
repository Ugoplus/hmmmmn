// services/atsScoring.js - ATS compatibility scoring with AI analysis

const { Queue } = require('bullmq');
const { queueRedis } = require('../config/redis');
const dbManager = require('../config/database');
const logger = require('../utils/logger');

// Dedicated ATS scoring queue (can run slowly in background)
const atsQueue = new Queue('ats-scoring', {
  connection: queueRedis,
  prefix: 'queue:',
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000
    },
    removeOnComplete: {
      age: 86400, // Keep for 24 hours
      count: 100
    },
    removeOnFail: {
      age: 86400,
      count: 50
    }
  }
});

class ATSScoringService {
  constructor() {
    this.maxProcessingTime = 20 * 60 * 60 * 1000; // 20 hours max
  }

  /**
   * Queue ATS scoring for an application (after payment confirmed)
   */
  async queueScoring(applicationId, userId, jobId, cvText) {
    try {
      // Create ATS score record
      const result = await dbManager.query(`
        INSERT INTO ats_scores (
          application_id, user_identifier, job_id, processing_status
        ) VALUES ($1, $2, $3, 'pending')
        RETURNING id
      `, [applicationId, userId, jobId]);

      const atsScoreId = result.rows[0].id;

      // Queue for processing
      const job = await atsQueue.add(
        'calculate-ats-score',
        {
          atsScoreId,
          applicationId,
          userId,
          jobId,
          cvText
        },
        {
          jobId: `ats-${atsScoreId}`,
          delay: 5000, // Start after 5 seconds
          priority: 5 // Lower priority (can wait)
        }
      );

      logger.info('ATS scoring queued', {
        atsScoreId,
        applicationId,
        userId: userId.substring(0, 6) + '***',
        jobId: job.id
      });

      return {
        atsScoreId,
        status: 'queued',
        message: 'ATS score will be available within 24 hours'
      };

    } catch (error) {
      logger.error('Failed to queue ATS scoring', {
        applicationId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Calculate ATS score (runs in worker)
   */
  async calculateScore(atsScoreId, applicationId, userId, jobId, cvText) {
    const startTime = Date.now();

    try {
      // Update status to processing
      await dbManager.query(`
        UPDATE ats_scores
        SET processing_status = 'processing', updated_at = NOW()
        WHERE id = $1
      `, [atsScoreId]);

      // Get job details
      const jobResult = await dbManager.query(`
        SELECT title, description, requirements, experience, category
        FROM jobs
        WHERE id = $1
      `, [jobId]);

      if (jobResult.rows.length === 0) {
        throw new Error('Job not found');
      }

      const job = jobResult.rows[0];

      // Analyze CV against job using AI
      const analysis = await this.analyzeWithAI(cvText, job);

      // Calculate overall score
      const overallScore = this.calculateOverallScore(analysis);

      // Save results
      await dbManager.query(`
        UPDATE ats_scores
        SET 
          overall_score = $1,
          matched_keywords = $2,
          missing_keywords = $3,
          skill_match_score = $4,
          experience_match_score = $5,
          education_match_score = $6,
          strengths = $7,
          weaknesses = $8,
          recommendations = $9,
          processing_status = 'completed',
          processed_at = NOW(),
          processing_duration = $10,
          updated_at = NOW()
        WHERE id = $11
      `, [
        overallScore,
        analysis.matched_keywords,
        analysis.missing_keywords,
        analysis.skill_match_score,
        analysis.experience_match_score,
        analysis.education_match_score,
        analysis.strengths,
        analysis.weaknesses,
        analysis.recommendations,
        Date.now() - startTime,
        atsScoreId
      ]);

      logger.info('ATS score calculated successfully', {
        atsScoreId,
        overallScore,
        processingTime: Date.now() - startTime
      });

      // Notify user (optional - can send WhatsApp message)
      await this.notifyUser(userId, overallScore, applicationId);

      return {
        success: true,
        atsScoreId,
        overallScore,
        processingTime: Date.now() - startTime
      };

    } catch (error) {
      logger.error('ATS score calculation failed', {
        atsScoreId,
        error: error.message
      });

      // Update status to failed
      await dbManager.query(`
        UPDATE ats_scores
        SET 
          processing_status = 'failed',
          processing_duration = $1,
          updated_at = NOW()
        WHERE id = $2
      `, [Date.now() - startTime, atsScoreId]);

      throw error;
    }
  }

  /**
   * Analyze CV vs Job with AI
   */
  async analyzeWithAI(cvText, job) {
    try {
      // Use the openai-tasks queue
      const { Queue } = require('bullmq');
      const aiQueue = new Queue('openai-tasks', {
        connection: queueRedis,
        prefix: 'queue:'
      });

      const analysisJob = await aiQueue.add(
        'ats-analysis',
        {
          cvText,
          jobTitle: job.title,
          jobDescription: job.description,
          jobRequirements: job.requirements,
          jobExperience: job.experience,
          jobCategory: job.category
        },
        {
          attempts: 2,
          timeout: 60000 // 60 seconds
        }
      );

      // Wait for AI analysis
      const result = await analysisJob.waitUntilFinished(aiQueue.events, 65000);

      if (result && result.skill_match_score !== undefined) {
        return result;
      }

      throw new Error('Invalid AI analysis result');

    } catch (error) {
      logger.warn('AI analysis failed, using fallback', {
        error: error.message
      });

      // Fallback to rule-based analysis
      return this.analyzeWithRules(cvText, job);
    }
  }

  /**
   * Rule-based ATS analysis (fallback)
   */
  analyzeWithRules(cvText, job) {
    const cvLower = cvText.toLowerCase();
    const jobText = `${job.title} ${job.description} ${job.requirements}`.toLowerCase();

    // Extract keywords from job
    const jobKeywords = this.extractKeywords(jobText);
    
    // Find matched keywords
    const matched = jobKeywords.filter(keyword => 
      cvLower.includes(keyword.toLowerCase())
    );

    // Find missing keywords
    const missing = jobKeywords.filter(keyword => 
      !cvLower.includes(keyword.toLowerCase())
    );

    // Calculate scores
    const skillMatchScore = Math.min(100, Math.round((matched.length / jobKeywords.length) * 100));
    
    const experienceMatchScore = this.calculateExperienceMatch(cvText, job.experience);
    
    const educationMatchScore = this.calculateEducationMatch(cvText);

    // Generate strengths and weaknesses
    const strengths = [];
    const weaknesses = [];
    const recommendations = [];

    if (matched.length > 5) {
      strengths.push('Strong keyword match with job requirements');
    }
    if (experienceMatchScore > 70) {
      strengths.push('Experience level aligns with job requirements');
    }
    if (educationMatchScore > 70) {
      strengths.push('Educational qualifications meet job standards');
    }

    if (missing.length > 3) {
      weaknesses.push(`Missing ${missing.length} key skills from job requirements`);
      recommendations.push(`Consider adding: ${missing.slice(0, 3).join(', ')}`);
    }
    if (experienceMatchScore < 50) {
      weaknesses.push('Experience level may not fully meet requirements');
      recommendations.push('Highlight transferable skills and relevant projects');
    }

    return {
      matched_keywords: matched,
      missing_keywords: missing,
      skill_match_score: skillMatchScore,
      experience_match_score: experienceMatchScore,
      education_match_score: educationMatchScore,
      strengths,
      weaknesses,
      recommendations
    };
  }

  /**
   * Extract important keywords from job text
   */
  extractKeywords(text) {
    const keywords = [];
    
    // Technical skills patterns
    const techPatterns = [
      /\b(javascript|python|java|react|angular|vue|node\.?js|typescript)\b/gi,
      /\b(sql|mysql|postgresql|mongodb|redis|elasticsearch)\b/gi,
      /\b(aws|azure|gcp|docker|kubernetes|jenkins)\b/gi,
      /\b(excel|powerpoint|word|office|quickbooks|sap|erp)\b/gi,
      /\b(accounting|finance|audit|bookkeeping|financial reporting)\b/gi,
      /\b(marketing|sales|business development|crm|lead generation)\b/gi
    ];

    techPatterns.forEach(pattern => {
      const matches = text.match(pattern);
      if (matches) {
        keywords.push(...matches.map(m => m.toLowerCase()));
      }
    });

    // Remove duplicates
    return [...new Set(keywords)];
  }

  /**
   * Calculate experience match
   */
  calculateExperienceMatch(cvText, jobExperience) {
    if (!jobExperience) return 75; // Default if not specified

    const cvLower = cvText.toLowerCase();
    const expLower = jobExperience.toLowerCase();

    // Extract years from job requirement
    const jobYearsMatch = expLower.match(/(\d+)\s*(?:\+|to|-)\s*(\d+)?\s*years?/);
    const jobMinYears = jobYearsMatch ? parseInt(jobYearsMatch[1]) : 0;

    // Extract years from CV
    const cvYearsMatch = cvLower.match(/(\d+)\s*(?:\+)?\s*years?\s*(?:of\s*)?experience/);
    const cvYears = cvYearsMatch ? parseInt(cvYearsMatch[1]) : 0;

    if (cvYears >= jobMinYears) {
      return 100;
    } else if (cvYears >= jobMinYears * 0.7) {
      return 75;
    } else if (cvYears >= jobMinYears * 0.5) {
      return 50;
    } else {
      return 30;
    }
  }

  /**
   * Calculate education match
   */
  calculateEducationMatch(cvText) {
    const cvLower = cvText.toLowerCase();

    if (cvLower.includes('phd') || cvLower.includes('doctorate')) {
      return 100;
    } else if (cvLower.includes('master') || cvLower.includes('msc') || cvLower.includes('mba')) {
      return 90;
    } else if (cvLower.includes('bachelor') || cvLower.includes('bsc') || cvLower.includes('b.sc')) {
      return 80;
    } else if (cvLower.includes('hnd') || cvLower.includes('diploma')) {
      return 70;
    } else if (cvLower.includes('university') || cvLower.includes('college')) {
      return 60;
    } else {
      return 40;
    }
  }

  /**
   * Calculate overall ATS score
   */
  calculateOverallScore(analysis) {
    // Weighted average
    const weights = {
      skill: 0.4,
      experience: 0.35,
      education: 0.25
    };

    const overall = Math.round(
      (analysis.skill_match_score * weights.skill) +
      (analysis.experience_match_score * weights.experience) +
      (analysis.education_match_score * weights.education)
    );

    return Math.min(100, Math.max(0, overall));
  }

  /**
   * Notify user when ATS score is ready
   */
  async notifyUser(userId, score, applicationId) {
    try {
      // Get user's WhatsApp number and job details
      const result = await dbManager.query(`
        SELECT a.job_id, j.title, j.company
        FROM applications a
        JOIN jobs j ON a.job_id = j.id
        WHERE a.id = $1
      `, [applicationId]);

      if (result.rows.length === 0) return;

      const { title, company } = result.rows[0];

      // Send WhatsApp notification
      const ycloud = require('./ycloud');
      
      const message = 
        `✅ ATS Score Ready!\n\n` +
        `📊 Your compatibility score for:\n` +
        `${title} at ${company}\n\n` +
        `Score: ${score}%\n\n` +
        `${this.getScoreInterpretation(score)}\n\n` +
        `Reply "score details" to see full breakdown.`;

      await ycloud.sendTextMessage(userId, message);

      logger.info('ATS score notification sent', {
        userId: userId.substring(0, 6) + '***',
        score
      });

    } catch (error) {
      logger.error('Failed to notify user of ATS score', {
        userId: userId?.substring(0, 6) + '***',
        error: error.message
      });
    }
  }

  /**
   * Get score interpretation
   */
  getScoreInterpretation(score) {
    if (score >= 85) {
      return '🎯 Excellent Match! Your CV is highly compatible.';
    } else if (score >= 70) {
      return '✅ Good Match! Strong chance of passing ATS screening.';
    } else if (score >= 55) {
      return '⚠️ Fair Match. Consider updating CV with more relevant keywords.';
    } else {
      return '❌ Low Match. Significant gaps in requirements. Review job description carefully.';
    }
  }

  /**
   * Get ATS score for display
   */
  async getScore(applicationId) {
    try {
      const result = await dbManager.query(`
        SELECT 
          overall_score, matched_keywords, missing_keywords,
          skill_match_score, experience_match_score, education_match_score,
          strengths, weaknesses, recommendations, processing_status,
          processed_at, processing_duration
        FROM ats_scores
        WHERE application_id = $1
      `, [applicationId]);

      if (result.rows.length === 0) {
        return {
          available: false,
          status: 'not_requested'
        };
      }

      const score = result.rows[0];

      if (score.processing_status === 'completed') {
        return {
          available: true,
          status: 'completed',
          score: score.overall_score,
          breakdown: {
            skills: score.skill_match_score,
            experience: score.experience_match_score,
            education: score.education_match_score
          },
          matched: score.matched_keywords,
          missing: score.missing_keywords,
          strengths: score.strengths,
          weaknesses: score.weaknesses,
          recommendations: score.recommendations,
          processedAt: score.processed_at,
          processingTime: score.processing_duration
        };
      } else {
        return {
          available: false,
          status: score.processing_status,
          message: 'Your ATS score is being calculated. Check back soon!'
        };
      }

    } catch (error) {
      logger.error('Failed to get ATS score', {
        applicationId,
        error: error.message
      });
      return {
        available: false,
        status: 'error',
        message: 'Failed to retrieve ATS score'
      };
    }
  }
}

module.exports = new ATSScoringService();