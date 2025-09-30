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
    model: 'Qwen/Qwen3-235B-A22B-Instruct-2507-tput', // $0.28/M tokens - 10M context, excellent performance
    maxTokens: 800, // Reduced for cost control
    temperature: 0.6, // Lower for more consistent JSON
    timeout: 30000  // CRITICAL: Reduced from 10000 to 8000
  },
  [AI_PROVIDERS.MISTRAL]: {
    url: 'https://api.mistral.ai/v1/chat/completions',
    apiKey: process.env.MISTRAL_API_KEY,
    model: 'mistral-small', // Fallback option
    maxTokens: 800,
    temperature: 0.6,
    timeout: 30000  // CRITICAL: Reduced from 12000 to 10000
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
// REPLACE your existing callAIWithContext function with this version
async function callAIWithContext(messages, preferredProvider = null, customConfig = {}) {
  const provider = preferredProvider || selectAIProvider(messages[messages.length - 1]?.content || '', messages);
  
  if (!provider) {
    throw new Error('No AI providers configured');
  }
  
  const config = PROVIDER_CONFIG[provider];
  
  if (!config.apiKey || config.apiKey.trim() === '') {
    throw new Error(`${provider} API key not configured`);
  }

  // ADDED: Merge custom config with default config
  const finalConfig = {
    ...config,
    ...customConfig
  };

  try {
    logger.info(`Using ${provider} provider for AI call`, {
      maxTokens: finalConfig.maxTokens,
      temperature: finalConfig.temperature
    });
    
    const response = await axios.post(
      config.url,
      {
        model: config.model,
        messages: messages,
        temperature: finalConfig.temperature,
        max_tokens: finalConfig.maxTokens,
        top_p: 0.9
      },
      {
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: finalConfig.timeout
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
      return callAIWithContext(messages, fallbackProvider, customConfig);
    }
    
    throw error;
  }
}

// CV text summarization
function summarizeCV(cvText, maxLength = 3000) {
  if (!cvText || typeof cvText !== 'string') return '[CV content not available]';
  
  const lines = cvText.split('\n').filter(line => line.trim());
  const keywords = [
    'experience', 'education', 'skills', 'certification', 'work', 'degree', 'project',
    'responsibility', 'achievement', 'qualification', 'training', 'award'
  ];
  
  // Prioritize lines with keywords
  const relevantLines = [];
  const otherLines = [];
  
  lines.forEach(line => {
    if (keywords.some(k => line.toLowerCase().includes(k))) {
      relevantLines.push(line);
    } else {
      otherLines.push(line);
    }
  });
  
  // Combine relevant first, then others
  const combinedLines = [...relevantLines, ...otherLines];
  let summary = combinedLines.join('\n').substring(0, maxLength);
  
  if (summary.length < cvText.length) {
    summary += '\n[CV content summarized to preserve key sections]';
  }
  
  return summary;
}

// ADD this new function to your worker file:
function generatePersonalizedFallbackCoverLetter(cvText, jobTitle, companyName, applicantName = '[Your Name]') {
  try {
    // Quick CV analysis for personalization
    const text = (cvText || '').toLowerCase();
    
    // Detect experience level
    const yearMatches = text.match(/(\d+)\s*years?\s*(of\s*)?(experience|exp)/gi);
    let experienceText = 'relevant professional experience';
    
    if (yearMatches) {
      const years = parseInt(yearMatches[0].match(/(\d+)/)[1]);
      if (years >= 5) {
        experienceText = `${years}+ years of extensive experience`;
      } else if (years >= 2) {
        experienceText = `${years} years of solid experience`;
      } else {
        experienceText = `${years} years of foundational experience`;
      }
    }
    
    // Detect education
    let educationText = '';
    if (text.includes('master') || text.includes('msc')) {
      educationText = 'advanced degree and ';
    } else if (text.includes('bachelor') || text.includes('bsc')) {
      educationText = 'university education and ';
    } else if (text.includes('diploma') || text.includes('hnd')) {
      educationText = 'professional certification and ';
    }
    
    // Job-specific skills
    const jobSkills = {
      'account': 'financial analysis and bookkeeping',
      'develop': 'programming and software development',
      'engineer': 'technical problem-solving and design',
      'market': 'client relations and business development',
      'sales': 'customer engagement and revenue generation',
      'manag': 'team leadership and project coordination',
      'admin': 'organizational efficiency and office management'
    };
    
    let relevantSkills = 'professional expertise';
    const title = (jobTitle || '').toLowerCase();
    
    for (const [key, skills] of Object.entries(jobSkills)) {
      if (title.includes(key)) {
        relevantSkills = skills;
        break;
      }
    }
    
    const coverLetter = `Dear Hiring Manager,

I am writing to express my strong interest in the ${jobTitle} position at ${companyName}. With my ${educationText}${experienceText}, I am confident in my ability to contribute effectively to your team.

My background has equipped me with strong capabilities in ${relevantSkills}, which align well with the requirements of this role. I am particularly drawn to ${companyName} and the opportunity to apply my skills in a dynamic environment where I can continue to grow professionally.

I would welcome the opportunity to discuss how my experience and enthusiasm can contribute to your continued success. Thank you for considering my application, and I look forward to hearing from you.

Best regards,
${applicantName}`;

    logger.info('Enhanced fallback cover letter generated', {
      jobTitle,
      companyName,
      applicantName,
      experienceText,
      educationText,
      relevantSkills,
      letterLength: coverLetter.length
    });

    return coverLetter;
    
  } catch (error) {
    logger.error('Enhanced fallback failed, using basic template', { error: error.message });
    
    // Ultimate fallback
    return `Dear Hiring Manager,

I am writing to express my interest in the ${jobTitle} position at ${companyName}. My professional background and skills make me a strong candidate for this role.

I am confident in my ability to contribute effectively to your team and would welcome the opportunity to discuss how I can add value to your organization.

Thank you for considering my application. I look forward to hearing from you.

Best regards,
${applicantName}`;
  }
}
async function tryExtractUserInfo(messages, attempts = 2) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await callAIWithContext(messages, null);
    } catch (err) {
      lastError = err;
      logger.warn('Retrying AI extraction', { attempt: i + 1, error: err.message });
    }
  }
  throw lastError;
}
const worker = new Worker(
  'openai-tasks',
  async (job) => {
    const jobStartTime = Date.now();
    
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
      // Keep existing generate-cover-letter handler
      else if (job.name === 'generate-cover-letter') {
        const { cvText, jobTitle, companyName, applicantName = '[Your Name]' } = job.data;

        if (!cvText || !jobTitle || !companyName) {
          throw new Error('Missing required data: cvText, jobTitle, or companyName');
        }
        
        try {
          const systemPrompt = `You are a professional career advisor. Generate a concise, professional cover letter (250-300 words) for the job application. 

Requirements:
- Start with "Dear Hiring Manager," 
- Express interest in the specific role and company
- Highlight 2-3 most relevant experiences/skills from the CV
- End with a call to action and professional closing
- Close with "Best regards, ${applicantName}"
- Use professional, confident tone
- Be specific and avoid generic statements

Return ONLY the complete cover letter text, no formatting.`;

          const summarizedCV = summarizeCV(cvText, 2000);
          const userContent = `Position: ${jobTitle}
Company: ${companyName}
Applicant: ${applicantName}
CV Summary: ${summarizedCV}

Generate a tailored cover letter.`;

          const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent }
          ];

          // CRITICAL: Reduced maxTokens and added faster timeout
          const aiResponse = await callAIWithContext(messages, null, { 
            maxTokens: 1500,  // Reduced from 600
            temperature: 0.7 
          });
          
          const coverLetter = aiResponse.content.trim();
          const duration = Date.now() - jobStartTime;
          
          logger.info('Cover letter generated successfully', {
            jobTitle,
            companyName,
            applicantName,
            jobId: job.id,
            duration: `${duration}ms`,
            letterLength: coverLetter.length,
            provider: aiResponse.provider,
            source: 'AI'
          });
          
          return coverLetter;
          
        } catch (error) {
          logger.warn('AI cover letter generation failed, using enhanced fallback', { 
            jobTitle,
            companyName,
            applicantName: applicantName || '[Your Name]',
            error: error.message,
            jobId: job.id
          });
          
          // ENHANCED: Return personalized fallback instead of calling external service
          return generatePersonalizedFallbackCoverLetter(cvText, jobTitle, companyName, applicantName);
        }
      }
      // NEW: Add the extract-user-info handler here
      else if (job.name === 'extract-user-info') {
        const { cvText, identifier } = job.data;
        
        if (!cvText) {
          throw new Error('Missing CV text for user info extraction');
        }
        
        logger.info('AI extracting user info', {
          identifier: identifier?.substring(0, 6) + '***',
          cvTextLength: cvText.length
        });
        
        try {
          const systemPrompt = `You are an expert CV parser specializing in extracting personal information from CVs/resumes in ANY format.

CRITICAL INSTRUCTION: The applicant's name is usually THE FIRST PROMINENT TEXT in the document, often at the very top, sometimes styled differently (larger font, bold, etc).

EXTRACTION STRATEGY:
1. FIRST PRIORITY - Check the TOP of the document:
   - The first 1-3 lines often contain the applicant's name
   - Names are typically 2-4 words of proper nouns
   - Names often appear BEFORE any job titles, companies, or descriptive text
   - Example patterns:
     * "JOHN DOE" (all caps at top)
     * "John Doe" (title case at top)
     * "John Michael Doe" (with middle name)
     * "Nwabudike Chinedu Ekene" (Nigerian names with 3 parts)

2. SECOND PRIORITY - Look for explicit labels:
   - "Name:", "Full Name:", "Applicant:"
   - Personal information sections
   - Contact information headers

3. THIRD PRIORITY - Check near contact details:
   - Names often appear directly above/below email and phone
   - Look for text near email addresses that could be a name

WHAT IS NOT A NAME:
- Job titles: "Accountant", "Developer", "Manager", "Engineer"
- Companies: "Microsoft", "Google", "Stackivy"
- Locations: "Lagos", "Nigeria", "Abuja"
- Section headers: "Experience", "Education", "Skills"
- Descriptive phrases: "Experienced professional", "Team leader", "Team Leadership"

NIGERIAN NAME PATTERNS TO RECOGNIZE:
- Often 3 parts: First name + Middle name + Surname
- Common patterns: [Yoruba/Igbo/Hausa first name] + [Christian/Muslim middle name] + [Surname]
- Examples: 
  * "Adebayo Michael Ogundimu"
  * "Chinedu Joseph Nwankwo"
  * "Fatima Aisha Ibrahim"
  * "Oluwaseun Grace Adeleke"
  * "Nwabudike Chinedu Ekene"
  * "Tessy Bakare"
  * "Cynthia Igbonai Bakare"

EMAIL EXTRACTION:
- Look for valid email patterns: text@domain.com
- Ignore test emails: test@, example@, admin@, info@

PHONE EXTRACTION:
- Nigerian formats: +234XXXXXXXXXX, 234XXXXXXXXXX, 0XXXXXXXXXX
- Must be 10-14 digits total

CONFIDENCE SCORING:
- 0.9-1.0: Name found at document top, clear formatting
- 0.7-0.9: Name found with some context clues
- 0.5-0.7: Name extracted from email or other indirect source
- Below 0.5: Uncertain extraction

Return ONLY valid JSON:
{
  "name": "Full Name Here",
  "email": "email@domain.com",
  "phone": "+234XXXXXXXXXX",
  "confidence": 0.95,
  "nameLocation": "top_of_document|labeled_field|near_contact|from_email"
}`;

          const userPrompt = `Extract the applicant's personal information from this CV.

IMPORTANT: Start by looking at the VERY FIRST LINES of the CV - the name is usually right at the top!

CV TEXT:
${cvText.substring(0, 4000)}

Remember:
1. The name is typically the FIRST prominent text (not a title or company)
2. Nigerian names often have 3 parts
3. Look for proper nouns at the document start
4. Don't confuse job titles with names
5. "Team Leadership" or "Team Leader" is NOT a name

Return valid JSON only.`;

          const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ];

          // Call AI with timeout
          const aiResponse = await Promise.race([
            callAIWithContext(messages, null, { maxTokens: 500, temperature: 0.3 }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("AI extraction timeout")), 30000)
            )
          ]);

          const extractedData = parseJSON(aiResponse.content, {});
          
          // Clean and validate the response
          const result = {
            name: cleanAndValidateName(extractedData.name || ''),
            email: cleanAndValidateEmail(extractedData.email || ''),
            phone: cleanAndValidatePhone(extractedData.phone || '', identifier),
            confidence: extractedData.confidence || 0.5,
            nameLocation: extractedData.nameLocation || 'unknown',
            aiProvider: aiResponse.provider,
            source: 'AI'
          };

          logger.info('AI user info extraction completed', {
            identifier: identifier?.substring(0, 6) + '***',
            confidence: result.confidence,
            provider: aiResponse.provider,
            extractedName: result.name || 'NONE',
            extractedEmail: result.email || 'NONE',
            nameLocation: result.nameLocation
          });

          return result;

        } catch (error) {
  logger.error('AI user info extraction failed', {
    identifier: identifier?.substring(0, 6) + '***',
    error: error.message
  });

  // Try regex fallback
  const regexResult = extractUserInfoTraditional(cvText, identifier);

  if (regexResult && regexResult.name) {
    logger.info('Regex fallback extraction successful', {
      identifier: identifier?.substring(0, 6) + '***',
      extractedName: regexResult.name,
      source: 'regex_fallback'
    });
    return { ...regexResult, source: 'regex_fallback' };
  }

  // If regex also fails, try enhanced fallback
  const fallback = enhancedFallbackExtraction(cvText, identifier, regexResult);
  logger.info('Enhanced fallback extraction used', {
    identifier: identifier?.substring(0, 6) + '***',
    finalName: fallback.name || 'NONE',
    finalEmail: fallback.email || 'NONE',
    source: 'enhanced_fallback'
  });
  return { ...fallback, source: 'enhanced_fallback' };
}

      }
      
      // Add other job handlers here (parse-query, generate-cover-letter, etc.)
      
    } catch (error) {
      const duration = Date.now() - jobStartTime;
      logger.error('AI worker job failed', { 
        jobId: job.id,
        jobName: job.name,
        duration: `${duration}ms`,
        error: error.message,
        attempt: job.attemptsMade + 1
      });
      throw error;
    }
  },
  { 
    connection: queueRedis,
    prefix: "queue:",
    concurrency: 2,
    maxStalledCount: 1,
    stalledInterval: 15000,
    removeOnComplete: 5,
    removeOnFail: 3,
    defaultJobOptions: {
      attempts: 2,
      ttl: 65000
    }
  }
);

// Add the helper functions after the worker definition


// Helper function to clean and validate names
function cleanAndValidateName(name) {
  if (!name || typeof name !== 'string') return '';
  
  // Remove extra spaces and clean up
  let cleaned = name
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s\-'.]/g, '');
  
  // Remove common non-name words if they appear alone
  const invalidNames = [
    'team', 'leadership', 'team leadership', 'team leader',
    'experience', 'education', 'skills', 'cv', 'resume', 'curriculum', 'vitae',
    'personal', 'information', 'contact', 'details', 'profile', 'summary',
    'objective', 'references', 'available', 'request', 'lagos', 'nigeria',
    'abuja', 'email', 'phone', 'address', 'date', 'accountant', 'engineer', 
    'manager', 'developer', 'analyst', 'officer', 'assistant', 'coordinator', 
    'supervisor', 'executive', 'specialist', 'professional', 'junior', 'senior'
  ];
  
  const words = cleaned.toLowerCase().split(' ');
  
  // Check if the entire name is an invalid phrase
  if (invalidNames.includes(cleaned.toLowerCase())) {
    return '';
  }
  
  // Don't reject if these words are part of a longer name
  if (words.length === 1 && invalidNames.includes(words[0])) {
    return '';
  }
  
  // Ensure it's a reasonable name length
  if (cleaned.length >= 4 && cleaned.length <= 60 && words.length >= 2) {
    // Capitalize properly
    return cleaned.split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }
  
  return '';
}

function cleanAndValidateEmail(email) {
  if (!email || typeof email !== 'string') return '';
  
  const cleaned = email.trim().toLowerCase();
  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  
  if (emailRegex.test(cleaned)) {
    // Check for invalid test emails
    const invalidDomains = [
      'example.com', 'test.com', 'domain.com', 'email.com',
      'smartcvnaija.com', 'sample.com', 'dummy.com'
    ];
    
    const domain = cleaned.split('@')[1];
    if (!invalidDomains.includes(domain)) {
      return cleaned;
    }
  }
  
  return '';
}

function cleanAndValidatePhone(phone, identifier) {
  if (!phone || typeof phone !== 'string') return identifier;
  
  // Clean phone number
  const cleaned = phone.replace(/[^\d+]/g, '');
  
  // Nigerian phone patterns
  const patterns = [
    /^(\+234|234)\d{10}$/,
    /^0\d{10}$/
  ];
  
  if (patterns.some(pattern => pattern.test(cleaned))) {
    return cleaned;
  }
  
  return identifier;
}

function parseJSON(raw, fallback = {}) {
  try {
    let cleaned = (raw || '').trim();
    
    // Remove code block markers
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }
    
    // Handle truncated JSON
    if (!cleaned.endsWith('}')) {
      cleaned += '}';
    }
    
    return JSON.parse(cleaned);
    
  } catch (err) {
    logger.error('JSON parse failed', { 
      raw: (raw || '').substring(0, 200), 
      error: err.message
    });
    return fallback;
  }
}
// Enhanced context-aware fallback
function generateContextAwareFallback(message, conversationHistory) {
  const text = message.toLowerCase().trim();
  
  // Extract context from recent conversation
  const recentMessages = conversationHistory.slice(-4).map(m => m.content?.toLowerCase() || '').join(' ');
  
  // CORRECTED: Enhanced job type detection with proper IT/Software vs Engineering separation
  const jobMapping = {
    // IT & SOFTWARE DEVELOPMENT
    'developer': 'it_software',
    'programmer': 'it_software', 
    'software engineer': 'it_software',
    'software developer': 'it_software',
    'web developer': 'it_software',
    'mobile developer': 'it_software',
    'app developer': 'it_software',
    'frontend': 'it_software',
    'backend': 'it_software',
    'fullstack': 'it_software',
    'full stack': 'it_software',
    'software': 'it_software',
    'it': 'it_software',
    'tech': 'it_software',
    'programming': 'it_software',
    'coding': 'it_software',
    'data scientist': 'it_software',
    'data analyst': 'it_software',
    'devops': 'it_software',
    'system administrator': 'it_software',
    'network admin': 'it_software',
    'database admin': 'it_software',
    'tech support': 'it_software',
    'it support': 'it_software',
    'cyber security': 'it_software',
    'it officer': 'it_software',
    'systems analyst': 'it_software',
    'technical support': 'it_software',
    'network engineer': 'it_software',
    'database developer': 'it_software',
    'cloud engineer': 'it_software',
    'ai engineer': 'it_software',
    'machine learning': 'it_software',
    
    // PHYSICAL ENGINEERING & TECHNICAL
    'mechanical engineer': 'engineering_technical',
    'electrical engineer': 'engineering_technical',
    'civil engineer': 'engineering_technical',
    'chemical engineer': 'engineering_technical',
    'petroleum engineer': 'engineering_technical',
    'structural engineer': 'engineering_technical',
    'process engineer': 'engineering_technical',
    'maintenance engineer': 'engineering_technical',
    'project engineer': 'engineering_technical',
    'site engineer': 'engineering_technical',
    'field engineer': 'engineering_technical',
    'production engineer': 'engineering_technical',
    'quality engineer': 'engineering_technical',
    'safety engineer': 'engineering_technical',
    'marine engineer': 'engineering_technical',
    'aerospace engineer': 'engineering_technical',
    'mining engineer': 'engineering_technical',
    'agricultural engineer': 'engineering_technical',
    'biomedical engineer': 'engineering_technical',
    'environmental engineer': 'engineering_technical',
    'industrial engineer': 'engineering_technical',
    'materials engineer': 'engineering_technical',
    'nuclear engineer': 'engineering_technical',
    'robotics engineer': 'engineering_technical',
    'telecommunications engineer': 'engineering_technical',
    'automotive engineer': 'engineering_technical',
    'construction engineer': 'engineering_technical',
    'technician': 'engineering_technical',
    'technical officer': 'engineering_technical',
    'maintenance': 'engineering_technical',
    
    // Special handling for generic "engineer"
    'engineer': 'engineering_technical', // Default to physical engineering
    
    // OTHER CATEGORIES (unchanged)
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
  
  // IMPROVED: Find job type in context with priority for exact matches
  for (const [job, category] of Object.entries(jobMapping)) {
    if (fullContext.includes(job)) {
      contextJobType = job;
      contextJobCategory = category;
      break;
    }
  }
  
  // SPECIAL HANDLING: Generic "engineer" - check for software context
  if (contextJobType === 'engineer' && !contextJobCategory) {
    if (fullContext.includes('software') || fullContext.includes('system') || 
        fullContext.includes('network') || fullContext.includes('database') || 
        fullContext.includes('cloud') || fullContext.includes('security')) {
      contextJobCategory = 'it_software';
      contextJobType = 'software engineer';
    } else {
      contextJobCategory = 'engineering_technical';
      contextJobType = 'engineer';
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
  
  // ENHANCED RESPONSES with proper category mapping
  
  // Handle specific patterns with context
  if (locations.map(l => l.toLowerCase()).includes(text) && contextJobCategory) {
    const locationName = text === 'port harcourt' ? 'Rivers' : text.charAt(0).toUpperCase() + text.slice(1);
    const friendlyJobName = getFriendlyJobName(contextJobCategory, contextJobType);
    
    return {
      action: 'search_jobs',
      response: `Searching for ${friendlyJobName} jobs in ${locationName}...`,
      filters: {
        title: contextJobCategory,
        location: locationName,
        remote: text === 'remote'
      }
    };
  }
  
  if (Object.keys(jobMapping).includes(text) && contextLocation) {
    const friendlyJobName = getFriendlyJobName(jobMapping[text], text);
    
    return {
      action: 'search_jobs', 
      response: `Looking for ${friendlyJobName} jobs in ${contextLocation}...`,
      filters: {
        title: jobMapping[text],
        location: contextLocation,
        remote: contextLocation === 'Remote'
      }
    };
  }
  
  // Both job and location detected
  if (contextJobCategory && contextLocation) {
    const friendlyJobName = getFriendlyJobName(contextJobCategory, contextJobType);
    
    return {
      action: 'search_jobs',
      response: `Searching ${friendlyJobName} jobs in ${contextLocation}...`,
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
    
    // Remove code block markers
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }
    
    // ADDED: Handle truncated JSON by attempting to complete it
    if (!cleaned.endsWith('}')) {
      // Try to find the last complete field
      const lastCommaIndex = cleaned.lastIndexOf(',');
      const lastCompleteField = cleaned.lastIndexOf('"', lastCommaIndex);
      
      if (lastCompleteField > 0) {
        // Truncate to last complete field and close JSON
        cleaned = cleaned.substring(0, lastCompleteField) + '}';
      } else {
        // Fallback: add closing brace
        cleaned += '}';
      }
    }
    
    const parsed = JSON.parse(cleaned);
    
    // ADDED: Validate required fields exist
    const requiredFields = ['overall_score', 'job_match_score', 'skills_score', 'experience_score', 'education_score'];
    const hasAllFields = requiredFields.every(field => typeof parsed[field] === 'number');
    
    if (!hasAllFields) {
      throw new Error('Missing required fields in JSON response');
    }
    
    return parsed;
    
  } catch (err) {
    logger.error('JSON parse failed', { 
      raw: (raw || '').substring(0, 200), 
      error: err.message,
      rawLength: (raw || '').length
    });
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

// Updated summary generator to reflect irrelevance

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
      response: 'Great – which location are you interested in? Lagos, Abuja, Port Harcourt, or Remote?'
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
      response: `Okay – looking for jobs in ${text}. What role are you interested in?`
    };
  }

  // Detect common role-only queries
  const commonRoles = ['accountant', 'developer', 'nurse', 'teacher', 'engineer', 'sales', 'marketing', 'manager'];
  if (commonRoles.some(role => text.includes(role))) {
    return {
      action: 'search_role',
      response: `Got it – searching for ${text} jobs. Do you want them in Lagos, Abuja, or another state?`
    };
  }

  return null;
}

function getFriendlyJobName(category, rawJobType) {
  const friendlyNames = {
    'it_software': 'Developer & IT',
    'engineering_technical': 'Engineering & Technical',
    'marketing_sales': 'Sales & Marketing',
    'accounting_finance': 'Accounting & Finance',
    'healthcare_medical': 'Healthcare & Medical',
    'education_training': 'Education & Training',
    'admin_office': 'Administration & Office',
    'management_executive': 'Management & Executive',
    'human_resources': 'Human Resources',
    'logistics_supply': 'Logistics & Supply Chain',
    'customer_service': 'Customer Service',
    'legal_compliance': 'Legal & Compliance',
    'media_creative': 'Media & Creative',
    'security_safety': 'Security & Safety',
    'construction_real_estate': 'Construction & Real Estate',
    'manufacturing_production': 'Manufacturing & Production',
    'retail_fashion': 'Retail & Fashion',
    'transport_driving': 'Transport & Driving',
    'other_general': 'General'
  };
  
  // Return friendly name or capitalize the raw job type
  if (friendlyNames[category]) {
    return friendlyNames[category];
  }
  
  if (rawJobType) {
    return rawJobType.split(' ').map(word => 
      word.charAt(0).toUpperCase() + word.slice(1)
    ).join(' ');
  }
  
  return 'Jobs';
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