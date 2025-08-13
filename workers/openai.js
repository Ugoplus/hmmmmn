// workers/openai.js - PURE AI: Smart conversation worker with Redis fallback
require('dotenv').config();
const { Worker } = require('bullmq');
const axios = require('axios');
const redis = require('../config/redis');
const logger = require('../utils/logger');

function parseJSON(raw, fallback = {}) {
  try {
    let cleaned = (raw || '').trim();
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }
    return JSON.parse(cleaned);
  } catch (err) {
    logger.error('JSON parse failed', { raw: (raw || '').substring(0, 200), error: err.message });
    return fallback;
  }
}

// Smart AI conversation via Together API
async function callTogetherAI(messages) {
  try {
    if (!process.env.TOGETHER_API_KEY || process.env.TOGETHER_API_KEY.trim() === '') {
      throw new Error('TOGETHER_API_KEY not configured');
    }

    const response = await axios.post(
      'https://api.together.xyz/v1/chat/completions',
      {
        model: 'Qwen/Qwen2.5-72B-Instruct-Turbo',
        messages: messages,
        temperature: 0.8,
        max_tokens: 150,
        top_p: 0.9
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

const worker = new Worker(
  'openai-tasks',
  async (job) => {
    try {
      // ---------- parse-query / ai-conversation handler ----------
      if (job.name === 'parse-query' || job.name === 'ai-conversation') {
        const { message, userId, userContext, platform, history, timestamp } = job.data;
        
        logger.info('AI handling query', { 
          jobName: job.name,
          userId, 
          platform: platform || userContext?.platform,
          messageLength: (message || '').length 
        });

        const normalized = (message || '').toLowerCase().trim();

        // >>> EXACT quick-match the pidgin/vague pattern BEFORE any AI calls:
        if (normalized.match(/^i (dey|wan|need) find job$/)) {
          const result = {
            action: 'clarify',
            response: 'Which kind work and for where? Talk like "developer work for Lagos" or "remote job"',
            requiresSpecificity: true
          };

          try {
            if (job.id) {
              await redis.set(`job-result:${job.id}`, JSON.stringify(result), 'EX', 30);
              logger.info('Stored direct clarify result in Redis', { jobId: job.id });
            }
          } catch (err) {
            logger.error('Failed to store direct clarify result in Redis', { error: err.message });
          }

          logger.info('Handled pidgin vague pattern directly in worker', { jobId: job.id });
          return result;
        }

        // Build conversation context from userContext or history
        const conversationContext = userContext?.sessionData?.messageHistory 
          ? userContext.sessionData.messageHistory.slice(-3).join('\n')
          : history && history.length > 0 
          ? history.slice(-3).map(h => h.message).join('\n') 
          : '';

        // Smart AI prompt
        const systemPrompt = `You are SmartCVNaija, a helpful Nigerian job search assistant.
PERSONALITY: 
- Detect if user speaks pidgin, casual, or formal English
- Respond in SAME style they use
- Be brief (max 30 words)
- Be helpful and direct

YOUR MAIN JOBS:
1. Help users find jobs in Nigeria
2. ALWAYS require BOTH job type AND specific location
3. Never search without a clear location
4. Handle job applications

CORE PRICING: ₦500 for 10 daily applications

LOCATION EMPHASIS RULES:
- If user says just "developer" → Ask "Developer jobs WHERE? Lagos? Abuja? Remote?"
- If user says "marketing jobs" → Ask "Marketing jobs in which city? Lagos, Abuja, Port Harcourt?"
- NEVER use search_jobs action without BOTH job type AND location
- Always suggest 2-3 popular cities as examples

Nigerian Cities: Lagos, Abuja, Kano, Ibadan, Port Harcourt, Kaduna, Jos, Benin, Enugu, Calabar, Remote

Job Types: developer, engineer, manager, analyst, designer, marketing, sales, teacher, accountant, nurse, doctor, lawyer

RESPONSE EXAMPLES:
User: "developer" → "Developer jobs WHERE? 📍 Lagos? Abuja? Remote?"
User: "marketing jobs" → "Marketing jobs in which city? 🏙️ Lagos, Abuja, or Port Harcourt?"
User: "find jobs" → "What type of work and WHERE? Like 'developer Lagos' or 'teacher Abuja'"

CRITICAL: Only use "search_jobs" action when you have BOTH job type AND location!

ALWAYS return JSON:
{
  "action": "greeting|search_jobs|clarify|help|unknown",
  "response": "your response in user's style",
  "filters": {"title": "job", "location": "city", "remote": true/false},
  "requiresSpecificity": true/false
}`;



        let result = null;

        // Try AI if API key exists
        if (process.env.TOGETHER_API_KEY && process.env.TOGETHER_API_KEY.trim() !== '') {
          try {
            const prompt = [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: `Previous context: ${conversationContext}\n\nCurrent message: ${message}` }
            ];

            const aiResponse = await callTogetherAI(prompt);
            const parsedResult = parseJSON(aiResponse, null);
            
            if (parsedResult && parsedResult.action) {
              result = parsedResult;
            } else {
              logger.warn('AI returned but JSON parse produced no valid action');
            }
          } catch (aiError) {
            logger.error('AI processing failed, using fallback', { error: aiError.message });
          }
        }

        // Fallback if AI fails or no API key
        if (!result) {
          result = generateSmartFallback(message);
        }

        // Store result in Redis as fallback
        if (result && job.id) {
          try {
            await redis.set(
              `job-result:${job.id}`,
              JSON.stringify(result),
              'EX', 30  // Expire after 30 seconds
            );
            logger.info('Stored result in Redis fallback', { jobId: job.id });
          } catch (err) {
            logger.error('Failed to store result in Redis', { error: err.message });
          }
        }

        return result;

      // ---------- analyze-cv handler ----------
      } else if (job.name === 'analyze-cv') {
        const { cvText, jobTitle, userId } = job.data;
        
        if (!cvText) {
          const emptyResult = {
            overall_score: 0,
            job_match_score: 0,
            skills_score: 0,
            experience_score: 0,
            education_score: 0,
            experience_years: 0,
            summary: 'No CV text provided'
          };

          if (job.id) {
            await redis.set(`job-result:${job.id}`, JSON.stringify(emptyResult), 'EX', 60);
          }
          return emptyResult;
        }

        let result = null;

        if (process.env.TOGETHER_API_KEY) {
          try {
            const prompt = [
              {
                role: 'system',
                content: `Analyze this CV for the Nigerian job market. Return JSON:
                {
                  "overall_score": number (0-100),
                  "job_match_score": number (0-100),
                  "skills_score": number (0-100),
                  "experience_score": number (0-100),
                  "education_score": number (0-100),
                  "experience_years": number,
                  "key_skills": ["skill1", "skill2", "skill3"],
                  "relevant_skills": ["relevant1", "relevant2"],
                  "education_level": "Bachelor's|Master's|PhD|Diploma|Other",
                  "summary": "brief summary",
                  "strengths": ["strength1", "strength2"],
                  "areas_for_improvement": ["area1", "area2"],
                  "recommendation": "Strong|Good|Average|Weak",
                  "cv_quality": "Excellent|Good|Average|Poor"
                }`
              },
              { 
                role: 'user', 
                content: `Analyze CV${jobTitle ? ` for ${jobTitle}` : ''}:\n\n${cvText.substring(0, 1500)}` 
              }
            ];

            const aiResponse = await callTogetherAI(prompt);
            const analysis = parseJSON(aiResponse, null);
            
            if (analysis && typeof analysis.overall_score !== 'undefined') {
              result = analysis;
            } else {
              logger.warn('AI CV analysis returned invalid structure');
            }
          } catch (error) {
            logger.error('AI CV analysis failed', { error: error.message });
          }
        }

        // Use fallback if AI fails
        if (!result) {
          result = performBasicCVAnalysis(cvText, jobTitle);
        }

        // Store CV analysis result in Redis too
        if (result && job.id) {
          try {
            await redis.set(
              `job-result:${job.id}`,
              JSON.stringify(result),
              'EX', 60
            );
          } catch (err) {
            logger.error('Failed to store CV analysis in Redis', { error: err.message });
          }
        }

        return result;

      // ---------- generate-cover-letter handler ----------
      } else if (job.name === 'generate-cover-letter') {
        const { cvText, jobTitle, companyName } = job.data;
        
        let result = null;

        if (process.env.TOGETHER_API_KEY) {
          try {
            const prompt = [
              {
                role: 'system',
                content: `Write a professional cover letter for a Nigerian job application. 150-200 words. Always use formal English.`
              },
              { 
                role: 'user', 
                content: `Cover letter for ${jobTitle || 'position'}${companyName ? ` at ${companyName}` : ''} based on: ${cvText.substring(0, 1000)}` 
              }
            ];

            result = await callTogetherAI(prompt);
          } catch (error) {
            logger.warn('Cover letter generation failed', { error: error.message });
          }
        }

        // Fallback cover letter
        if (!result) {
          result = `Dear Hiring Manager,

I am writing to express my strong interest in the ${jobTitle || 'position'}${companyName ? ` at ${companyName}` : ''}.

My background and experience make me well-qualified for this role. I am confident that my skills align with your requirements and that I can contribute meaningfully to your team's success.

I would welcome the opportunity to discuss how my experience can benefit your organization. Thank you for considering my application.

Best regards,
[Your Name]`;
        }

        // Store cover letter result
        if (result && job.id) {
          try {
            await redis.set(
              `job-result:${job.id}`,
              JSON.stringify({ content: result }),
              'EX', 60
            );
          } catch (err) {
            logger.error('Failed to store cover letter in Redis', { error: err.message });
          }
        }

        return result;
      }

    } catch (error) {
      logger.error('AI worker job failed', { error: error.message });
      
      const errorResult = { 
        action: 'error', 
        response: 'Something went wrong. Please try again.'
      };

      // Even store error results so the service doesn't timeout
      if (job.id) {
        try {
          await redis.set(
            `job-result:${job.id}`,
            JSON.stringify(errorResult),
            'EX', 10
          );
        } catch (err) {
          // Ignore storage errors
        }
      }

      return errorResult;
    }
  },
  { 
    connection: redis, 
    concurrency: 2 
  }
);

// Smart fallback function
function generateSmartFallback(message) {
  const text = (message || '').toLowerCase().trim();

  // Greetings
  if (text.match(/^(hello|hi|hey|good morning|good afternoon|good evening)$/)) {
    return {
      action: 'greeting',
      response: 'Hello! Welcome to SmartCVNaija! What job you dey find?'
    };
  }

  // Specific pidgin/vague pattern (also cover as fallback)
  if (text.match(/^i (dey|wan|need) find job$/)) {
    return {
      action: 'clarify',
      response: 'Which kind work and for where? Talk like "developer work for Lagos" or "remote job"',
      requiresSpecificity: true
    };
  }

  // Job search intent
  if (text.includes('job') || text.includes('work') || text.includes('find') || text.includes('search')) {
    return {
      action: 'clarify',
      response: 'Which job and where? Like "developer jobs in Lagos"'
    };
  }

  // Help
  if (text.includes('help')) {
    return {
      action: 'help',
      response: 'I help find jobs. Try "find jobs in Lagos" or upload CV.'
    };
  }

  // Default
  return {
    action: 'help',
    response: 'I help you find jobs in Nigeria. What you looking for?'
  };
}

// Basic CV analysis fallback
function performBasicCVAnalysis(cvText, jobTitle) {
  const text = (cvText || '').toLowerCase();
  let overallScore = 55;
  let jobMatchScore = 50;

  // Skills detection
  const skills = ['javascript', 'python', 'java', 'react', 'management', 'leadership', 'communication'];
  const foundSkills = [];
  
  skills.forEach(skill => {
    if (text.includes(skill)) {
      foundSkills.push(skill);
      overallScore += 4;
    }
  });

  // Experience estimation
  const experienceYears = extractExperience(text);
  overallScore += Math.min(experienceYears * 3, 20);

  // Job matching
  if (jobTitle && text.includes(jobTitle.toLowerCase())) {
    jobMatchScore += 25;
  }

  return {
    overall_score: Math.min(overallScore, 100),
    job_match_score: Math.min(jobMatchScore, 100),
    skills_score: Math.min(foundSkills.length * 12, 100),
    experience_score: Math.min(experienceYears * 12, 100),
    education_score: 65,
    experience_years: experienceYears,
    key_skills: foundSkills.slice(0, 5),
    relevant_skills: foundSkills.slice(0, 3),
    education_level: "Bachelor's",
    summary: `Professional with ${experienceYears} years experience`,
    strengths: ['Professional background', 'Relevant skills'],
    areas_for_improvement: ['Additional training', 'Certifications'],
    recommendation: overallScore >= 70 ? 'Good' : 'Average',
    cv_quality: 'Good'
  };
}

function extractExperience(text) {
  const patterns = [
    /(\d+)\s*years?\s*experience/i,
    /(\d+)\s*yrs?\s*experience/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return parseInt(match[1]);
    }
  }

  return 2; // Default
}

// Event handlers
worker.on('ready', () => {
  logger.info('🧠 Pure AI conversation worker ready!');
});

worker.on('completed', (job, result) => {
  logger.info('AI conversation completed', { 
    jobId: job.id, 
    action: result?.action 
  });
});

worker.on('failed', (job, err) => {
  logger.error('AI conversation failed', { jobId: job.id, error: err.message });
});

logger.info('🚀 SmartCVNaija AI conversation worker started!');

module.exports = worker;
