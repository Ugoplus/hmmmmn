const { Worker } = require('bullmq');
const axios = require('axios');
const redis = require('../config/redis');
const logger = require('../utils/logger');

function parseJSON(raw, fallback = {}) {
  try {
    let cleaned = raw.trim();
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }
    return JSON.parse(cleaned);
  } catch (err) {
    logger.error('JSON parse failed:', { raw, error: err.message });
    return fallback;
  }
}



// Together AI function
async function callTogetherAI(messages) {
  try {
    const response = await axios.post(
      'https://api.together.xyz/v1/chat/completions',
      {
        model: 'Qwen/Qwen2.5-72B-Instruct-Turbo', // Fast, reliable model
        messages: messages,
        temperature: 0.1,
        max_tokens: 1000
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.TOGETHER_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    return response.data.choices[0].message.content;
  } catch (error) {
    logger.error('Together AI failed', { error: error.message });
    throw error;
  }
}

// Enhanced pattern matching
function parseMessage(message) {
  const text = message.toLowerCase().trim();

  // Reset command
  if (text.includes('reset') || text.includes('clear')) {
    return { action: 'reset', response: 'Resetting your session...' };
  }

  // Status/usage check
  if (text.includes('status') || text.includes('usage') || text === 'my status') {
    return { action: 'status', response: 'Checking your status...' };
  }

  // Greetings
  if (text.match(/^(hello|hi|hey|start|good morning|good afternoon|good evening)$/)) {
    return { action: 'greeting', response: 'Hello! Welcome to SmartCVNaija!' };
  }

  // Help
  if (text.includes('help') || text.includes('command')) {
    return { action: 'help', response: 'Here are the available commands...' };
  }

  // Job applications
  if (text.includes('apply')) {
    const jobNumbers = [];
    const matches = text.match(/\b(\d+)\b/g);
    if (matches) {
      jobNumbers.push(...matches.map(n => parseInt(n)).filter(n => n > 0 && n <= 10));
    }

    return {
      action: 'apply_job',
      applyAll: text.includes('all'),
      jobNumbers: jobNumbers.length > 0 ? jobNumbers : null
    };
  }

  // Job searches
  if (text.includes('find') || text.includes('search') || text.includes('job') || text.includes('looking')) {
    const filters = {};

    // Nigerian locations
    const locations = ['lagos', 'abuja', 'ibadan', 'kano', 'port harcourt', 'benin', 'jos', 'kaduna', 'rivers', 'edo', 'oyo'];
    for (const location of locations) {
      if (text.includes(location)) {
        filters.location = location.charAt(0).toUpperCase() + location.slice(1);
        break;
      }
    }

    // Job types
    if (text.includes('remote')) filters.remote = true;
    if (text.includes('developer') || text.includes('programming')) filters.title = 'developer';
    if (text.includes('designer')) filters.title = 'designer';
    if (text.includes('manager')) filters.title = 'manager';
    if (text.includes('marketing')) filters.title = 'marketing';
    if (text.includes('sales')) filters.title = 'sales';

    return {
      action: 'search_jobs',
      filters: filters
    };
  }

  return { action: 'unknown' };
}

const worker = new Worker(
  'openai-tasks',
  async (job) => {
    try {
      if (job.name === 'parse-query') {
        const message = job.data.message;
        
        // Try pattern matching first (faster)
        const simpleResult = parseMessage(message);
        if (simpleResult.action !== 'unknown') {
          return simpleResult;
        }

        // Try Together AI for complex queries
        if (process.env.TOGETHER_API_KEY) {
          try {
            const prompt = [
              {
                role: 'system',
                content: `You are SmartCVNaija assistant. Parse queries and return JSON:
{
  "action": "search_jobs" | "apply_job" | "greeting" | "help" | "status" | "unknown",
  "filters": {"title": "job title", "location": "Nigerian city", "remote": true/false},
  "applyAll": true/false,
  "jobNumbers": [1,2,3] or null,
  "response": "helpful response"
}`
              },
              { role: 'user', content: message }
            ];

            const result = await callTogetherAI(prompt);
            return JSON.parse(result);
          } catch (error) {
            logger.warn('Together AI failed, using fallback');
          }
        }

        // Fallback
        return {
          action: 'greeting',
          response: 'Hi! Try "find jobs in Lagos" or "help" for commands.'
        };

      }
      else if (job.name === 'analyze-cv') {
  const cvText = job.data.cvText;
  const jobTitle = job.data.jobTitle || null;
  
  if (!cvText) {
    return {
      skills: 0, experience: 0, education: 0,
      summary: 'No CV text provided for analysis'
    };
  }

  // Try AI analysis first
  if (process.env.TOGETHER_API_KEY) {
    try {
      const prompt = [
        {
          role: 'system',
          content: `You are a Nigerian HR expert. Analyze this CV and return JSON:
{
  "overall_score": number (0-100),
  "job_match_score": number (0-100),
  "skills_score": number (0-100),
  "experience_score": number (0-100),
  "education_score": number (0-100),
  "experience_years": number,
  "key_skills": ["skill1", "skill2", "skill3"],
  "relevant_skills": ["relevant1", "relevant2"],
  "education_level": "Bachelor's|Master's|PhD|Diploma|Secondary|Other",
  "summary": "brief professional summary",
  "strengths": ["strength1", "strength2", "strength3"],
  "areas_for_improvement": ["area1", "area2"],
  "recommendation": "Strong|Good|Average|Weak",
  "cv_quality": "Excellent|Good|Average|Poor"
}

Focus on Nigerian job market standards. Analyze:
- How well the CV matches the specific job requirements
- Skills relevance to the position
- Experience level appropriateness
- CV presentation quality
- Professional development indicators

DO NOT estimate salary ranges. Focus only on job fit and CV quality.`
        },
        { 
          role: 'user', 
          content: `Analyze this CV${jobTitle ? ` for ${jobTitle} position` : ''}:\n\n${cvText.substring(0, 3000)}` 
        }
      ];

      const result = await callTogetherAI(prompt);
      const analysis = parseJSON(result, null);
      
      if (analysis && analysis.overall_score) {
        return analysis;
      }
    } catch (error) {
      logger.error('AI CV analysis failed', { error: error.message });
    }
  }

  // Fallback analysis using pattern matching
  return performFallbackCVAnalysis(cvText, jobTitle);
}
  } // <-- Close the 'if (job.name === 'analyze-cv')' block

} else if (job.name === 'generate-cover-letter') {
        const cvText = job.data.cvText;
        
        if (process.env.TOGETHER_API_KEY) {
          try {
            const prompt = [
              {
                role: 'system',
                content: 'Write a professional Nigerian cover letter, 150-200 words.'
              },
              { role: 'user', content: `Cover letter for: ${cvText.substring(0, 1000)}` }
            ];

            const result = await callTogetherAI(prompt);
            return result;
          } catch (error) {
            // Fallback cover letter
          }
        }

        return `Dear Hiring Manager,

I am writing to express my strong interest in this position. My background and experience make me well-suited for this role.

I am excited about the opportunity to contribute to your organization's success in Nigeria's dynamic market.

Please find my CV attached for your review.

Best regards,
[Your Name]`;
      }

    } catch (error) {
      logger.error('Worker job failed', { error: error.message });
      return { action: 'unknown', response: 'Error processing request' };
    }
  },
  { connection: redis, concurrency: 3 }
);

module.exports = worker;  },
  { connection: redis, concurrency: 3 }
);

// Updated fallback CV analysis function (no salary)
function performFallbackCVAnalysis(cvText, jobTitle = null) {
  const text = cvText.toLowerCase();
  let overallScore = 50; // Base score
  let jobMatchScore = 50; // Base job match

  // Skills analysis
  const techSkills = ['javascript', 'python', 'java', 'react', 'node', 'sql', 'html', 'css', 'php', 'angular', 'vue'];
  const businessSkills = ['management', 'leadership', 'analysis', 'strategy', 'planning', 'communication'];
  const foundSkills = [];
  const relevantSkills = [];
  
  techSkills.forEach(skill => {
    if (text.includes(skill)) {
      foundSkills.push(skill);
      overallScore += 3;
      // Check if skill is relevant to job title
      if (jobTitle && (jobTitle.toLowerCase().includes('developer') || jobTitle.toLowerCase().includes('programmer'))) {
        relevantSkills.push(skill);
        jobMatchScore += 5;
      }
    }
  });
  
  businessSkills.forEach(skill => {
    if (text.includes(skill)) {
      foundSkills.push(skill);
      overallScore += 2;
      // Check if skill is relevant to job title
      if (jobTitle && (jobTitle.toLowerCase().includes('manager') || jobTitle.toLowerCase().includes('lead'))) {
        relevantSkills.push(skill);
        jobMatchScore += 4;
      }
    }
  });

  // Experience analysis
  const experienceYears = extractExperienceYears(text);
  let experienceScore = Math.min(experienceYears * 10, 100);
  
  if (experienceYears >= 5) overallScore += 10;
  if (experienceYears >= 3) overallScore += 5;

  // Job-specific experience matching
  if (jobTitle) {
    const jobKeywords = jobTitle.toLowerCase().split(' ');
    jobKeywords.forEach(keyword => {
      if (text.includes(keyword)) {
        jobMatchScore += 8;
      }
    });
  }

  // Education analysis
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
  } else if (text.includes('bachelor') || text.includes('bsc') || text.includes('ba ') || text.includes('beng')) {
    educationScore = 75;
    educationLevel = 'Bachelor\'s';
    overallScore += 5;
  } else if (text.includes('diploma') || text.includes('hnd')) {
    educationScore = 60;
    educationLevel = 'Diploma';
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
  if (text.length < 300 || (!hasContact && !hasPhone)) {
    cvQuality = 'Poor';
    overallScore -= 10;
  }

  // Areas for improvement instead of red flags
  const areasForImprovement = [];
  if (text.length < 500) areasForImprovement.push('CV could be more detailed');
  if (!hasContact) areasForImprovement.push('Missing contact email');
  if (!hasPhone) areasForImprovement.push('Missing phone number');
  if (foundSkills.length < 3) areasForImprovement.push('Could highlight more relevant skills');
  if (experienceYears < 1) areasForImprovement.push('Consider adding internship or project experience');

  // Strengths identification
  const strengths = [];
  if (foundSkills.length >= 5) strengths.push('Strong technical skill set');
  if (experienceYears >= 5) strengths.push('Extensive professional experience');
  if (educationScore >= 75) strengths.push('Strong educational background');
  if (text.includes('award') || text.includes('certification')) strengths.push('Professional achievements');
  if (cvQuality === 'Excellent') strengths.push('Well-structured CV presentation');

  // Overall recommendation
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
    relevant_skills: relevantSkills.slice(0, 3),
    education_level: educationLevel,
    summary: `Professional with ${experienceYears} years experience and ${educationLevel} education`,
    strengths: strengths.slice(0, 4),
    areas_for_improvement: areasForImprovement.slice(0, 3),
    recommendation: recommendation,
    cv_quality: cvQuality
  };
}

function extractExperienceYears(text) {
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

module.exports = worker;