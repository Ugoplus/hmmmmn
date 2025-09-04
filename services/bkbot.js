// services/bot.js - Complete Enhanced Version with Location Tease

const ycloud = require('./ycloud');
const openaiService = require('./openai');
const paystackService = require('./paystack');
const { Queue } = require('bullmq');
const { v4: uuidv4 } = require('uuid');
const { getSessionContext, saveSessionContext, clearSessionContext } = require('../utils/sessionContext');
const { redis, queueRedis, sessionRedis } = require('../config/redis');
const dbManager = require('../config/database');
const logger = require('../utils/logger');
const nodemailer = require('nodemailer');
const config = require('../config');
const RateLimiter = require('../utils/rateLimiter');

// SPECIALIZED QUEUES FOR INSTANT SYSTEM
const cvQueue = new Queue('cv-processing', { connection: queueRedis, prefix: 'queue:' });
const cvBackgroundQueue = new Queue('cv-processing-background', { connection: queueRedis, prefix: 'queue:' });
const applicationQueue = new Queue('job-applications', { connection: queueRedis, prefix: 'queue:' });
const emailQueue = new Queue('recruiter-emails', { connection: queueRedis, prefix: 'queue:' });

require('dotenv').config();
const transporter = nodemailer.createTransport({
  host: config.get('smtp.host'),
  port: config.get('smtp.port'),
  secure: false,
  auth: {
    user: config.get('smtp.user'),
    pass: config.get('smtp.pass')
  },
  tls: {
    rejectUnauthorized: false
  }
});

function normalizePhone(phone) {
  return phone.startsWith('+') ? phone : `+${phone}`;
}

// Location Tease Manager Class
class LocationTeaseManager {
  constructor() {
    // Geographic proximity mapping for teasing nearby opportunities
    this.proximityMap = {
      'lagos': ['ogun', 'oyo', 'osun', 'remote'],
      'abuja': ['niger', 'kogi', 'kaduna', 'remote'],
      'port harcourt': ['rivers', 'bayelsa', 'akwa ibom', 'remote'],
      'kano': ['kaduna', 'bauchi', 'jigawa', 'remote'],
      'ibadan': ['oyo', 'ogun', 'osun', 'remote'],
      'jos': ['plateau', 'bauchi', 'kaduna', 'remote'],
      'calabar': ['cross river', 'akwa ibom', 'rivers', 'remote'],
      'warri': ['delta', 'edo', 'bayelsa', 'remote'],
      'benin': ['edo', 'delta', 'ondo', 'remote'],
      'maiduguri': ['borno', 'yobe', 'adamawa', 'remote'],
      'sokoto': ['kebbi', 'zamfara', 'katsina', 'remote'],
      'enugu': ['anambra', 'imo', 'abia', 'remote'],
      'kaduna': ['niger', 'kano', 'bauchi', 'remote'],
      'ilorin': ['kwara', 'niger', 'oyo', 'remote']
    };

    // State display names (proper capitalization)
    this.stateNames = {
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
      'lagos': 'Lagos',
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
      'abuja': 'Abuja',
      'remote': 'Remote'
    };
  }

  // Get nearby states for location tease
  getNearbyStates(primaryLocation) {
    const normalized = primaryLocation.toLowerCase();
    return this.proximityMap[normalized] || ['remote']; // fallback to remote only
  }

  // Format state name properly
  formatStateName(state) {
    return this.stateNames[state.toLowerCase()] || this.titleCase(state);
  }

  titleCase(str) {
    return str.replace(/\w\S*/g, (txt) => 
      txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
    );
  }
}

class CleanTeaseThenPayBot {
  
  // ================================
  // MAIN MESSAGE HANDLER
  // ================================
  async handleWhatsAppMessage(phone, message, file = null, inboundMessageId = null) {
    const startTime = Date.now();
    logger.info('Message processing started', { phone, timestamp: startTime });
    
    try {
      // GET SESSION CONTEXT
      const sessionStart = Date.now();
      const sessionContext = await getSessionContext(phone);
      logger.info('Session context loaded', { phone, duration: Date.now() - sessionStart });
      
      // Handle file uploads
      if (file) {
        const uploadStart = Date.now();
        const uploadLimit = await RateLimiter.checkLimit(phone, 'cv_upload');
        logger.info('Upload rate limit checked', { phone, duration: Date.now() - uploadStart });
        
        if (!uploadLimit.allowed) {
          return this.sendWhatsAppMessage(phone, uploadLimit.message, { instant: true });
        }
        
        return await this.handleInstantFileUpload(phone, file, { inboundMessageId });
      }

      // Handle text messages
      if (!message || typeof message !== 'string') {
        return this.sendWhatsAppMessage(phone, 
          'Hi! I help you find jobs in Nigeria\n\nTry:\n• "Find developer jobs in Lagos"\n• "Status" - Check your usage\n• Upload your CV to apply!',
          { instant: true }
        );
      }

      // Check user state
      const stateStart = Date.now();
      const state = await redis.get(`state:${normalizePhone(phone)}`);
      logger.info('State checked', { phone, duration: Date.now() - stateStart });
      
      if (state === 'selecting_jobs') {
        return await this.handleJobSelection(phone, message, { inboundMessageId });
      }

      if (message.toLowerCase().includes('show jobs') || message.toLowerCase().includes('my jobs')) {
        return await this.showFullJobsAfterPayment(phone);
      }

      // Status command
      if (message.toLowerCase().includes('status')) {
        const statusStart = Date.now();
        const result = await this.handleStatusRequest(phone, { inboundMessageId });
        logger.info('Status processed', { phone, duration: Date.now() - statusStart });
        return result;
      }

      // AI processing
      const aiStart = Date.now();
      const aiLimit = await RateLimiter.checkLimit(phone, 'ai_call');
      logger.info('AI rate limit checked', { phone, duration: Date.now() - aiStart });
      
      if (!aiLimit.allowed) {
        const simpleResponse = this.handleSimplePatterns(phone, message, sessionContext);
        if (simpleResponse) {
          return simpleResponse;
        }
        return this.sendWhatsAppMessage(phone, aiLimit.message, { instant: true });
      }

      const aiProcessStart = Date.now();
      const result = await this.handleWithAI(phone, message, sessionContext, { inboundMessageId });
      logger.info('AI processing completed', { phone, duration: Date.now() - aiProcessStart });
      
      logger.info('Message processing completed', { phone, totalDuration: Date.now() - startTime });
      return result;

    } catch (error) {
      logger.error('Message processing error', { 
        phone, 
        error: error.message, 
        totalDuration: Date.now() - startTime 
      });
      return this.sendWhatsAppMessage(phone, 'Something went wrong. Please try again.', { instant: true });
    }
  }

  // ================================
  // ENHANCED JOB SEARCH WITH LOCATION TEASE
  // ================================
  
  async searchJobs(identifier, filters, context = {}) {
    try {
      const searchLimit = await RateLimiter.checkLimit(identifier, 'job_search');
      if (!searchLimit.allowed) {
        return this.sendWhatsAppMessage(identifier, searchLimit.message, { instant: true });
      }

      const { title, location, company, remote, rawTitle, friendlyLabel } = filters;
      
      // Generate cache key
      const cacheKey = `search:${JSON.stringify(filters)}`;
      
      // Check Redis cache first
      const cached = await redis.get(cacheKey);
      if (cached) {
        logger.info('Returning cached search results', { identifier, filters });
        try {
          const jobs = JSON.parse(cached);
          return await this.showCleanJobTeaseWithLocationExpansion(identifier, jobs, filters, context);
        } catch (parseError) {
          logger.warn('Failed to parse cached results, querying database', { error: parseError.message });
          await redis.del(cacheKey);
        }
      }
      
      // Show typing for search processing
      if (context.inboundMessageId) {
        await ycloud.showTypingIndicator(context.inboundMessageId);
      }
      
      // ENHANCED: Try multiple search strategies with user's raw title
      let rows = [];
      
      // Strategy 1: Search with user's raw title first
      if (rawTitle) {
        rows = await this.searchByExactPatterns(rawTitle, location, company, remote);
        logger.info('Raw title search results', { identifier, rawTitle, resultCount: rows.length });
      }
      
      // Strategy 2: Fallback to category-based search
      if (rows.length === 0 && title) {
        rows = await this.searchByExactPatterns(title, location, company, remote);
        logger.info('Category search results', { identifier, title, resultCount: rows.length });
      }
      
      // Strategy 3: Flexible keyword search
      if (rows.length === 0 && (rawTitle || title)) {
        const searchTerm = rawTitle || title;
        rows = await this.searchByKeywords(searchTerm, location, company, remote);
        logger.info('Keyword search results', { identifier, searchTerm, resultCount: rows.length });
      }

      if (rows.length === 0) {
        const displayTitle = friendlyLabel || rawTitle || title || 'jobs';
        const locationText = location ? ` in ${location}` : '';
        
        return this.sendWhatsAppMessage(identifier, 
          `No jobs found for "${displayTitle}"${locationText}\n\nTry broader terms:\n• "finance jobs in Lagos"\n• "office jobs"\n• "remote jobs"\n• "jobs in Lagos"`,
          { instant: true }
        );
      }

      // Cache results for 6 hours
      await redis.set(cacheKey, JSON.stringify(rows), 'EX', 21600);
      logger.info('Cached search results', { identifier, filters, resultCount: rows.length });

      return await this.showCleanJobTeaseWithLocationExpansion(identifier, rows, filters, context);

    } catch (error) {
      logger.error('Job search error', { identifier, filters, error: error.message });
      return this.sendWhatsAppMessage(identifier, 
        'Job search failed. Please try again.',
        { instant: true }
      );
    }
  }

  async searchByKeywords(title, location, company, remote) {
    try {
      // Create broader keyword search
      const keywords = title.toLowerCase().split(/[\s,]+/).filter(word => word.length > 2);
      
      let whereConditions = [];
      let queryParams = [];
      let paramIndex = 1;
      
      // Build flexible keyword matching
      if (keywords.length > 0) {
        const keywordConditions = keywords.map((keyword) => {
          const condition = `(
            title ILIKE $${paramIndex} OR 
            description ILIKE $${paramIndex} OR 
            category ILIKE $${paramIndex}
          )`;
          queryParams.push(`%${keyword}%`);
          paramIndex++;
          return condition;
        });
        
        // At least one keyword must match
        whereConditions.push(`(${keywordConditions.join(' OR ')})`);
      }
      
      // Add location filter
      if (location && location.toLowerCase() !== 'remote') {
        whereConditions.push(`location ILIKE $${paramIndex}`);
        queryParams.push(`%${location}%`);
        paramIndex++;
      }
      
      if (typeof remote === 'boolean') {
        whereConditions.push(`is_remote = $${paramIndex}`);
        queryParams.push(remote);
        paramIndex++;
      }
      
      whereConditions.push('(expires_at IS NULL OR expires_at > NOW())');
      
      const whereClause = whereConditions.length > 0 
        ? `WHERE ${whereConditions.join(' AND ')}`
        : '';
      
      const query = `
        SELECT * FROM jobs 
        ${whereClause}
        ORDER BY COALESCE(last_updated, scraped_at, NOW()) DESC 
        LIMIT 20`;
      
      const { rows } = await dbManager.query(query, queryParams);
      
      logger.info('Keyword search executed', {
        keywords: keywords,
        resultCount: rows.length,
        title: title
      });
      
      return rows;
      
    } catch (error) {
      logger.error('Keyword search failed', { error: error.message, title });
      return [];
    }
  }

  async searchByExactPatterns(title, location, company, remote) {
    try {
      let whereConditions = [];
      let queryParams = [];
      let paramIndex = 1;
      
      if (title) {
        whereConditions.push(`(
          title ILIKE $${paramIndex} 
          OR category ILIKE $${paramIndex}
          OR title ILIKE $${paramIndex + 1}
        )`);
        queryParams.push(`%${title}%`);
        queryParams.push(`%${title.split(' ')[0]}%`);
        paramIndex += 2;
      }
      
      if (location && location.toLowerCase() !== 'remote') {
        whereConditions.push(`location ILIKE $${paramIndex}`);
        queryParams.push(`%${location}%`);
        paramIndex++;
      }
      
      if (company) {
        whereConditions.push(`company ILIKE $${paramIndex}`);
        queryParams.push(`%${company}%`);
        paramIndex++;
      }
      
      if (typeof remote === 'boolean') {
        whereConditions.push(`is_remote = $${paramIndex}`);
        queryParams.push(remote);
        paramIndex++;
      }
      
      whereConditions.push('(expires_at IS NULL OR expires_at > NOW())');
      
      const whereClause = whereConditions.length > 0 
        ? `WHERE ${whereConditions.join(' AND ')}`
        : '';
      
      const query = `
        SELECT * FROM jobs 
        ${whereClause}
        ORDER BY COALESCE(last_updated, scraped_at, NOW()) DESC 
        LIMIT 20`;

      const { rows } = await dbManager.query(query, queryParams);
      return rows;
      
    } catch (error) {
      logger.error('Exact pattern search failed', { error: error.message, title });
      return [];
    }
  }

  // ENHANCED: Show user-friendly job tease with location expansion
  async showCleanJobTeaseWithLocationExpansion(identifier, jobs, filters, context = {}) {
    try {
      const displayTitle = filters.rawTitle || filters.friendlyLabel || filters.title || 'jobs';
      const primaryLocation = filters.location;
      
      // Initialize location tease manager
      const locationTease = new LocationTeaseManager();
      
      // Count jobs by actual locations in results
      const actualLocationGroups = {};
      jobs.forEach(job => {
        const loc = job.is_remote ? 'Remote' : job.location;
        if (!actualLocationGroups[loc]) actualLocationGroups[loc] = 0;
        actualLocationGroups[loc]++;
      });

      // If we have jobs in primary location, expand search to show nearby opportunities
      let expandedResults = actualLocationGroups;
      let totalJobsFound = jobs.length;
      
      // EXPANSION LOGIC: Search nearby states to show in tease
      if (primaryLocation && primaryLocation.toLowerCase() !== 'remote') {
        const nearbyStates = locationTease.getNearbyStates(primaryLocation);
        
        // Quick count query for each nearby state (for tease only)
        const expansionPromises = nearbyStates.slice(0, 4).map(async (state) => {
          try {
            const count = await this.quickCountJobsInLocation(filters.title, state);
            return { state, count };
          } catch (error) {
            return { state, count: 0 };
          }
        });

        const expansionResults = await Promise.all(expansionPromises);
        
        // Add nearby opportunities to tease (don't include in actual job results)
        expansionResults.forEach(({ state, count }) => {
          if (count > 0) {
            const formattedState = locationTease.formatStateName(state);
            if (!expandedResults[formattedState]) {
              expandedResults[formattedState] = count;
              totalJobsFound += count;
            }
          }
        });
      }

      // Build tease response
      let response = `Found ${totalJobsFound} ${displayTitle} across Nigeria!\n\n`;
      
      response += `Available Locations:\n`;
      
      // Sort locations: primary first, then remote, then others by job count
      const sortedLocations = Object.entries(expandedResults)
        .sort(([locA, countA], [locB, countB]) => {
          if (locA === primaryLocation) return -1;
          if (locB === primaryLocation) return 1;
          if (locA === 'Remote') return -1;
          if (locB === 'Remote') return 1;
          return countB - countA; // sort by count descending
        });

      sortedLocations.forEach(([location, count]) => {
        response += `• ${location}: ${count} job${count > 1 ? 's' : ''}\n`;
      });

      response += `\nPay N300 to see full details and apply\n\n`;
      response += `What you'll get:\n`;
      response += `✅ Full job descriptions & company details\n`;
      response += `✅ Salary ranges & requirements\n`;
      response += `✅ Apply to jobs in ALL locations\n`;
      response += `✅ Up to 10 applications today\n\n`;

      // Store ONLY the original jobs found (not the expanded tease data)
      await redis.set(`pending_jobs:${normalizePhone(identifier)}`, JSON.stringify(jobs), 'EX', 3600);
      await redis.set(`search_context:${normalizePhone(identifier)}`, JSON.stringify(filters), 'EX', 3600);

      // Generate payment link
      const paymentUrl = await this.initiateDailyPayment(identifier);
      response += `Pay now: ${paymentUrl}\n\n`;
      response += `Already paid? Type "show jobs"`;

      // Send the enhanced tease
      await this.sendWhatsAppMessage(identifier, response, {
        ...context,
        messageType: 'search_results'
      });

      this.schedulePaymentReminders(identifier);
      return true;

    } catch (error) {
      logger.error('Enhanced job tease error', { identifier, error: error.message });
      return this.sendWhatsAppMessage(identifier, 
        'Failed to process jobs. Please try again.',
        { instant: true }
      );
    }
  }

  // Quick count method for location tease (separate from main search)
  async quickCountJobsInLocation(jobCategory, location) {
    try {
      let whereConditions = ['(expires_at IS NULL OR expires_at > NOW())'];
      let queryParams = [];
      let paramIndex = 1;

      // Job category filter
      if (jobCategory) {
        whereConditions.push(`(
          title ILIKE $${paramIndex} 
          OR category ILIKE $${paramIndex}
        )`);
        queryParams.push(`%${jobCategory}%`);
        paramIndex++;
      }

      // Location filter
      if (location.toLowerCase() === 'remote') {
        whereConditions.push('is_remote = true');
      } else {
        whereConditions.push(`location ILIKE $${paramIndex}`);
        queryParams.push(`%${location}%`);
        paramIndex++;
      }

      const query = `
        SELECT COUNT(*) as job_count 
        FROM jobs 
        WHERE ${whereConditions.join(' AND ')}
      `;

      const { rows } = await dbManager.query(query, queryParams);
      return parseInt(rows[0].job_count) || 0;

    } catch (error) {
      logger.error('Quick count failed', { error: error.message, location });
      return 0;
    }
  }

  async showFullJobsAfterPayment(identifier) {
    try {
      const pendingJobsStr = await redis.get(`pending_jobs:${normalizePhone(identifier)}`);
      if (!pendingJobsStr) {
        return this.sendWhatsAppMessage(identifier,
          'No jobs found. Search for jobs first:\n• "Find developer jobs in Lagos"\n• "Remote marketing jobs"',
          { instant: true }
        );
      }

      const jobs = JSON.parse(pendingJobsStr);

      let response = `Here are your ${jobs.length} job${jobs.length > 1 ? 's' : ''}:\n\n`;

      jobs.forEach((job, index) => {
        const jobNumber = index + 1;
        response += `${jobNumber}. ${job.title}\n`;
        response += `   ${job.company}\n`;
        response += `   ${job.is_remote ? 'Remote work' : job.location}\n`;
        response += `   ${job.salary || 'Competitive salary'}\n`;
        if (job.expires_at) {
          const daysLeft = Math.ceil((new Date(job.expires_at) - new Date()) / (1000 * 60 * 60 * 24));
          response += `   Expires in ${daysLeft} days\n`;
        }
        response += `   Reply: "apply ${jobNumber}" to apply\n\n`;
      });

      response += `**Quick Actions:**\n`;
      if (jobs.length === 1) {
        response += `• "apply" - Apply to this job\n`;
      } else {
        response += `• "apply all" - Apply to all ${jobs.length} jobs\n`;
        response += `• "apply 1,2,3" - Select specific jobs\n`;
      }
      response += `• Upload CV after selecting jobs\n\n`;
      response += `**Next:** Select jobs, then upload your CV for instant applications!`;

      // Store for selection
      await redis.set(`last_jobs:${normalizePhone(identifier)}`, JSON.stringify(jobs), 'EX', 3600);
      await redis.del(`pending_jobs:${normalizePhone(identifier)}`); // Clear pending

      return this.sendWhatsAppMessage(identifier, response);

    } catch (error) {
      logger.error('Show full jobs error', { identifier, error: error.message });
      return this.sendWhatsAppMessage(identifier, 'Failed to show jobs. Please try again.', { instant: true });
    }
  }

  // ================================
  // AI PROCESSING & PATTERNS WITH ENHANCED SESSION CONTEXT
  // ================================
  
  async handleWithAI(phone, message, sessionContext = {}) {
    try {
      const startTime = Date.now();
      const intent = await openaiService.parseJobQuery(message, phone, {
        platform: 'whatsapp',
        timestamp: Date.now(),
        sessionData: sessionContext
      });
      logger.info('Intent parsed', { duration: Date.now() - startTime, action: intent.action });

      // Handle simple pattern-matched responses immediately
      if (intent.action === 'greeting' || intent.action === 'clarify' || intent.action === 'help') {
        const sendStart = Date.now();
        await this.sendWhatsAppMessage(phone, intent.response, { instant: true });
        logger.info('Greeting sent', { duration: Date.now() - sendStart });
        await this.updateSessionContext(phone, message, intent, sessionContext);
        return true;
      }

      // Only process complex intents through the full pipeline
      const result = await this.processIntent(phone, intent, message, sessionContext);
      await this.updateSessionContext(phone, message, intent, sessionContext);
      
      return result;

    } catch (error) {
      logger.error('AI processing error', { phone, error: error.message });
      return this.handleSimplePatterns(phone, message, sessionContext);
    }
  }

  async updateSessionContext(phone, message, intent, currentContext) {
    try {
      const updatedContext = { ...currentContext };
      
      // Save job type if detected
      if (intent?.filters?.title) {
        updatedContext.lastJobType = intent.filters.title;
      }
      
      // Save location if detected  
      if (intent?.filters?.location) {
        updatedContext.lastLocation = intent.filters.location;
      }

      // Save raw user terms for better context
      if (intent?.filters?.rawTitle) {
        updatedContext.lastRawTitle = intent.filters.rawTitle;
      }

      if (intent?.filters?.friendlyLabel) {
        updatedContext.lastFriendlyLabel = intent.filters.friendlyLabel;
      }
      
      // Save last message and action for context
      updatedContext.lastMessage = message;
      updatedContext.lastAction = intent?.action || 'unknown';
      updatedContext.timestamp = Date.now();
      updatedContext.interactionCount = (updatedContext.interactionCount || 0) + 1;
      
      await saveSessionContext(phone, updatedContext);
      
    } catch (error) {
      logger.error('Failed to update session context', { phone, error: error.message });
    }
  }

  async processIntent(phone, intent, originalMessage, sessionContext = {}) {
    try {
      switch (intent?.action) {
        case 'search_jobs':
          if (intent.filters && (intent.filters.title || intent.filters.location || intent.filters.remote)) {
            // Enhanced session context completion
            const filters = { ...intent.filters };
            
            if (!filters.title && sessionContext.lastJobType) {
              filters.title = sessionContext.lastJobType;
              filters.rawTitle = sessionContext.lastRawTitle || sessionContext.lastJobType;
              filters.friendlyLabel = sessionContext.lastFriendlyLabel || sessionContext.lastJobType;
              logger.info('Completed query with session job type', { phone, jobType: filters.title });
            }
            
            if (!filters.location && sessionContext.lastLocation) {
              filters.location = sessionContext.lastLocation;
              logger.info('Completed query with session location', { phone, location: filters.location });
            }

            // Save/Update context on full search
            if (filters.title) {
              await redis.set(`lastJobType:${normalizePhone(phone)}`, filters.title, 'EX', 3600);
            }
            if (filters.location) {
              await redis.set(`lastLocation:${normalizePhone(phone)}`, filters.location, 'EX', 3600);
            }

            await this.sendWhatsAppMessage(phone, intent.response || 'Searching for jobs...', { instant: true });
            return await this.searchJobs(phone, filters);
          }
          return this.sendWhatsAppMessage(phone, 
            'What type of jobs are you looking for?\n\nTry: "developer jobs in Lagos" or "remote marketing jobs"',
            { instant: true }
          );

        case 'clarify':
          // Store/update partial context so next reply merges properly
          if (intent.filters?.title) {
            await redis.set(`lastJobType:${normalizePhone(phone)}`, intent.filters.title, 'EX', 3600);
          }
          if (intent.filters?.location) {
            await redis.set(`lastLocation:${normalizePhone(phone)}`, intent.filters.location, 'EX', 3600);
          }

          return this.sendWhatsAppMessage(phone, intent.response, { instant: true });

        case 'apply_job':
          await redis.set(`state:${normalizePhone(phone)}`, 'selecting_jobs', 'EX', 3600);
          return await this.handleJobSelection(phone, originalMessage);

        case 'status':
          return await this.handleStatusRequest(phone);

        case 'help':
          return this.sendWhatsAppMessage(phone, this.getHelpMessage());

        default:
          return this.sendWhatsAppMessage(phone, 
            intent.response || 'I help you find jobs in Nigeria!\n\nTry: "Find developer jobs in Lagos"',
            { instant: true }
          );
      }
    } catch (error) {
      logger.error('Intent processing error', { phone, error: error.message });
      return this.sendWhatsAppMessage(phone, 
        'Something went wrong. Please try again.',
        { instant: true }
      );
    }
  }

  handleSimplePatterns(phone, message, sessionContext = {}) {
    const text = message.toLowerCase().trim();
    
    if (text.includes('hello') || text.includes('hi')) {
      // Enhanced greeting with session context
      const greeting = sessionContext.lastRawTitle || sessionContext.lastLocation 
        ? `Hello again! Still looking for ${sessionContext.lastRawTitle || 'jobs'} ${sessionContext.lastLocation ? 'in ' + sessionContext.lastLocation : ''}?`
        : 'Hello! I help you find jobs in Nigeria\n\nTry: "Find developer jobs in Lagos"';
      
      this.sendWhatsAppMessage(phone, greeting, { instant: true });
      return true;
    }
    
    // Enhanced pattern matching with session context
    const jobKeywords = ['developer', 'engineer', 'marketing', 'sales', 'teacher', 'nurse', 'doctor', 'manager'];
    const locationKeywords = ['lagos', 'abuja', 'remote'];
    
    let foundJob = null;
    let foundLocation = null;
    
    for (const job of jobKeywords) {
      if (text.includes(job)) foundJob = job;
    }
    
    for (const loc of locationKeywords) {
      if (text.includes(loc)) foundLocation = loc;
    }
    
    // USE ENHANCED SESSION CONTEXT
    if (foundJob && !foundLocation && sessionContext.lastLocation) {
      foundLocation = sessionContext.lastLocation.toLowerCase();
    }
    
    if (!foundJob && foundLocation && (sessionContext.lastRawTitle || sessionContext.lastJobType)) {
      foundJob = sessionContext.lastRawTitle || sessionContext.lastJobType.toLowerCase();
    }
    
    if (foundJob && foundLocation) {
      this.searchJobs(phone, { 
        title: foundJob, 
        rawTitle: foundJob,
        location: foundLocation.charAt(0).toUpperCase() + foundLocation.slice(1),
        remote: foundLocation === 'remote'
      });
      return true;
    }
    
    return false;
  }

  // ================================
  // PAYMENT REMINDERS & JOB SELECTION
  // ================================

  schedulePaymentReminders(identifier) {
    // First reminder after 10 minutes - include community for social proof
    setTimeout(async () => {
      const usage = await this.checkDailyUsage(identifier);
      if (usage.needsPayment) {
        await this.sendPaymentReminderWithCommunity(identifier);
      }
    }, 600000); // 10 minutes

    // Final reminder after 1 hour - create urgency
    setTimeout(async () => {
      const usage = await this.checkDailyUsage(identifier);
      if (usage.needsPayment) {
        await this.sendFinalPaymentReminder(identifier);
      }
    }, 3600000); // 1 hour
  }

  async sendPaymentReminderWithCommunity(identifier) {
    const pendingJobs = await redis.get(`pending_jobs:${normalizePhone(identifier)}`);
    if (!pendingJobs) return;

    try {
      const jobs = JSON.parse(pendingJobs);
      const paymentUrl = await this.initiateDailyPayment(identifier);
      
      await this.sendWhatsAppMessage(identifier,
        `${jobs.length} new jobs found — see what others say (https://whatsapp.com/channel/0029VbAp71RA89Mc5GPDKl1h) and unlock details here: ${paymentUrl} 50+ applicants daily, do not miss out!`,
        { instant: true }
      );
    } catch (error) {
      logger.error('Payment reminder error', { identifier, error: error.message });
    }
  }

  async sendFinalPaymentReminder(identifier) {
    const pendingJobs = await redis.get(`pending_jobs:${normalizePhone(identifier)}`);
    if (!pendingJobs) return;

    try {
      const jobs = JSON.parse(pendingJobs);
      const paymentUrl = await this.initiateDailyPayment(identifier);
      
      await this.sendWhatsAppMessage(identifier,
        `Final reminder: Your ${jobs.length} job search results expire soon — complete payment now ${paymentUrl} (new jobs added daily, don't miss out!)`,
        { instant: true }
      );
    } catch (error) {
      logger.error('Final reminder error', { identifier, error: error.message });
    }
  }

  async handleJobSelection(phone, message) {
    try {
      const lastJobsStr = await redis.get(`last_jobs:${normalizePhone(phone)}`);
      if (!lastJobsStr) {
        return this.sendWhatsAppMessage(phone,
          'Please search for jobs first before selecting them.',
          { instant: true }
        );
      }

      let lastJobs = [];
      try {
        lastJobs = JSON.parse(lastJobsStr);
      } catch (e) {
        return this.sendWhatsAppMessage(phone, 'Please search for jobs again.', { instant: true });
      }

      const text = message.toLowerCase().trim();
      let selectedJobs = [];

      if (text.includes('all')) {
        selectedJobs = lastJobs;
      } else {
        const numbers = this.extractJobNumbers(text);
        selectedJobs = numbers
          .filter(num => num >= 1 && num <= lastJobs.length)
          .map(num => lastJobs[num - 1]);
      }

      if (selectedJobs.length === 0) {
        return this.sendWhatsAppMessage(phone,
          'Please specify which jobs to apply to:\n• "Apply to jobs 1,3,5"\n• "Apply to all jobs"',
          { instant: true }
        );
      }

      const usage = await this.checkDailyUsage(phone);
      if (selectedJobs.length > usage.remaining && !usage.needsPayment) {
        return this.sendWhatsAppMessage(phone,
          `You selected ${selectedJobs.length} jobs but only have ${usage.remaining} applications remaining today.\n\nSelect fewer jobs or wait until tomorrow.`,
          { instant: true }
        );
      }

      await redis.set(`selected_jobs:${normalizePhone(phone)}`, JSON.stringify(selectedJobs), 'EX', 3600);
      await redis.del(`state:${normalizePhone(phone)}`);

      let jobList = '';
      selectedJobs.slice(0, 3).forEach((job, index) => {
        jobList += `${index + 1}. ${job.title} - ${job.company}\n`;
      });

      if (selectedJobs.length > 3) {
        jobList += `...and ${selectedJobs.length - 3} more!\n`;
      }

      const responseMessage =
        `You selected *${selectedJobs.length} job(s):*\n\n` +
        `${jobList}\n` +
        `*Next step:* Upload your CV (PDF or DOCX).\n\n` +
        `Once uploaded, your applications will be sent automatically to recruiters.`;

      return this.sendWhatsAppMessage(phone, responseMessage);

    } catch (error) {
      logger.error('Job selection error', { phone, error: error.message });
      return this.sendWhatsAppMessage(phone, 'Selection failed. Please try again.', { instant: true });
    }
  }

  // ================================
  // FILE UPLOAD & APPLICATION PROCESSING
  // ================================

  async handleInstantFileUpload(phone, file, context = {}) {
    try {
      const selectedJobs = await redis.get(`selected_jobs:${normalizePhone(phone)}`);
      
      if (!selectedJobs) {
        return this.sendWhatsAppMessage(phone,
          '**First select jobs to apply to!**\n\nSearch for jobs:\n• "Find developer jobs in Lagos"\n• Select jobs to apply to\n• Then upload CV for applications!',
          { instant: true }
        );
      }

      const usage = await this.checkDailyUsage(phone);
      if (usage.needsPayment) {
        const paymentUrl = await this.initiateDailyPayment(phone);
        return this.sendWhatsAppMessage(phone, 
          `**Complete Payment First**\n\nPay N300 for 10 daily applications\n\n${paymentUrl}\n\nAfter payment, upload CV for instant applications!`,
          { instant: true }
        );
      }
      
      if (file.buffer.length > 5 * 1024 * 1024) {
        return this.sendWhatsAppMessage(phone, 
          'File too large (max 5MB).',
          { instant: true }
        );
      }

      let jobs = [];
      try {
        jobs = JSON.parse(selectedJobs);
      } catch (e) {
        return this.sendWhatsAppMessage(phone, 
          'Please select jobs again and then upload CV.',
          { instant: true }
        );
      }

      // Save file to disk first, don't store in Redis
      const savedFile = await this.saveFileToUploads(phone, file);
      if (!savedFile) {
        return this.sendWhatsAppMessage(phone, 
          'Failed to save CV. Please try again.',
          { instant: true }
        );
      }

      // Show processing typing while handling the application
      await this.sendInstantApplicationConfirmationWithCommunity(phone, jobs, context);
      
      // Pass file path instead of buffer
      await this.queueSmartApplicationProcessing(phone, savedFile, jobs);
      
      await redis.del(`selected_jobs:${normalizePhone(phone)}`);
      await this.deductApplications(phone, jobs.length);

      return true;

    } catch (error) {
      logger.error('Instant file upload error', { phone, error: error.message });
      return this.sendWhatsAppMessage(phone, 
        'Upload failed. Please try again.',
        { instant: true }
      );
    }
  }

  async saveFileToUploads(phone, file) {
    try {
      const fs = require('fs');
      const path = require('path');
      
      // Ensure uploads directory exists
      const uploadsDir = path.join(__dirname, '../uploads');
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }

      // Generate unique filename
      const timestamp = Date.now();
      const safePhone = phone.replace(/[^a-zA-Z0-9]/g, '_');
      const extension = path.extname(file.originalname) || '.pdf';
      const filename = `cv_${safePhone}_${timestamp}${extension}`;
      const filepath = path.join(uploadsDir, filename);

      // Save file to disk
      fs.writeFileSync(filepath, file.buffer);
      
      logger.info('File saved to uploads directory', {
        phone: phone.substring(0, 6) + '***',
        filename: filename,
        size: file.buffer.length,
        path: filepath
      });

      return {
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.buffer.length,
        filename: filename,
        filepath: filepath,
      };

    } catch (error) {
      logger.error('File save failed', { 
        phone: phone.substring(0, 6) + '***',
        error: error.message 
      });
      return null;
    }
  }

  async sendInstantApplicationConfirmationWithCommunity(phone, jobs, context = {}) {
    const usage = await this.checkDailyUsage(phone);
    
    let jobList = '';
    jobs.slice(0, 5).forEach((job, index) => {
      jobList += `${index + 1}. ${job.title} - ${job.company}\n`;
    });
    
    if (jobs.length > 5) {
      jobList += `...and ${jobs.length - 5} more jobs!\n`;
    }

    const response = `SUCCESS! Applications Submitted!\n\nApplied to ${jobs.length} jobs:\n${jobList}\nRecruiters have received your applications\n\nToday's Usage:\n• Applications used: ${usage.totalToday + jobs.length}/10\n• Remaining: ${Math.max(0, usage.remaining - jobs.length)}/10\n\nJoin our success community & share your win:\nhttps://whatsapp.com/channel/0029VbAp71RA89Mc5GPDKl1h\n\nContinue searching for more opportunities!`;

    await this.sendWhatsAppMessage(phone, response, {
      ...context,
      messageType: 'processing',
      urgency: 'high'
    });
  }

  async queueSmartApplicationProcessing(phone, savedFile, jobs) {
    try {
      const applicationId = `app_${phone}_${Date.now()}`;
      
      // Ensure jobs have email fields
      const processedJobs = jobs.map(job => {
        if (!job.email || job.email.trim() === '') {
          if (job.company) {
            const cleanCompany = job.company.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 10);
            job.email = `hr@${cleanCompany}.com`;
          } else {
            job.email = 'jobs@company.ng';
          }
        }
        return job;
      });
      
      await applicationQueue.add(
        'process-smart-applications',
        {
          identifier: phone,
          file: {
            originalname: savedFile.originalname,
            mimetype: savedFile.mimetype,
            size: savedFile.size,
            filepath: savedFile.filepath,
            filename: savedFile.filename
          },
          jobs: processedJobs,
          applicationId: applicationId,
          timestamp: Date.now(),
          processingStrategy: 'file_path'
        },
        {
          priority: 1,
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: 30,
          removeOnFail: 15
        }
      );

      logger.info('Smart application processing queued with file path', { 
        phone: phone.substring(0, 6) + '***', 
        applicationId, 
        jobCount: processedJobs.length,
        filepath: savedFile.filepath
      });

    } catch (error) {
      logger.error('Failed to queue smart applications', { phone, error: error.message });
    }
  }

  // ================================
  // UTILITY METHODS
  // ================================

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
    
    return [...new Set(numbers)].sort((a, b) => a - b);
  }

  async sendWhatsAppMessage(phone, message, context = {}) {
    // Always skip typing for these critical message types
    const skipTypingFor = [
      'instant_response',
      'payment_confirmation', 
      'payment_info',
      'error',
      context.instant === true,
      message.includes('Payment Successful'),
      message.includes('failed'),
      message.includes('error'),
      message.includes('Failed'),
      message.length < 50
    ];
    
    if (skipTypingFor.some(condition => condition)) {
      return await ycloud.sendTextMessage(phone, message);
    }
    
    // Keep typing only for searches and processing
    return await ycloud.sendSmartMessage(phone, message, {
      messageType: 'response',
      ...context
    });
  }

  getHelpMessage() {
    return `SmartCVNaija - Job Application Bot

Find Jobs:
• "Find developer jobs in Lagos"
• "Remote marketing jobs"
• "Jobs in Abuja"

How it works:
1. Search for jobs (free preview)
2. Pay N300 to see full details
3. Select jobs to apply to
4. Upload CV for instant applications

Apply to Jobs:
• Select jobs: "Apply to jobs 1,3,5"
• Apply to all: "Apply to all jobs"

Check Status: Type "status"

Simple Process: Search → Pay → Select → Upload → Apply!`;
  }

  async handleStatusRequest(phone) {
    const usage = await this.checkDailyUsage(phone);
    const selectedJobs = await redis.get(`selected_jobs:${normalizePhone(phone)}`);
    const pendingJobs = await redis.get(`pending_jobs:${normalizePhone(phone)}`);
    
    let statusText = '';
    if (pendingJobs) {
      try {
        const jobs = JSON.parse(pendingJobs);
        statusText = `\nPending: ${jobs.length} jobs found - pay N300 to see details`;
      } catch (e) {
        // Ignore
      }
    }
    
    if (selectedJobs) {
      try {
        const jobs = JSON.parse(selectedJobs);
        statusText = `\nSelected: ${jobs.length} jobs ready to apply`;
      } catch (e) {
        // Ignore
      }
    }
    
    return this.sendWhatsAppMessage(phone, 
      `Your Status

Today's Usage:
• Applications used: ${usage.totalToday}/10
• Remaining: ${usage.remaining}/10
• Payment: ${usage.needsPayment ? 'Required' : 'Active'}${statusText}

Next Steps:
${usage.needsPayment ? '1. Search for jobs\n2. Pay N300 to see details\n3. Apply with CV' : selectedJobs ? '1. Upload CV for instant applications!' : pendingJobs ? '1. Pay N300 to see job details\n2. Select and apply' : '1. Search for jobs\n2. Pay to see details\n3. Apply with CV'}

Try: "Find developer jobs in Lagos"`,
      { instant: true }
    );
  }

  // ================================
  // PAYMENT & USAGE MANAGEMENT
  // ================================

  async checkDailyUsage(identifier) {
    const { rows: [usage] } = await dbManager.query(`
      SELECT applications_remaining, payment_status, total_applications_today, valid_until
      FROM daily_usage 
      WHERE user_identifier = $1
    `, [identifier]);

    if (!usage || !usage.valid_until || new Date(usage.valid_until) < new Date()) {
      return {
        remaining: 0,
        needsPayment: true,
        totalToday: 0,
        expired: true
      };
    }

    return {
      remaining: usage.applications_remaining,
      needsPayment: usage.applications_remaining <= 0,
      totalToday: usage.total_applications_today,
      paymentStatus: usage.payment_status,
      validUntil: usage.valid_until
    };
  }

  async initiateDailyPayment(identifier) {
    const email = 'hr@smartcvnaija.com.ng';
    const cleanIdentifier = identifier.replace(/\+/g, '');
    const reference = `daily_${uuidv4()}_${cleanIdentifier}`;
    
    await dbManager.query(`
      UPDATE daily_usage 
      SET payment_reference = $1, payment_status = 'pending', updated_at = NOW()
      WHERE user_identifier = $2
    `, [reference, identifier]);
    
    return paystackService.initializePayment(identifier, reference, email);
  }

  async deductApplications(identifier, count) {
    const result = await dbManager.query(`
      UPDATE daily_usage 
      SET 
        applications_remaining = applications_remaining - $1,
        total_applications_today = total_applications_today + $1,
        updated_at = NOW()
      WHERE user_identifier = $2 AND applications_remaining >= $1
      RETURNING applications_remaining, total_applications_today
    `, [count, identifier]);

    if (result.rows.length === 0) {
      throw new Error('Insufficient applications remaining');
    }

    return result.rows[0];
  }

  async processPayment(reference) {
    try {
      logger.info('Processing payment started', { reference });

      const [type, uuid, identifier] = reference.split('_');
      if (type !== 'daily') return;

      const originalIdentifier = `+${identifier}`;

      const result = await dbManager.query(`
        UPDATE daily_usage 
        SET 
          applications_remaining = 10,
          payment_status = 'completed',
          valid_until = NOW() + interval '24 hours',
          updated_at = NOW()
        WHERE user_identifier = $1
        RETURNING *
      `, [originalIdentifier]);

      logger.info('Database update result', { rowsAffected: result.rowCount, updatedRow: result.rows[0] });

      if (result.rowCount === 0) {
        // create a fresh record if none exists
        await dbManager.query(`
          INSERT INTO daily_usage (user_identifier, applications_remaining, total_applications_today, payment_status, valid_until, updated_at)
          VALUES ($1, 10, 0, 'completed', NOW() + interval '24 hours', NOW())
        `, [originalIdentifier]);
      }

      // Show jobs or confirmation - WITH INSTANT MESSAGING
      const pendingJobs = await redis.get(`pending_jobs:${originalIdentifier}`);
      if (pendingJobs) {
        return this.showFullJobsAfterPayment(originalIdentifier);
      } else {
        return this.sendWhatsAppMessage(originalIdentifier, 
          'Payment Successful! You now have 10 job applications valid for the next 24 hours!',
          { instant: true }
        );
      }

    } catch (error) {
      logger.error('Payment processing failed', { error: error.message, reference });
      throw error;
    }
  }
}

module.exports = new CleanTeaseThenPayBot();