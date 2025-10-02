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
    timeout: 90000  // CRITICAL: Reduced from 10000 to 90000
  },
  [AI_PROVIDERS.MISTRAL]: {
    url: 'https://api.mistral.ai/v1/chat/completions',
    apiKey: process.env.MISTRAL_API_KEY,
    model: 'mistral-small', // Fallback option
    maxTokens: 800,
    temperature: 0.6,
    timeout: 90000  // CRITICAL: Reduced from 12000 to 10000
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
// workers/openai.js - Replace the systemPrompt in parse-query handler

// Inside the parse-query handler, replace the systemPrompt with this:

// workers/openai.js - Replace the systemPrompt in parse-query handler

// Inside the parse-query handler, replace the systemPrompt with this:

const systemPrompt = `You are SmartCVNaija, a helpful Nigerian job search assistant.

PERSONALITY:
- Friendly, conversational Nigerian tone
- Answer questions about the service naturally
- Build rapport before pushing transactions
- Use simple language, max 50 words per response
- Be patient with exploratory questions

MAIN CAPABILITIES:
1. Job search across 36 Nigerian states + FCT
2. CV upload and processing  
3. Auto-apply service (₦1,000 for 30 days)
4. Natural conversation about the service

SERVICE INFORMATION (for when users ask questions):
- SmartCVNaija helps Nigerians find jobs and apply automatically
- We search thousands of jobs across all states and cities
- Users pay ₦1,000 for 30-day auto-apply service
- AI automatically applies to matching jobs daily with custom cover letters
- Users get daily email reports of applications
- Process: Search (free) → Pay ₦1,000 → Upload CV → AI auto-applies for 30 days
- Available 24/7 via WhatsApp

RESPONSE TYPES:

1. **Service Questions** (about_service action):
   - "What is this?" → Explain briefly: "SmartCVNaija helps you find jobs and auto-applies for you across Nigeria"
   - "How does it work?" → Explain process: "Search jobs → Pay ₦1,000 → Upload CV → AI auto-applies daily for 30 days with custom cover letters"
   - "What's the cost?" → "₦1,000 for 30-day auto-apply service with AI cover letters and daily email reports"
   - "Is it legit?" → Reassure: "Yes! We help 100+ Nigerians daily with automated applications. Check our channel for testimonials"

2. **Casual Chat** (chat action):
   - Greetings: "Hello! I help Nigerians find jobs. What type of work interests you?"
   - Small talk: Keep brief, redirect to service
   - Random questions: Answer if simple, otherwise redirect

3. **Job Search** (search_jobs action):
   - When user mentions BOTH job type AND location
   - Examples: "developer jobs in Lagos", "remote marketing jobs"
   - Return filters: {title: "category", location: "State", remote: true/false}

4. **Clarification** (clarify action):
   - When user mentions ONLY job type: "What location? Lagos, Abuja, or Remote?"
   - When user mentions ONLY location: "What type of jobs? Developer, Sales, Accounting?"

JOB CATEGORIES (use exact values for filters.title):
- engineering_technical (developer, programmer, IT, software)
- marketing_sales (sales, marketing, business development)
- accounting_finance (accountant, finance, audit)
- healthcare_medical (nurse, doctor, medical)
- education_training (teacher, trainer, tutor)
- admin_office (admin, secretary, clerk)
- management_executive (manager, supervisor, director)
- customer_service (customer service, support)
- human_resources (HR, recruiter, talent)
- logistics_supply (logistics, warehouse)
- transport_driving (driver, transport, delivery)
- security_safety (security, guard, safety)
- other_general (general jobs, entry level)

CRITICAL RULES:
1. For service questions → Use "about_service" action
2. For casual chat → Use "chat" action  
3. For job searches → Use "search_jobs" action ONLY when BOTH job + location present
4. For partial info → Use "clarify" action
5. Keep responses under 50 words
6. Be natural and conversational
7. ONLY answer questions about SmartCVNaija job search service - politely redirect other topics

OFF-TOPIC HANDLING:
If user asks about topics unrelated to jobs/SmartCVNaija (politics, news, general knowledge, etc.):
{
  "action": "chat",
  "response": "I focus on helping Nigerians find jobs. What type of work are you looking for?"
}

RESPONSE FORMAT (JSON):
{
  "action": "about_service|chat|search_jobs|clarify|help",
  "response": "your friendly response here",
  "filters": {"title": "category", "location": "State", "remote": false}
}

EXAMPLES:

User: "What is smartcvnaija?"
{
  "action": "about_service",
  "response": "SmartCVNaija helps Nigerians find jobs automatically! Pay ₦1,000 for 30 days - AI applies to matching jobs daily with custom cover letters. Want to try?"
}

User: "How far?"
{
  "action": "chat",
  "response": "I dey o! I help people find jobs in Nigeria. What type of work you dey find?"
}

User: "developer jobs in Lagos"
{
  "action": "search_jobs",
  "response": "Searching for developer jobs in Lagos...",
  "filters": {"title": "engineering_technical", "location": "Lagos", "remote": false}
}

User: "I need accounting jobs"
{
  "action": "clarify",
  "response": "Nice! Where you wan work? Lagos, Abuja, or remote?"
}

Remember: Build trust through conversation, explain the 30-day auto-apply service naturally!`;

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
      else if (job.name === 'expand-query') {
  const { userQuery, jobCategory } = job.data;
  
  logger.info('Expanding query with AI', { userQuery, jobCategory });
  
  try {
    const systemPrompt = `You are an expert at understanding job search intent and expanding queries for better matching.

Given a user's job search query, generate:
1. must_include: Core keywords that MUST be in job listings (3-6 terms)
2. must_exclude: Terms that indicate wrong job types (2-4 terms)
3. related_terms: Related skills/terms that boost relevance (3-5 terms)

Example:
Input: "React developer jobs"
Output: {
  "must_include": ["react", "frontend", "javascript", "web developer"],
  "must_exclude": ["java developer", "python developer", "backend only"],
  "related_terms": ["typescript", "next.js", "vue", "redux"]
}

Rules:
- Be specific but not too narrow
- Exclude terms that indicate completely different job types
- Related terms should be genuinely related technologies/skills
- Consider Nigerian job market context

Return ONLY valid JSON.`;

    const userPrompt = `Expand this job search query: "${userQuery}"${jobCategory ? `\nJob Category: ${jobCategory}` : ''}`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    const aiResponse = await callAIWithContext(messages, null, {
      maxTokens: 300,
      temperature: 0.4
    });

    const expansion = parseJSON(aiResponse.content, {});

    // Validate response
    if (!expansion.must_include || !Array.isArray(expansion.must_include)) {
      throw new Error('Invalid expansion format');
    }

    logger.info('Query expansion successful', {
      userQuery,
      mustIncludeCount: expansion.must_include.length,
      mustExcludeCount: expansion.must_exclude?.length || 0
    });

    return {
      must_include: expansion.must_include,
      must_exclude: expansion.must_exclude || [],
      related_terms: expansion.related_terms || [],
      confidence: 0.9
    };

  } catch (error) {
    logger.error('Query expansion failed', {
      userQuery,
      error: error.message
    });
    
    // Return basic fallback
    return {
      must_include: [userQuery.toLowerCase()],
      must_exclude: [],
      related_terms: [],
      confidence: 0.5
    };
  }
}

// ============================================
// NEW JOB TYPE 2: ATS Analysis
// ============================================
else if (job.name === 'ats-analysis') {
  const { cvText, jobTitle, jobDescription, jobRequirements, jobExperience, jobCategory } = job.data;
  
  logger.info('Performing ATS analysis', { jobTitle, jobCategory });
  
  try {
    const systemPrompt = `You are an ATS (Applicant Tracking System) expert analyzing CV compatibility with job requirements.

Analyze the CV against the job and provide:
1. matched_keywords: Keywords found in both CV and job (array of strings)
2. missing_keywords: Required keywords missing from CV (array of strings)
3. skill_match_score: 0-100 score for skills alignment
4. experience_match_score: 0-100 score for experience level match
5. education_match_score: 0-100 score for education match
6. strengths: What's strong in the CV for this job (array of strings, max 3)
7. weaknesses: What's missing or weak (array of strings, max 3)
8. recommendations: How to improve CV (array of strings, max 3)

Be objective and practical. Consider Nigerian job market standards.

Return ONLY valid JSON with all fields.`;

    const jobInfo = `
Job Title: ${jobTitle}
Category: ${jobCategory || 'Not specified'}
Description: ${jobDescription ? jobDescription.substring(0, 500) : 'Not provided'}
Requirements: ${jobRequirements ? jobRequirements.substring(0, 500) : 'Not provided'}
Experience: ${jobExperience || 'Not specified'}
`;

    const cvInfo = `CV Content (first 2000 chars): ${cvText.substring(0, 2000)}`;

    const userPrompt = `${jobInfo}\n\n${cvInfo}\n\nAnalyze CV compatibility and return JSON.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    const aiResponse = await callAIWithContext(messages, null, {
      maxTokens: 800,
      temperature: 0.3
    });

    const analysis = parseJSON(aiResponse.content, {});

    // Validate and set defaults
    const result = {
      matched_keywords: analysis.matched_keywords || [],
      missing_keywords: analysis.missing_keywords || [],
      skill_match_score: analysis.skill_match_score || 50,
      experience_match_score: analysis.experience_match_score || 50,
      education_match_score: analysis.education_match_score || 50,
      strengths: analysis.strengths || ['CV submitted'],
      weaknesses: analysis.weaknesses || ['Further analysis needed'],
      recommendations: analysis.recommendations || ['Review job description carefully']
    };

    logger.info('ATS analysis complete', {
      jobTitle,
      skillScore: result.skill_match_score,
      matchedCount: result.matched_keywords.length
    });

    return result;

  } catch (error) {
    logger.error('ATS analysis failed', {
      jobTitle,
      error: error.message
    });
    
    // Return basic fallback analysis
    return {
      matched_keywords: [],
      missing_keywords: [],
      skill_match_score: 50,
      experience_match_score: 50,
      education_match_score: 50,
      strengths: ['CV submitted for review'],
      weaknesses: ['Unable to perform detailed analysis'],
      recommendations: ['Ensure CV is well-formatted and contains relevant keywords']
    };
  }
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
function extractUserInfoTraditional(cvText, identifier) {
  try {
    const lines = cvText.split('\n').filter(line => line.trim());
    let extractedName = '';
    
    // Look for name patterns anywhere in the document
    const namePatterns = [
      // Look for "Cynthia Igbonai Bakare" pattern
      /([A-Z][a-z]+\s+[A-Z][a-z]+\s+[A-Z][a-z]+)\s*Nationality:/i,
      // Name before nationality
      /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\s*(?:Nationality|Date of birth|Gender):/i,
      // Name in structured format
      /(?:Name|Full Name)[:\s]*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/i,
      // Name at document start (original pattern)
      /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/m
    ];
    
    for (const pattern of namePatterns) {
      const match = cvText.match(pattern);
      if (match && match[1]) {
        const candidate = match[1].trim();
        if (candidate !== 'ABOUT ME' && !candidate.includes('Experience')) {
          extractedName = candidate;
          break;
        }
      }
    }
    
    // STRATEGY 2: Check first non-header lines
    if (!extractedName) {
      // Skip common headers and look for actual content
      let startIndex = 0;
      for (let i = 0; i < Math.min(10, lines.length); i++) {
        const line = lines[i].toLowerCase();
        if (line.includes('personal information') || 
            line.includes('contact details') ||
            line.includes('cv') || 
            line.includes('resume')) {
          startIndex = i + 1;
          break;
        }
      }
      
      // Look at lines after headers
      for (let i = startIndex; i < Math.min(startIndex + 5, lines.length); i++) {
        const line = lines[i];
        // Remove bullet points and clean
        const cleaned = line.replace(/^[•\-\*]\s*/, '').trim();
        
        // Check if this looks like a name
        const namePattern = /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})$/;
        const match = cleaned.match(namePattern);
        
        if (match) {
          const candidate = match[1];
          // Exclude known non-names
          const excludeTerms = ['Team Leadership', 'Team Leader', 'Project Manager', 
                               'Skills', 'Experience', 'Education', 'Professional'];
          
          const isExcluded = excludeTerms.some(term => 
            candidate.toLowerCase().includes(term.toLowerCase())
          );
          
          if (!isExcluded) {
            extractedName = candidate;
            break;
          }
        }
      }
    }
    
    // STRATEGY 3: Look near email addresses (names often appear right before email)
    if (!extractedName) {
      const emailPattern = /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s*\n[•\-\*]?\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/;
      const match = cvText.match(emailPattern);
      if (match && match[1]) {
        const candidate = match[1].trim();
        if (!candidate.toLowerCase().includes('team') && 
            !candidate.toLowerCase().includes('leadership')) {
          extractedName = candidate;
        }
      }
    }

    // Email extraction
    const emailPattern = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
    const emailMatches = cvText.match(emailPattern);
    let extractedEmail = '';
    
    if (emailMatches) {
      for (const email of emailMatches) {
        if (!email.includes('example.com') && 
            !email.includes('domain.com') &&
            !email.includes('email.com') &&
            !email.includes('test.com') &&
            !email.includes('smartcvnaija.com')) {
          extractedEmail = email;
          break;
        }
      }
    }

    // Phone extraction
    const phonePatterns = [
      /(?:\+234|234|0)[\d\s-]{10,14}/g,
      /(?:\+234|234)\s*\d{10}/g,
      /0\d{10}/g
    ];
    
    let extractedPhone = '';
    for (const pattern of phonePatterns) {
      const phoneMatch = cvText.match(pattern);
      if (phoneMatch) {
        extractedPhone = phoneMatch[0].trim();
        break;
      }
    }

    logger.info('Name extraction debug', {
      identifier: identifier.substring(0, 6) + '***',
      extractedName: extractedName || 'NOT FOUND',
      extractedEmail: extractedEmail,
      extractedPhone: extractedPhone,
      firstFewLines: lines.slice(0, 5).join(' | ')
    });

    return {
      name: extractedName,
      email: extractedEmail,
      phone: extractedPhone || identifier
    };

  } catch (error) {
    logger.error('User info extraction failed', { 
      identifier: identifier.substring(0, 6) + '***',
      error: error.message 
    });
    return {
      name: '',
      email: '',
      phone: identifier
    };
  }
}
function enhancedFallbackExtraction(cvText, identifier, regexData = {}, aiData = {}) {
  logger.info('Performing enhanced fallback extraction', {
    identifier: identifier.substring(0, 6) + '***',
    hasRegex: !!regexData.name,
    hasAI: !!aiData.name
  });

  const result = {
    name: selectBestName(regexData.name, aiData.name, cvText),
    email: selectBestEmail(regexData.email, aiData.email, cvText),
    phone: selectBestPhone(regexData.phone, aiData.phone, identifier),
    source: 'enhanced_fallback'
  };

  // Final validation and cleanup
  if (!result.name) {
    result.name = extractNameFromEmail(result.email) || extractNameFromText(cvText) || '';
  }

  logger.info('Enhanced fallback extraction completed', {
    identifier: identifier.substring(0, 6) + '***',
    finalName: result.name || 'NONE',
    finalEmail: result.email || 'NONE',
    source: result.source
  });

  return result;
}

function selectBestName(regex, ai, cvText) {
  // ALWAYS prefer AI if it has a valid name
  if (ai && ai.length >= 4 && ai.split(' ').length >= 2 && 
      !ai.toLowerCase().includes('team') && 
      !ai.toLowerCase().includes('leadership')) {
    return ai;
  }
  
  // Only use regex if AI completely failed
  if (regex && regex.length >= 4 && 
      !regex.toLowerCase().includes('team') && 
      !regex.toLowerCase().includes('leadership')) {
    return regex;
  }
  
  // Last resort: try direct extraction
  return extractNameFromText(cvText) || '';
}

function selectBestEmail(regex, ai, cvText) {
  // Prefer AI if valid
  if (ai && ai.includes('@') && ai.includes('.')) {
    return ai;
  }
  
  // Fallback to regex
  if (regex && regex.includes('@')) {
    return regex;
  }
  
  return '';
}

function selectBestPhone(regex, ai, identifier) {
  // Prefer AI if it looks like a proper phone number
  if (ai && (ai.startsWith('+234') || ai.startsWith('0') || ai.startsWith('234'))) {
    return ai;
  }
  
  // Fallback to regex
  if (regex && regex !== identifier) {
    return regex;
  }
  
  return identifier;
}

function extractNameFromEmail(email) {
  if (!email || !email.includes('@')) return '';
  
  const prefix = email.split('@')[0];
  // Simple name extraction for common patterns
  if (prefix.includes('.')) {
    return prefix.split('.').map(part => 
      part.charAt(0).toUpperCase() + part.slice(1)
    ).join(' ');
  }
  
  return '';
}

function extractNameFromText(cvText) {
  if (!cvText) return '';
  
  const lines = cvText.split('\n').slice(0, 10); // First 10 lines
  
  for (const line of lines) {
    const words = line.trim().split(/\s+/);
    if (words.length >= 2 && words.length <= 4) {
      const potential = words.join(' ');
      // Simple validation
      if (potential.length >= 4 && /^[A-Za-z\s\-'.]+$/.test(potential)) {
        return potential;
      }
    }
  }
  
  return '';
}
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
    
    const parsed = JSON.parse(cleaned);
    
    // FIXED: For user info extraction, check for name/email fields
    if (parsed.name !== undefined || parsed.email !== undefined || parsed.confidence !== undefined) {
      return parsed; // Valid user info response
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