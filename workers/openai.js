// Enhanced workers/openai.js - Dual AI provider support with improved architecture
require('dotenv').config();
const { Worker } = require('bullmq');
const axios = require('axios');
const logger = require('../utils/logger');
const { redis, queueRedis } = require('../config/redis');

// AI Provider Configuration
const AI_PROVIDERS = {
  TOGETHER: 'together',
  MISTRAL: 'mistral'
};

const PROVIDER_CONFIG = {
  [AI_PROVIDERS.TOGETHER]: {
    url: 'https://api.together.xyz/v1/chat/completions',
    apiKey: process.env.TOGETHER_API_KEY,
    model: 'meta-llama/Llama-4-Scout-17B-16E', // $0.28/M tokens - 10M context, excellent performance
    maxTokens: 150, // Reduced for cost control
    temperature: 0.6, // Lower for more consistent JSON
    timeout: 10000
  },
  [AI_PROVIDERS.MISTRAL]: {
    url: 'https://api.mistral.ai/v1/chat/completions',
    apiKey: process.env.MISTRAL_API_KEY,
    model: 'mistral-small', // Fallback option
    maxTokens: 200,
    temperature: 0.6,
    timeout: 12000
  }
};

// Helper: Get conversation history for context
async function getConversationHistory(userId) {
  try {
    const historyKey = `conversation:${userId}`;
    const historyStr = await redis.get(historyKey);
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
    const historyStr = await redis.get(historyKey);
    let history = historyStr ? JSON.parse(historyStr) : [];

    history.push({ role: 'user', content: userMessage, timestamp: Date.now() });
    history.push({ role: 'assistant', content: botResponse, timestamp: Date.now() });

    if (history.length > 10) history = history.slice(-10);
    await redis.set(historyKey, JSON.stringify(history), 'EX', 86400);
  } catch (error) {
    logger.error('Failed to save conversation turn', { userId, error: error.message });
  }
}

// Smart provider selection
function selectAIProvider(message, conversationHistory = []) {
  const messageLength = (message || '').length;
  const hasHistory = conversationHistory.length > 0;
  const isComplex = messageLength > 50 || hasHistory;
  
  // Prefer Together for most queries (faster, cost-effective)
  if (PROVIDER_CONFIG[AI_PROVIDERS.TOGETHER].apiKey && 
      PROVIDER_CONFIG[AI_PROVIDERS.TOGETHER].apiKey.trim() !== '') {
    return AI_PROVIDERS.TOGETHER;
  }
  
  // Fallback to Mistral
  if (PROVIDER_CONFIG[AI_PROVIDERS.MISTRAL].apiKey && 
      PROVIDER_CONFIG[AI_PROVIDERS.MISTRAL].apiKey.trim() !== '') {
    return AI_PROVIDERS.MISTRAL;
  }
  
  return null;
}

// Universal AI call function with provider switching
async function callAIWithContext(messages, preferredProvider = null) {
  const provider = preferredProvider || selectAIProvider(messages[messages.length - 1]?.content || '', messages);
  
  if (!provider) {
    throw new Error('No AI providers configured');
  }
  
  const config = PROVIDER_CONFIG[provider];
  
  if (!config.apiKey || config.apiKey.trim() === '') {
    throw new Error(`${provider} API key not configured`);
  }

  try {
    logger.info(`Using ${provider} provider for AI call`);
    
    const response = await axios.post(
      config.url,
      {
        model: config.model,
        messages: messages,
        temperature: config.temperature,
        max_tokens: config.maxTokens,
        top_p: 0.9
      },
      {
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: config.timeout
      }
    );
    
    return {
      content: response.data.choices[0].message.content,
      provider: provider,
      model: config.model
    };
    
  } catch (error) {
    logger.error(`${provider} AI call failed`, { error: error.message });
    
    // Try fallback provider
    const fallbackProvider = provider === AI_PROVIDERS.TOGETHER ? AI_PROVIDERS.MISTRAL : AI_PROVIDERS.TOGETHER;
    const fallbackConfig = PROVIDER_CONFIG[fallbackProvider];
    
    if (fallbackConfig.apiKey && fallbackConfig.apiKey.trim() !== '') {
      logger.info(`Falling back to ${fallbackProvider} provider`);
      return callAIWithContext(messages, fallbackProvider);
    }
    
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
        
        logger.info('AI handling query with dual provider support', { 
          userId, 
          platform: platform || userContext?.platform,
          messageLength: (message || '').length 
        });

        // Get conversation history
        const conversationHistory = await getConversationHistory(userId);

        // Enhanced system prompt with Nigerian context
        const systemPrompt = `You are SmartCVNaija, a helpful Nigerian job search assistant with MEMORY.
You understand Nigerian slang, Pidgin English, and local expressions.

CONVERSATION CONTEXT:
- Remember what the user said in previous messages, including slang or Pidgin.
- If they mentioned a job type or location before, remember it.
- Build on the conversation naturally, responding in a friendly Nigerian tone.

PERSONALITY:
- Friendly, conversational, and familiar with Nigerian culture.
- Remember context and don't ask repeated questions.
- Be brief (max 40 words) but helpful.
- Use appropriate Nigerian expressions when natural.

MAIN CAPABILITIES:
1. Job search across all 36 Nigerian states + FCT
2. CV upload and processing
3. Job applications (₦500 for 10 daily applications)
4. Natural conversation with memory

IMPORTANT CONVERSATION RULES:
- If user said "developer jobs" before and now says "Lagos", combine them → search developer jobs in Lagos
- If user said "Lagos" before and now says "marketing", combine them → search marketing jobs in Lagos  
- Don't ask "what job?" if they mentioned it in recent messages
- Don't ask "where?" if they mentioned location in recent messages

JOB CATEGORIES (use these exact values for filters.title):
- engineering_technical (for developer, programmer, engineer, IT, software)
- marketing_sales (for sales, marketing, business development)
- accounting_finance (for accountant, finance, audit, bookkeeper)
- healthcare_medical (for nurse, doctor, medical, healthcare)
- education_training (for teacher, trainer, instructor, tutor)
- admin_office (for admin, secretary, clerk, office assistant)
- management_executive (for manager, supervisor, director, executive)
- customer_service (for customer service, support, call center)
- human_resources (for HR, recruiter, talent, personnel)
- logistics_supply (for logistics, warehouse, supply chain)
- transport_driving (for driver, transport, delivery, courier)
- security_safety (for security, guard, safety, surveillance)
- other_general (for general jobs, entry level, graduate)

RESPONSE FORMAT - Return JSON:
{
  "action": "search_jobs|apply_job|upload_cv|get_payment|clarify|chat|help",
  "response": "your natural response using appropriate tone",
  "filters": {"title": "job_category_from_above", "location": "State_Name", "remote": true/false},
  "extractedInfo": {"jobType": "detected_job", "location": "detected_location"}
}

EXAMPLES:
- User: "I want developer work for Lagos" →
  {
    "action": "search_jobs",
    "response": "Searching for developer jobs in Lagos now...",
    "filters": {"title": "engineering_technical", "location": "Lagos", "remote": false}
  }
- User: "How far?" →
  {
    "action": "chat",
    "response": "I dey o! Wetin you want make I do for you today?"
  }

Remember: Use conversation history to provide smart, contextual responses!`;

        // Build conversation messages with history
        const conversationMessages = [
          { role: 'system', content: systemPrompt }
        ];

        // Add recent conversation history for context
        conversationMessages.push(...conversationHistory);

        // Add current message
        conversationMessages.push({ role: 'user', content: message });

        // STEP 1: Try local parsing first (instant)
        let result = null;

        // Quick commands
        const simple = parseSimpleCommand(message);
        if (simple) {
          result = simple;
        } else {
          // Pattern-based parsing with conversation context
          const pattern = parseSmartPatterns(message, { sessionData: conversationHistory });
          if (pattern) result = pattern;
        }

        // STEP 2: Only call AI if local methods failed
        if (!result) {
          try {
            const aiResponse = await callAIWithContext(conversationMessages);
            const parsedResult = parseJSON(aiResponse.content, null);
            
            if (parsedResult && parsedResult.action) {
              result = {
                ...parsedResult,
                aiProvider: aiResponse.provider,
                aiModel: aiResponse.model
              };
              await saveConversationTurn(userId, message, result.response || 'Processing...');
            }
          } catch (aiError) {
            logger.error('AI call failed for both providers', { error: aiError.message });
          }
        }

        // STEP 3: Fallback if still nothing
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
            logger.info('Stored result in Redis', { jobId: job.id, provider: result.aiProvider });
          } catch (err) {
            logger.error('Failed to store result in Redis', { error: err.message });
          }
        }

        return result;

      } 
      // Keep existing analyze-cv and generate-cover-letter handlers
      else if (job.name === 'analyze-cv') {
        const { cvText, jobTitle, userId } = job.data;
        return performBasicCVAnalysis(cvText, jobTitle);
        
      } else if (job.name === 'generate-cover-letter') {
        const { cvText, jobTitle, companyName } = job.data;
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

// Enhanced context-aware fallback
function generateContextAwareFallback(message, conversationHistory) {
  const text = message.toLowerCase().trim();
  
  // Extract context from recent conversation
  const recentMessages = conversationHistory.slice(-4).map(m => m.content?.toLowerCase() || '').join(' ');
  
  // Enhanced job type detection with categories
  const jobMapping = {
    'developer': 'engineering_technical',
    'programmer': 'engineering_technical', 
    'engineer': 'engineering_technical',
    'software': 'engineering_technical',
    'it': 'engineering_technical',
    'tech': 'engineering_technical',
    'marketing': 'marketing_sales',
    'sales': 'marketing_sales',
    'business development': 'marketing_sales',
    'accountant': 'accounting_finance',
    'accounting': 'accounting_finance',
    'finance': 'accounting_finance',
    'audit': 'accounting_finance',
    'bookkeeper': 'accounting_finance',
    'nurse': 'healthcare_medical',
    'doctor': 'healthcare_medical',
    'medical': 'healthcare_medical',
    'healthcare': 'healthcare_medical',
    'teacher': 'education_training',
    'instructor': 'education_training',
    'trainer': 'education_training',
    'tutor': 'education_training',
    'admin': 'admin_office',
    'secretary': 'admin_office',
    'clerk': 'admin_office',
    'office': 'admin_office',
    'manager': 'management_executive',
    'supervisor': 'management_executive',
    'director': 'management_executive',
    'executive': 'management_executive',
    'customer service': 'customer_service',
    'support': 'customer_service',
    'call center': 'customer_service',
    'hr': 'human_resources',
    'human resources': 'human_resources',
    'recruiter': 'human_resources',
    'logistics': 'logistics_supply',
    'warehouse': 'logistics_supply',
    'supply chain': 'logistics_supply',
    'driver': 'transport_driving',
    'transport': 'transport_driving',
    'delivery': 'transport_driving',
    'security': 'security_safety',
    'guard': 'security_safety',
    'safety': 'security_safety'
  };
  
  const locations = ['lagos', 'abuja', 'kano', 'port harcourt', 'kaduna', 'ibadan', 'enugu', 'oyo', 'rivers', 'delta', 'edo', 'ondo', 'ekiti', 'osun', 'ogun', 'cross river', 'akwa ibom', 'bayelsa', 'abia', 'imo', 'anambra', 'ebonyi', 'benue', 'plateau', 'nasarawa', 'kogi', 'kwara', 'niger', 'kebbi', 'sokoto', 'zamfara', 'katsina', 'jigawa', 'yobe', 'borno', 'adamawa', 'taraba', 'gombe', 'bauchi', 'remote'];
  
  // Check current message and recent context
  const fullContext = `${recentMessages} ${text}`;
  
  let contextJobType = null;
  let contextJobCategory = null;
  let contextLocation = null;
  
  // Find job type in context
  for (const [job, category] of Object.entries(jobMapping)) {
    if (fullContext.includes(job)) {
      contextJobType = job;
      contextJobCategory = category;
      break;
    }
  }
  
  // Find location in context
  for (const loc of locations) {
    if (fullContext.includes(loc)) {
      contextLocation = loc.charAt(0).toUpperCase() + loc.slice(1);
      if (loc === 'port harcourt') contextLocation = 'Rivers'; // Map to state
      break;
    }
  }
  
  // Handle specific patterns with context
  if (locations.map(l => l.toLowerCase()).includes(text) && contextJobCategory) {
    const locationName = text === 'port harcourt' ? 'Rivers' : text.charAt(0).toUpperCase() + text.slice(1);
    return {
      action: 'search_jobs',
      response: `Searching for ${contextJobType} jobs in ${locationName}...`,
      filters: {
        title: contextJobCategory,
        location: locationName,
        remote: text === 'remote'
      }
    };
  }
  
  if (Object.keys(jobMapping).includes(text) && contextLocation) {
    return {
      action: 'search_jobs', 
      response: `Looking for ${text} jobs in ${contextLocation}...`,
      filters: {
        title: jobMapping[text],
        location: contextLocation,
        remote: contextLocation === 'Remote'
      }
    };
  }
  
  // Both job and location detected
  if (contextJobCategory && contextLocation) {
    return {
      action: 'search_jobs',
      response: `Searching ${contextJobType} jobs in ${contextLocation}...`,
      filters: {
        title: contextJobCategory,
        location: contextLocation,
        remote: contextLocation === 'Remote'
      }
    };
  }
  
  // Handle greetings
  if (text.includes('hello') || text.includes('hi') || text.includes('hey')) {
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

// Helper functions
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

function performBasicCVAnalysis(cvText, jobTitle) {
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

function getPersonalizedFallbackCoverLetter(cvText, jobTitle, companyName, applicantName = '[Your Name]') {
  // Extract information from CV text
  const cvInfo = extractCVInformation(cvText);
  const jobSpecificContent = getJobSpecificContent(jobTitle, cvInfo);
  
  return `Dear Hiring Manager,

I am writing to express my strong interest in the ${jobTitle || 'position'} at ${companyName || 'your company'}. ${jobSpecificContent.opening}

${cvInfo.experienceText} ${jobSpecificContent.skills} ${cvInfo.skillsText}

I would welcome the opportunity to discuss how my background can contribute to your team's success. Thank you for considering my application, and I look forward to hearing from you.

Best regards,
${applicantName}`;
}

function extractCVInformation(cvText) {
  const text = cvText.toLowerCase();
  
  // Extract education
  let education = '';
  if (text.includes('bachelor') || text.includes('bsc') || text.includes('b.sc')) {
    education = 'bachelor\'s degree';
  } else if (text.includes('master') || text.includes('msc') || text.includes('m.sc')) {
    education = 'master\'s degree';
  } else if (text.includes('hnd') || text.includes('diploma')) {
    education = 'diploma';
  } else if (text.includes('university') || text.includes('college')) {
    education = 'university education';
  }

  // Extract years of experience
  let yearsExp = '';
  const yearMatches = text.match(/(\d+)\s*years?\s*(of\s*)?(experience|exp)/);
  if (yearMatches) {
    yearsExp = `${yearMatches[1]} years of experience`;
  } else if (text.includes('experienced') || text.includes('experience')) {
    yearsExp = 'relevant experience';
  }

  // Extract specific skills
  const skills = [];
  const skillKeywords = ['excel', 'microsoft office', 'accounting software', 'quickbooks', 'sap', 'sql', 'javascript', 'python', 'photoshop', 'autocad', 'project management'];
  skillKeywords.forEach(skill => {
    if (text.includes(skill)) {
      skills.push(skill);
    }
  });

  // Extract previous job titles
  const jobTitles = [];
  const titleKeywords = ['accountant', 'manager', 'assistant', 'officer', 'analyst', 'coordinator', 'supervisor', 'executive', 'specialist'];
  titleKeywords.forEach(title => {
    if (text.includes(title) && !jobTitles.includes(title)) {
      jobTitles.push(title);
    }
  });

  // Build descriptive text
  let experienceText = '';
  if (education && yearsExp) {
    experienceText = `With my ${education} and ${yearsExp}, I am well-positioned for this role.`;
  } else if (education) {
    experienceText = `My ${education} has provided me with a strong foundation for this position.`;
  } else if (yearsExp) {
    experienceText = `My ${yearsExp} has prepared me well for this opportunity.`;
  } else {
    experienceText = 'My professional background has equipped me with relevant skills for this position.';
  }

  let skillsText = '';
  if (skills.length > 0) {
    const skillsList = skills.slice(0, 3).join(', ');
    skillsText = `My proficiency in ${skillsList} aligns well with your requirements.`;
  }

  return {
    education,
    yearsExp,
    skills,
    jobTitles,
    experienceText,
    skillsText
  };
}

function getJobSpecificContent(jobTitle, cvInfo) {
  const title = (jobTitle || '').toLowerCase();
  
  if (title.includes('account') || title.includes('finance')) {
    return {
      opening: `My background in accounting and financial management, combined with ${cvInfo.experienceText ? 'my professional experience' : 'my educational foundation'}, makes me well-suited for this role.`,
      skills: 'My understanding of financial processes and attention to detail position me well for this accounting role.'
    };
  } else if (title.includes('developer') || title.includes('software') || title.includes('it')) {
    return {
      opening: 'My technical background and passion for technology make me an ideal candidate for this development position.',
      skills: 'My programming knowledge and problem-solving abilities align with your technical requirements.'
    };
  } else if (title.includes('marketing') || title.includes('sales')) {
    return {
      opening: 'My experience in client relations and understanding of market dynamics prepare me well for this marketing role.',
      skills: 'My communication skills and market awareness make me a strong candidate for your sales team.'
    };
  } else if (title.includes('manager') || title.includes('supervisor')) {
    return {
      opening: 'My leadership capabilities and management experience make me well-qualified for this supervisory position.',
      skills: 'My ability to coordinate teams and manage projects effectively suits your management requirements.'
    };
  }
  
  return {
    opening: `My professional background and ${cvInfo.education || 'educational foundation'} make me a qualified candidate for this role.`,
    skills: 'My relevant skills and dedication to excellence position me well for this opportunity.'
  };
}

function getFallbackCoverLetter(jobTitle, companyName, applicantName = '[Your Name]') {
  return `Dear Hiring Manager,

I am writing to express my strong interest in the ${jobTitle || 'position'} at ${companyName || 'your company'}. My professional background and experience make me well-qualified for this role in Nigeria's competitive job market.

I have developed relevant skills that align with your requirements and am confident in my ability to contribute effectively to your team. I am eager to bring my expertise and dedication to help drive your organization's continued success.

I would welcome the opportunity to discuss how my experience can benefit your team. Thank you for considering my application, and I look forward to hearing from you.

Best regards,
${applicantName}`;
}

function parseSimpleCommand(message) {
  const text = message.toLowerCase().trim();

  const commands = {
    'reset': { action: 'reset', response: 'Session cleared! Let\'s start afresh.' },
    'status': { action: 'status', response: 'Checking your application status...' },
    'help': { 
      action: 'help', 
      response: 'I help Nigerians search and apply for jobs.\nExample: "Find accounting jobs in Abuja"'
    }
  };

  if (commands[text]) return commands[text];

  // Nigerian greetings
  if (text.match(/^(hello|hi|hey|good morning|good afternoon|good evening)$/)) {
    return {
      action: 'greeting',
      response: 'Hello! I\'m SmartCV Naija. I can help you search and apply for jobs in Nigeria.\nTry: "Find engineering jobs in Lagos"'
    };
  }

  // Confirmation messages
  if (text.match(/^(yes|ok|sure|alright)$/)) {
    return {
      action: 'confirm',
      response: 'Great! Please upload your CV (PDF, max 5MB) and I\'ll continue with the application.'
    };
  }

  return null;
}

function parseSmartPatterns(message, userContext = {}) {
  const text = message.toLowerCase().trim();

  // Detect direct job keywords
  if (text.includes('job') || text.includes('work') || text.includes('vacancy')) {
    return {
      action: 'clarify',
      response: 'Great — which location are you interested in? Lagos, Abuja, Port Harcourt, or Remote?'
    };
  }

  // Detect apply intent
  if (text.includes('apply')) {
    return {
      action: 'apply',
      response: 'Okay. Upload your CV (PDF, max 5MB), and I\'ll submit the application for you.'
    };
  }

  // Detect location-only queries
  if (text.match(/lagos|abuja|port harcourt|ph|remote|kano|ibadan|enugu/)) {
    return {
      action: 'search_location',
      response: `Okay — looking for jobs in ${text}. What role are you interested in?`
    };
  }

  // Detect common role-only queries
  const commonRoles = ['accountant', 'developer', 'nurse', 'teacher', 'engineer', 'sales', 'marketing', 'manager'];
  if (commonRoles.some(role => text.includes(role))) {
    return {
      action: 'search_role',
      response: `Got it — searching for ${text} jobs. Do you want them in Lagos, Abuja, or another state?`
    };
  }

  return null;
}

// Event handlers
worker.on('ready', () => {
  logger.info('🧠 Enhanced AI conversation worker with dual provider support ready!');
  
  // Log available providers
  const availableProviders = [];
  if (PROVIDER_CONFIG[AI_PROVIDERS.TOGETHER].apiKey) availableProviders.push('Together AI');
  if (PROVIDER_CONFIG[AI_PROVIDERS.MISTRAL].apiKey) availableProviders.push('Mistral AI');
  
  logger.info(`Available AI providers: ${availableProviders.join(', ')}`);
});

worker.on('completed', (job, result) => {
  logger.info('AI conversation completed', { 
    jobId: job.id, 
    action: result?.action,
    provider: result?.aiProvider 
  });
});

worker.on('failed', (job, err) => {
  logger.error('AI conversation failed', { jobId: job.id, error: err.message });
});

logger.info('🚀 SmartCVNaija AI worker with dual AI provider support started!');

module.exports = worker;