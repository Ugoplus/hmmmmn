const { Queue } = require('bullmq');
const redis = require('../config/redis');
const logger = require('../utils/logger');

const openaiQueue = new Queue('openai-tasks', { connection: redis });

class AIService {
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
      logger.error('Together AI parse-query error', { error: error.message });
      return {
        action: 'unknown',
        response: 'I didn\'t understand your request. Try "find jobs in Lagos" or "apply for a job".'
      };
    }
  }

  async analyzeCV(cvText, jobTitle = null) {
    try {
      const job = await openaiQueue.add('analyze-cv', { cvText, jobTitle });
      const result = await job.waitUntilFinished(openaiQueue);

      // Validate the result has the expected structure
      if (!result || typeof result !== 'object') {
        logger.error('Invalid analyze-cv result', { result });
        return this.getFallbackAnalysis(cvText, jobTitle);
      }

      // Ensure all required fields exist
      const requiredFields = [
        'overall_score', 'job_match_score', 'skills_score', 
        'experience_score', 'education_score', 'experience_years'
      ];

      for (const field of requiredFields) {
        if (!(field in result)) {
          logger.warn(`Missing field in CV analysis: ${field}`, { result });
          return this.getFallbackAnalysis(cvText, jobTitle);
        }
      }

      return result;

    } catch (error) {
      logger.error('Together AI CV analysis error', { error: error.message });
      return this.getFallbackAnalysis(cvText, jobTitle);
    }
  }

  async generateCoverLetter(cvText) {
    try {
      const job = await openaiQueue.add('generate-cover-letter', { cvText });
      const coverLetter = await job.waitUntilFinished(openaiQueue);

      if (!coverLetter || typeof coverLetter !== 'string' || coverLetter.length < 50) {
        logger.error('Invalid cover letter result', { coverLetter });
        return this.getFallbackCoverLetter();
      }

      return coverLetter;

    } catch (error) {
      logger.error('Together AI cover letter generation error', { error: error.message });
      return this.getFallbackCoverLetter();
    }
  }

  // Fallback methods for when Together AI service fails
  getFallbackAnalysis(cvText, jobTitle = null) {
    const text = cvText.toLowerCase();
    let overallScore = 50;
    let jobMatchScore = 50;

    // Basic keyword analysis
    const techSkills = ['javascript', 'python', 'java', 'react', 'node', 'sql', 'html', 'css', 'php'];
    const businessSkills = ['management', 'leadership', 'analysis', 'strategy', 'planning', 'communication'];
    const foundSkills = [];
    
    techSkills.forEach(skill => {
      if (text.includes(skill)) {
        foundSkills.push(skill);
        overallScore += 3;
      }
    });
    
    businessSkills.forEach(skill => {
      if (text.includes(skill)) {
        foundSkills.push(skill);
        overallScore += 2;
      }
    });

    // Experience estimation
    const experienceYears = this.extractExperienceYears(text);
    const experienceScore = Math.min(experienceYears * 10, 100);
    
    if (experienceYears >= 5) overallScore += 10;
    if (experienceYears >= 3) overallScore += 5;

    // Education scoring
    let educationScore = 50;
    let educationLevel = 'Other';
    
    if (text.includes('phd') || text.includes('doctorate')) {
      educationScore = 100;
      educationLevel = 'PhD';
      overallScore += 15;
    } else if (text.includes('master') || text.includes('msc') || text.includes('mba')) {
      educationScore = 85;
      educationLevel = 'Master\'s';
      overallScore += 10;
    } else if (text.includes('bachelor') || text.includes('bsc') || text.includes('ba ')) {
      educationScore = 75;
      educationLevel = 'Bachelor\'s';
      overallScore += 5;
    } else if (text.includes('diploma') || text.includes('hnd')) {
      educationScore = 60;
      educationLevel = 'Diploma';
    }

    // Job matching
    if (jobTitle) {
      const jobKeywords = jobTitle.toLowerCase().split(' ');
      jobKeywords.forEach(keyword => {
        if (text.includes(keyword)) {
          jobMatchScore += 8;
        }
      });
    }

    // CV quality assessment
    let cvQuality = 'Average';
    const hasContact = text.includes('@') || text.includes('email');
    const hasPhone = text.includes('phone') || text.includes('mobile') || text.includes('tel');
    const hasProperLength = text.length > 500 && text.length < 5000;
    
    if (hasContact && hasPhone && hasProperLength && foundSkills.length >= 3) {
      cvQuality = 'Good';
      overallScore += 5;
    }
    if (foundSkills.length >= 5 && experienceYears >= 3) {
      cvQuality = 'Excellent';
      overallScore += 10;
    }

    // Generate strengths and improvement areas
    const strengths = [];
    const areasForImprovement = [];
    
    if (foundSkills.length >= 5) strengths.push('Strong technical skill set');
    if (experienceYears >= 5) strengths.push('Extensive professional experience');
    if (educationScore >= 75) strengths.push('Strong educational background');
    if (text.includes('award') || text.includes('certification')) strengths.push('Professional achievements');
    
    if (text.length < 500) areasForImprovement.push('CV could be more detailed');
    if (!hasContact) areasForImprovement.push('Missing contact email');
    if (!hasPhone) areasForImprovement.push('Missing phone number');
    if (foundSkills.length < 3) areasForImprovement.push('Could highlight more relevant skills');

    let recommendation = 'Average';
    if (overallScore >= 80) recommendation = 'Strong';
    else if (overallScore >= 65) recommendation = 'Good';
    else if (overallScore < 50) recommendation = 'Weak';

    return {
      overall_score: Math.min(Math.max(overallScore, 0), 100),
      job_match_score: Math.min(Math.max(jobMatchScore, 0), 100),
      skills_score: Math.min(foundSkills.length * 8, 100),
      experience_score: experienceScore,
      education_score: educationScore,
      experience_years: experienceYears,
      key_skills: foundSkills.slice(0, 5),
      relevant_skills: foundSkills.filter(skill => 
        jobTitle && jobTitle.toLowerCase().includes(skill)
      ).slice(0, 3),
      education_level: educationLevel,
      summary: `Professional with ${experienceYears} years experience and ${educationLevel} education`,
      strengths: strengths.slice(0, 4),
      areas_for_improvement: areasForImprovement.slice(0, 3),
      recommendation: recommendation,
      cv_quality: cvQuality
    };
  }

  getFallbackCoverLetter() {
    return `Dear Hiring Manager,

I am writing to express my strong interest in this position. My background and experience detailed in my CV make me a qualified candidate for this role.

I am confident that my skills and professional experience would be valuable to your organization. I have a proven track record of delivering results and working effectively in dynamic environments.

I would welcome the opportunity to discuss how my experience can contribute to your team's success. Thank you for considering my application, and I look forward to hearing from you.

Best regards,
[Your Name]`;
  }

  extractExperienceYears(text) {
    // Look for experience patterns
    const patterns = [
      /(\d+)\s*years?\s*(of\s*)?experience/i,
      /(\d+)\s*yrs?\s*(of\s*)?experience/i,
      /experience.*?(\d+)\s*years?/i,
      /(\d+)\s*years?\s*in\s*/i
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        return parseInt(match[1]);
      }
    }

    // Fallback: estimate from job positions
    const jobCount = (text.match(/\b(19|20)\d{2}\b/g) || []).length;
    return Math.max(Math.floor(jobCount / 2), 0);
  }
}

module.exports = new AIService();