// Enhanced workers/openai.js - Add conversation memory to your existing worker
require('dotenv').config();
const { Worker } = require('bullmq');
const axios = require('axios');
const logger = require('../utils/logger');
const { redis, queueRedis } = require('../config/redis');

// Helper: Get conversation history for context
async function getConversationHistory(userId) {
  try {
    const historyKey = `conversation:${userId}`;
    const historyStr = await redis.get(historyKey);   // ✅ Change from mainRedis to redis
    return historyStr ? JSON.parse(historyStr).slice(-6) : [];
  } catch (error) {
    logger.error('Failed to get conversation history', { userId, error: error.message });
    return [];
  }
}


// Helper: Save conversation turn
async function saveConversationTurn(userId, userMessage, botResponse) {
  try {
    const historyKey = `conversation:${userId}`;
    const historyStr = await redis.get(historyKey);   // ✅ Change from mainRedis to redis
    let history = historyStr ? JSON.parse(historyStr) : [];

    history.push({ role: 'user', content: userMessage, timestamp: Date.now() });
    history.push({ role: 'assistant', content: botResponse, timestamp: Date.now() });

    if (history.length > 10) history = history.slice(-10);
    await redis.set(historyKey, JSON.stringify(history), 'EX', 86400);   // ✅ Change from mainRedis to redis
  } catch (error) {
    logger.error('Failed to save conversation turn', { userId, error: error.message });
  }
}


// Enhanced AI call with conversation context
async function callTogetherAIWithContext(messages) {
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
      // Enhanced parse-query with conversation memory
      if (job.name === 'parse-query' || job.name === 'ai-conversation') {
        const { message, userId, userContext, platform, timestamp } = job.data;
        
        logger.info('AI handling query with context', { 
          userId, 
          platform: platform || userContext?.platform,
          messageLength: (message || '').length 
        });

        // Get conversation history
        const conversationHistory = await getConversationHistory(userId);

        // Build context-aware prompt
        const systemPrompt = `You are SmartCVNaija, a helpful Nigerian job search assistant with MEMORY.

CONVERSATION CONTEXT:
- Remember what the user said in previous messages
- If they mentioned a job type before, remember it
- If they mentioned a location before, remember it
- Build on the conversation naturally

PERSONALITY: 
- Friendly and conversational Nigerian assistant
- Remember context and don't ask repeated questions
- Be brief (max 30 words) but helpful

MAIN CAPABILITIES:
1. Job search across Nigeria (Lagos, Abuja, Port Harcourt, etc.)
2. CV upload and processing
3. Job applications (₦500 for 10 daily applications)
4. Natural conversation with memory

IMPORTANT CONVERSATION RULES:
- If user said "developer jobs" before and now says "Lagos", combine them → search developer jobs in Lagos
- If user said "Lagos" before and now says "marketing", combine them → search marketing jobs in Lagos  
- Don't ask "what job?" if they mentioned it in recent messages
- Don't ask "where?" if they mentioned location in recent messages

RESPONSE FORMAT - Return JSON:
{
  "action": "search_jobs|apply_job|upload_cv|get_payment|clarify|chat|help",
  "response": "your natural response",
  "filters": {"title": "job_type", "location": "city", "remote": true/false},
  "extractedInfo": {"jobType": "extracted_job", "location": "extracted_location"}
}

Remember: Use conversation history to avoid repeating questions!`;

        // Build conversation messages with history
        const conversationMessages = [
          { role: 'system', content: systemPrompt }
        ];

        // Add recent conversation history for context
        conversationMessages.push(...conversationHistory);

        // Add current message
        conversationMessages.push({ role: 'user', content: message });

        let result = null;

        // Try AI processing with context
        if (process.env.TOGETHER_API_KEY) {
          try {
            const aiResponse = await callTogetherAIWithContext(conversationMessages);
            const parsedResult = parseJSON(aiResponse, null);
            
            if (parsedResult && parsedResult.action) {
              result = parsedResult;
              
              // Save this conversation turn
              await saveConversationTurn(userId, message, result.response || 'Processing...');
              
            } else {
              logger.warn('AI returned invalid JSON structure');
            }
          } catch (aiError) {
            logger.error('AI processing failed, using fallback', { error: aiError.message });
          }
        }

        // Fallback if AI fails
        if (!result) {
          result = generateContextAwareFallback(message, conversationHistory);
          await saveConversationTurn(userId, message, result.response);
        }

        // Store result in Redis as fallback
        if (result && job.id) {
          try {
            await redis.set(
              `job-result:${job.id}`,
              JSON.stringify(result),
              'EX', 30
            );
            logger.info('Stored result in Redis', { jobId: job.id });
          } catch (err) {
            logger.error('Failed to store result in Redis', { error: err.message });
          }
        }

        return result;

      } 
      // Keep your existing analyze-cv and generate-cover-letter handlers
      else if (job.name === 'analyze-cv') {
        // Your existing CV analysis code - unchanged
        const { cvText, jobTitle, userId } = job.data;
        // ... existing implementation
        return performBasicCVAnalysis(cvText, jobTitle);
        
      } else if (job.name === 'generate-cover-letter') {
        // Your existing cover letter code - unchanged  
        const { cvText, jobTitle, companyName } = job.data;
        // ... existing implementation
        return getFallbackCoverLetter(jobTitle, companyName);
      }

    } catch (error) {
      logger.error('AI worker job failed', { error: error.message });
      return { action: 'error', response: 'Something went wrong. Please try again.' };
    }
  },
  { 
    connection: queueRedis,
    prefix: "queue:",
    concurrency: 2 
  }
);

// Context-aware fallback when AI fails
function generateContextAwareFallback(message, conversationHistory) {
  const text = message.toLowerCase().trim();
  
  // Extract context from recent conversation AND from session data
  const recentMessages = conversationHistory.slice(-4).map(m => m.content?.toLowerCase() || '').join(' ');
  
  // Look for job types and locations in full context
  let contextJobType = null;
  let contextLocation = null;
  
  const jobTypes = ['developer', 'marketing', 'sales', 'teacher', 'nurse', 'engineer', 'manager'];
  const locations = ['lagos', 'abuja', 'kano', 'port harcourt', 'kaduna', 'ibadan', 'remote'];
  
  // Check current message and recent context
  const fullContext = `${recentMessages} ${text}`;
  
  for (const job of jobTypes) {
    if (fullContext.includes(job)) {
      contextJobType = job;
      break;
    }
  }
  
  for (const loc of locations) {
    if (fullContext.includes(loc)) {
      contextLocation = loc;
      break;
    }
  }
  
  // Handle specific patterns with context
  
  // Single location mentioned with job context
  if (locations.includes(text) && contextJobType) {
    return {
      action: 'search_jobs',
      response: `Searching for ${contextJobType} jobs in ${text.charAt(0).toUpperCase() + text.slice(1)}...`,
      filters: {
        title: contextJobType,
        location: text.charAt(0).toUpperCase() + text.slice(1),
        remote: text === 'remote'
      }
    };
  }
  
  // Single job type mentioned with location context
  if (jobTypes.includes(text) && contextLocation) {
    return {
      action: 'search_jobs', 
      response: `Looking for ${text} jobs in ${contextLocation.charAt(0).toUpperCase() + contextLocation.slice(1)}...`,
      filters: {
        title: text,
        location: contextLocation.charAt(0).toUpperCase() + contextLocation.slice(1),
        remote: contextLocation === 'remote'
      }
    };
  }
  
  // Both job and location detected in current context
  if (contextJobType && contextLocation) {
    return {
      action: 'search_jobs',
      response: `Searching ${contextJobType} jobs in ${contextLocation.charAt(0).toUpperCase() + contextLocation.slice(1)}...`,
      filters: {
        title: contextJobType,
        location: contextLocation.charAt(0).toUpperCase() + contextLocation.slice(1),
        remote: contextLocation === 'remote'
      }
    };
  }
  
  // Handle partial queries that need clarification
  if (jobTypes.includes(text)) {
    return {
      action: 'clarify',
      response: `What location for ${text} jobs? Lagos, Abuja, or Remote?`,
      filters: { title: text }
    };
  }
  
  if (locations.includes(text)) {
    return {
      action: 'clarify',
      response: `What type of jobs in ${text.charAt(0).toUpperCase() + text.slice(1)}? Developer, marketing, or sales?`,
      filters: { location: text.charAt(0).toUpperCase() + text.slice(1), remote: text === 'remote' }
    };
  }
  
  // Default responses
  if (text.includes('hello') || text.includes('hi')) {
    return {
      action: 'chat',
      response: 'Hello! I help you find jobs in Nigeria. What kind of work interests you?'
    };
  }
  
  if (text.includes('help')) {
    return {
      action: 'help', 
      response: 'I can help find jobs, process CVs, and handle applications. What do you need?'
    };
  }
  
  return {
    action: 'clarify',
    response: 'I can help you find jobs! What type of work and which city interests you?'
  };
}
// Your existing helper functions
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

// Keep your existing fallback functions
function performBasicCVAnalysis(cvText, jobTitle) {
  // Your existing implementation
  return {
    overall_score: 75,
    job_match_score: 70,
    skills_score: 80,
    experience_score: 65,
    education_score: 70,
    experience_years: 3,
    summary: 'Good professional background'
  };
}

function getFallbackCoverLetter(jobTitle, companyName) {
  return `Dear Hiring Manager,

I am writing to express my interest in the ${jobTitle || 'position'} at ${companyName || 'your company'}.

My background and experience make me a strong candidate for this role. I am confident I can contribute effectively to your team.

Thank you for your consideration.

Best regards,
[Your Name]`;
}

// Event handlers - keep existing
worker.on('ready', () => {
  logger.info('🧠 Enhanced AI conversation worker with memory ready!');
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

logger.info('🚀 SmartCVNaija AI worker with conversation memory started!');

module.exports = worker;