// services/openai.js - Your EXACT reference + ONLY optimization features you requested

const { Queue, QueueEvents } = require('bullmq');
const crypto = require('crypto');
const redis = require('../config/redis');
const logger = require('../utils/logger');

// Enhanced queue configuration for better performance
const openaiQueue = new Queue('openai-tasks', { 
  connection: redis.duplicate(),
  defaultJobOptions: {
    attempts: 2,  // Reduced for faster failure
    backoff: {
      type: 'exponential',
      delay: 1000,  // Faster retry
    },
    removeOnComplete: {
      age: 300,
      count: 50,  // Clean up faster
    },
    removeOnFail: {
      age: 1800,  // Shorter retention
    },
    ttl: 10000,  // 10 second timeout
  },
});

// Create QueueEvents with separate connection
const queueEvents = new QueueEvents('openai-tasks', { 
  connection: redis.duplicate(),
});

queueEvents.on('ready', () => {
  logger.info('QueueEvents ready for openai-tasks');
});

queueEvents.on('error', (error) => {
  logger.error('QueueEvents error', { error: error.message });
});

class AIService {
  constructor() {
    this.queryCache = new Map();
    this.cacheMaxSize = 2000;  // Increased cache size for better performance
    this.cacheMaxAge = 10 * 60 * 1000;  // Increased to 10 minutes
    
    // Performance metrics (for monitoring)
    this.metrics = {
      cacheHits: 0,
      patternMatches: 0,
      aiCalls: 0,
      totalRequests: 0
    };
    
    setInterval(() => this.cleanCache(), 60000);
    setInterval(() => this.logMetrics(), 300000); // Log metrics every 5 minutes
  }

  async parseJobQuery(message, identifier = null, userContext = null) {
    this.metrics.totalRequests++;
    
    try {
      // LEVEL 1: Cache check (your existing logic)
      const cacheKey = this.getCacheKey(message);
      const cached = this.getFromCache(cacheKey);
      if (cached) {
        this.metrics.cacheHits++;
        logger.info('Cache hit', { identifier });
        return cached;
      }

      // LEVEL 2: Simple commands (your existing logic)
      const simpleResult = this.parseSimpleCommand(message);
      if (simpleResult) {
        logger.info('Used local parsing', { identifier, action: simpleResult.action });
        this.setCache(cacheKey, simpleResult);
        return simpleResult;
      }

      // LEVEL 3: Smart patterns (NEW - for better performance)
         const patternResult = this.parseSmartPatterns(message, userContext);
        if (patternResult) {
        this.metrics.patternMatches++;
        logger.info('Smart pattern match', { identifier, action: patternResult.action });
        this.setCache(cacheKey, patternResult);
        return patternResult;
      }

      // LEVEL 4: Rate limiting (your existing logic)
      const rateLimited = await this.checkRateLimit(identifier);
      if (rateLimited) {
        return {
          action: 'rate_limited',
          response: 'Please wait a moment before sending more requests. Type "help" for commands.'
        };
      }

      // LEVEL 5: AI processing (your existing logic)
      this.metrics.aiCalls++;
      logger.info('Using AI for complex query', { identifier });
      const aiResult = await this.parseWithAI(message, identifier, userContext);
      this.setCache(cacheKey, aiResult);
      return aiResult;

    } catch (error) {
      logger.error('parseJobQuery error', { error: error.message, identifier });
      return {
        action: 'error',
        response: 'I can help you find jobs! Try "find jobs in Lagos" or "help" for commands.'
      };
    }
  }

  // NEW: Smart patterns for better performance (handles obvious cases fast)

parseSmartPatterns(message, userContext = null) {
  const text = message.toLowerCase().trim();
  
  
  const sessionData = userContext?.sessionData || {};
  
  const singleJobTypes = ['developer', 'engineer', 'marketing', 'sales', 'manager', 'teacher', 'nurse', 'doctor'];
  
  if (singleJobTypes.includes(text)) {
    
    if (sessionData.lastLocation) {
      return {
        action: 'search_jobs',
        filters: {
          title: text,
          location: sessionData.lastLocation
        }
      };
    }
  }
  




  // Continue with existing logic...
  const completeSearch = this.matchCompleteJobSearch(text);
  if (completeSearch) {
    return {
      action: 'search_jobs',
      filters: completeSearch
    };
  }

  // Rest of existing method...
  return null;
}





  // NEW: Match complete job searches (job + location)
  matchCompleteJobSearch(text) {
   const locations = {
  // Original major cities
  'lagos': 'Lagos',
  'abuja': 'Abuja',
  'port harcourt': 'Port Harcourt',
  'portharcourt': 'Port Harcourt',
  'remote': 'Remote',
  
  // All 36 Nigerian States
  'abia': 'Abia',
  'adamawa': 'Adamawa', 
  'akwa ibom': 'Akwa Ibom',
  'anambra': 'Anambra',
  'bauchi': 'Bauchi',
  'bayelsa': 'Bayelsa',
  'benue': 'Benue',
  'borno': 'Borno',
  'cross river': 'Cross River',
  'delta': 'Delta',
  'ebonyi': 'Ebonyi',
  'edo': 'Edo',
  'ekiti': 'Ekiti',
  'enugu': 'Enugu',
  'gombe': 'Gombe',
  'imo': 'Imo',
  'jigawa': 'Jigawa',
  'kaduna': 'Kaduna',
  'kano': 'Kano',
  'katsina': 'Katsina',
  'kebbi': 'Kebbi',
  'kogi': 'Kogi',
  'kwara': 'Kwara',
  'niger': 'Niger',
  'ogun': 'Ogun',
  'ondo': 'Ondo',
  'osun': 'Osun',
  'oyo': 'Oyo',
  'plateau': 'Plateau',
  'rivers': 'Rivers',
  'sokoto': 'Sokoto',
  'taraba': 'Taraba',
  'yobe': 'Yobe',
  'zamfara': 'Zamfara',
  
  // FCT
  'fct': 'FCT',
  
  // Major cities for convenience
  'ibadan': 'Oyo',          // Ibadan is in Oyo state
  'jos': 'Plateau',         // Jos is in Plateau state
  'kano city': 'Kano',      // Kano city in Kano state
  'benin': 'Edo',           // Benin City is in Edo state
  'calabar': 'Cross River', // Calabar is in Cross River
  'uyo': 'Akwa Ibom',       // Uyo is in Akwa Ibom
  'warri': 'Delta',         // Warri is in Delta state
  'maiduguri': 'Borno',     // Maiduguri is in Borno
  'ilorin': 'Kwara',        // Ilorin is in Kwara
  'abeokuta': 'Ogun'        // Abeokuta is in Ogun
};



    const jobTypes = {
      'developer': ['developer', 'programmer', 'coder', 'software'],
      'designer': ['designer', 'ui', 'ux', 'graphic'],
      'manager': ['manager', 'management', 'lead', 'supervisor'],
      'analyst': ['analyst', 'analysis', 'data'],
      'engineer': ['engineer', 'engineering'],
      'marketing': ['marketing', 'marketer', 'digital marketing'],
      'sales': ['sales', 'salesman', 'saleswoman'],
      'teacher': ['teacher', 'tutor', 'instructor'],
      'driver': ['driver', 'driving'],
      'nurse': ['nurse', 'nursing'],
      'doctor': ['doctor', 'medical']
    };

    let filters = {};
    let hasLocation = false;
    let hasJobType = false;

    for (const [key, value] of Object.entries(locations)) {
      if (text.includes(key)) {
        filters.location = value;
        hasLocation = true;
        break;
      }
    }

    for (const [type, keywords] of Object.entries(jobTypes)) {
      if (keywords.some(keyword => text.includes(keyword))) {
        filters.title = type;
        hasJobType = true;
        break;
      }
    }

    // Only return if we have BOTH job type AND location
    if (hasLocation && hasJobType) {
      return filters;
    }

    return null;
  }

  // YOUR EXISTING parseWithAI method - UNCHANGED
  async parseWithAI(message, identifier, userContext = null) {
    try {
      const jobId = `${identifier}-${Date.now()}`;
      
      const job = await openaiQueue.add(
        'parse-query',
        { 
          message,
          userId: identifier,
          userContext: userContext || {},
          timestamp: Date.now(),
          platform: userContext?.platform || 'whatsapp'
        },
        {
          jobId: jobId,
          attempts: 2,
          backoff: { type: 'exponential', delay: 1000 }
        }
      );

      logger.info('Job added to queue', { jobId: job.id });

      try {
        const result = await job.waitUntilFinished(queueEvents, 8000);
        
        if (result && (result.action || result.response)) {
          logger.info('AI result received', { jobId: job.id });
          return result;
        }
        
        throw new Error('Invalid AI response structure');
        
      } catch (waitError) {
        logger.warn('waitUntilFinished failed, trying Redis', { 
          error: waitError.message,
          jobId: job.id 
        });
        
        const delays = [100, 200, 400, 800, 1600];
        
        for (const delay of delays) {
          const resultStr = await redis.get(`job-result:${job.id}`);
          if (resultStr) {
            try {
              const result = JSON.parse(resultStr);
              await redis.del(`job-result:${job.id}`);
              logger.info('Got result from Redis fallback', { jobId: job.id });
              return result;
            } catch (parseError) {
              logger.error('Failed to parse Redis result', { error: parseError.message });
            }
          }
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        return this.generateIntelligentFallback(message);
      }

    } catch (error) {
      logger.error('AI parsing error', { error: error.message, identifier });
      return this.generateIntelligentFallback(message);
    }
  }

  // YOUR EXISTING checkRateLimit method - UNCHANGED
  async checkRateLimit(identifier) {
    if (!identifier) return false;
    
    const key = `rate:ai:${identifier}`;
    const count = await redis.incr(key);
    
    if (count === 1) {
      await redis.expire(key, 60);
    }
    
    return count > 10;
  }

  // YOUR EXISTING cache methods - UNCHANGED
  getCacheKey(message) {
    return crypto.createHash('md5')
      .update(message.toLowerCase().trim())
      .digest('hex');
  }

  getFromCache(key) {
    const cached = this.queryCache.get(key);
    if (!cached) return null;
    
    if (Date.now() - cached.timestamp > this.cacheMaxAge) {
      this.queryCache.delete(key);
      return null;
    }
    
    return cached.data;
  }

  setCache(key, data) {
    if (this.queryCache.size >= this.cacheMaxSize) {
      const firstKey = this.queryCache.keys().next().value;
      this.queryCache.delete(firstKey);
    }
    
    this.queryCache.set(key, {
      data,
      timestamp: Date.now()
    });
  }

  cleanCache() {
    const now = Date.now();
    for (const [key, value] of this.queryCache.entries()) {
      if (now - value.timestamp > this.cacheMaxAge) {
        this.queryCache.delete(key);
      }
    }
  }

  // YOUR EXISTING generateIntelligentFallback method - UNCHANGED
  generateIntelligentFallback(message) {
    const text = message.toLowerCase();
    
    if (text.match(/^(hello|hi|hey|good morning|good afternoon|good evening)/)) {
      return {
        action: 'greeting',
        response: 'Hello! Welcome to SmartCVNaija! 🇳🇬\n\nI help people find jobs in Nigeria. What type of work are you looking for?'
      };
    }
    
    if (text.includes('job') || text.includes('work') || text.includes('looking for')) {
      return {
        action: 'clarify',
        response: 'I can help you find jobs! Which city interests you?\n\n📍 Lagos\n📍 Abuja\n📍 Port Harcourt\n📍 Remote opportunities\n\nJust tell me what you\'re looking for!'
      };
    }
    
    return {
      action: 'help',
      response: '🆘 Quick Commands:\n\n• "find jobs in Lagos"\n• "remote developer jobs"\n• "apply 1,2,3" - Apply to jobs\n• "status" - Check your usage\n• Upload CV to get started!\n\nWhat would you like to do?'
    };
  }

  // YOUR EXISTING parseSimpleCommand method - UNCHANGED
  parseSimpleCommand(message) {
    const text = message.toLowerCase().trim();

    const commands = {
      'reset': { action: 'reset', response: 'Session cleared! Ready to start fresh! 🚀' },
      'clear': { action: 'reset', response: 'Session cleared! Ready to start fresh! 🚀' },
      'status': { action: 'status', response: 'Checking your status...' },
      'usage': { action: 'status', response: 'Checking your usage...' },
      'help': { action: 'help' },
      'commands': { action: 'help' },
      'start': { action: 'greeting' },
      'menu': { action: 'help' },
    };

    if (commands[text]) {
      return commands[text];
    }

    for (const [key, value] of Object.entries(commands)) {
      if (text.includes(key)) {
        return value;
      }
    }

    if (text.startsWith('apply ')) {
      if (text.includes('all')) {
        return { action: 'apply_job', applyAll: true, jobNumbers: null };
      }
      
      const numbers = this.extractJobNumbers(text);
      if (numbers.length > 0) {
        return { action: 'apply_job', applyAll: false, jobNumbers: numbers };
      }
    }

    if (text === 'next' || text === 'more') {
      return { action: 'browse_next' };
    }
    if (text === 'previous' || text === 'prev' || text === 'back') {
      return { action: 'browse_previous' };
    }

    return null;
  }

  // YOUR EXISTING extractJobNumbers method - UNCHANGED
  extractJobNumbers(text) {
    const numbers = [];
    const matches = text.match(/\b\d+\b/g);
    
    if (matches) {
      matches.forEach(match => {
        const num = parseInt(match);
        if (num >= 1 && num <= 20) {
          numbers.push(num);
        }
      });
    }
    
    const commaMatch = text.match(/\d+(?:\s*,\s*\d+)*/);
    if (commaMatch) {
      const nums = commaMatch[0].split(',').map(n => parseInt(n.trim()));
      numbers.push(...nums.filter(n => n >= 1 && n <= 20));
    }
    
    return [...new Set(numbers)].sort((a, b) => a - b);
  }

  // YOUR EXISTING analyzeCV method - UNCHANGED
  async analyzeCV(cvText, jobTitle = null, identifier = null) {
    try {
      const job = await openaiQueue.add(
        'analyze-cv',
        { cvText, jobTitle, userId: identifier },
        { jobId: `cv-${identifier}-${Date.now()}` }
      );
      
      try {
        const result = await job.waitUntilFinished(queueEvents, 15000);
        return this.validateCVAnalysis(result) || this.getFallbackAnalysis(cvText, jobTitle);
      } catch (error) {
        logger.warn('CV analysis timeout', { identifier });
        return this.getFallbackAnalysis(cvText, jobTitle);
      }
    } catch (error) {
      logger.error('CV analysis error', { error: error.message });
      return this.getFallbackAnalysis(cvText, jobTitle);
    }
  }

  // YOUR EXISTING validateCVAnalysis method - UNCHANGED
  validateCVAnalysis(result) {
    if (!result || typeof result !== 'object') return null;
    
    if (result.content && typeof result.content === 'object') {
      result = result.content;
    }
    
    const requiredFields = [
      'overall_score', 'job_match_score', 'skills_score',
      'experience_score', 'education_score', 'experience_years'
    ];
    
    for (const field of requiredFields) {
      if (!(field in result)) return null;
    }
    
    return result;
  }

  // YOUR EXISTING generateCoverLetter method - UNCHANGED
  async generateCoverLetter(cvText, jobTitle = null, companyName = null, identifier = null) {
    try {
      const job = await openaiQueue.add(
        'generate-cover-letter',
        { cvText, jobTitle, companyName, userId: identifier },
        { jobId: `cover-${identifier}-${Date.now()}` }
      );
      
      try {
        const result = await job.waitUntilFinished(queueEvents, 10000);
        
        if (result?.content && result.content.length > 50) {
          return result.content;
        }
        if (typeof result === 'string' && result.length > 50) {
          return result;
        }
        
        return this.getFallbackCoverLetter(jobTitle, companyName);
      } catch (error) {
        logger.warn('Cover letter generation timeout', { identifier });
        return this.getFallbackCoverLetter(jobTitle, companyName);
      }
    } catch (error) {
      logger.error('Cover letter generation error', { error: error.message });
      return this.getFallbackCoverLetter(jobTitle, companyName);
    }
  }

  // YOUR EXISTING getFallbackAnalysis method - UNCHANGED
  getFallbackAnalysis(cvText, jobTitle = null) {
    const text = (cvText || '').toLowerCase();
    let overallScore = 50;
    let jobMatchScore = 50;

    if (text.includes('experience')) overallScore += 15;
    if (text.includes('education')) overallScore += 10;
    if (text.includes('skill')) overallScore += 10;

    if (jobTitle && text.includes(jobTitle.toLowerCase())) {
      jobMatchScore += 20;
    }
    
    return {
      overall_score: Math.min(Math.max(overallScore, 0), 100),
      job_match_score: Math.min(Math.max(jobMatchScore, 0), 100),
      skills_score: 60,
      experience_score: 50,
      education_score: 60,
      experience_years: 2,
      key_skills: ['Communication', 'Teamwork', 'Problem Solving'],
      relevant_skills: ['Professional Experience', 'Leadership'],
      education_level: 'Bachelor\'s',
      summary: 'Professional with relevant experience',
      strengths: ['Strong educational background', 'Good communication'],
      areas_for_improvement: ['More certifications', 'Industry experience'],
      recommendation: 'Good',
      cv_quality: 'Good',
      personalized_message: 'Great potential for the Nigerian job market!'
    };
  }

  // YOUR EXISTING getFallbackCoverLetter method - UNCHANGED
  getFallbackCoverLetter(jobTitle = null, companyName = null) {
    return `Dear Hiring Manager,

I am writing to express my strong interest in the ${jobTitle || 'position'} at ${companyName || 'your company'}.

My background and experience make me a qualified candidate for this role in Nigeria's competitive market. I have developed strong skills that align with your requirements and am confident in my ability to contribute to your team.

I would welcome the opportunity to discuss how my experience can benefit your organization. Thank you for considering my application.

Best regards,
[Your Name]`;
  }

  // NEW: Performance metrics logging (for monitoring only)
  logMetrics() {
    const total = this.metrics.totalRequests;
    if (total === 0) return;

    const cacheHitRate = Math.round((this.metrics.cacheHits / total) * 100);
    const patternRate = Math.round((this.metrics.patternMatches / total) * 100);
    const aiRate = Math.round((this.metrics.aiCalls / total) * 100);

    logger.info('Performance metrics', {
      totalRequests: total,
      cacheHitRate: `${cacheHitRate}%`,
      patternMatchRate: `${patternRate}%`,
      aiCallRate: `${aiRate}%`,
      cacheSize: this.queryCache.size
    });

    // Reset metrics
    this.metrics = { cacheHits: 0, patternMatches: 0, aiCalls: 0, totalRequests: 0 };
  }
}

module.exports = new AIService();
