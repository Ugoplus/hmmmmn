// services/bot.js - Complete Enhanced Bot with Menu System, Pagination, and Interactive Features
// REVERTED TO USE bkopenai.js (openai.js) logic directly

const ycloud = require('./ycloud');
const openaiService = require('./openai'); // This is your bkopenai.js file
const paystackService = require('./paystack');
const { Queue } = require('bullmq');
const { v4: uuidv4 } = require('uuid');
const { getSessionContext, saveSessionContext, clearSessionContext } = require('../utils/sessionContext');
const { redis, queueRedis, sessionRedis } = require('../config/redis');
const dbManager = require('../config/database');
const logger = require('../utils/logger');
const nodemailer = require('nodemailer');

// Versioned cache key component for search results
const SEARCH_CACHE_VERSION = 'v2';
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

    this.stateNames = {
      'abia': 'Abia', 'adamawa': 'Adamawa', 'akwa ibom': 'Akwa Ibom', 'anambra': 'Anambra',
      'bauchi': 'Bauchi', 'bayelsa': 'Bayelsa', 'benue': 'Benue', 'borno': 'Borno',
      'cross river': 'Cross River', 'delta': 'Delta', 'ebonyi': 'Ebonyi', 'edo': 'Edo',
      'ekiti': 'Ekiti', 'enugu': 'Enugu', 'gombe': 'Gombe', 'imo': 'Imo', 'jigawa': 'Jigawa',
      'kaduna': 'Kaduna', 'kano': 'Kano', 'katsina': 'Katsina', 'kebbi': 'Kebbi',
      'kogi': 'Kogi', 'kwara': 'Kwara', 'lagos': 'Lagos', 'niger': 'Niger',
      'ogun': 'Ogun', 'ondo': 'Ondo', 'osun': 'Osun', 'oyo': 'Oyo',
      'plateau': 'Plateau', 'rivers': 'Rivers', 'sokoto': 'Sokoto', 'taraba': 'Taraba',
      'yobe': 'Yobe', 'zamfara': 'Zamfara', 'abuja': 'Abuja', 'remote': 'Remote'
    };
  }

  getNearbyStates(primaryLocation) {
    const normalized = primaryLocation.toLowerCase();
    return this.proximityMap[normalized] || ['remote'];
  }

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
  constructor() {
    // Job categories for menu system
    this.categoryMapping = {
      1: { category: 'it_software', label: 'IT & Software Development' },
      2: { category: 'accounting_finance', label: 'Accounting & Finance' },
      3: { category: 'marketing_sales', label: 'Sales & Marketing' },
      4: { category: 'healthcare_medical', label: 'Healthcare & Medical' },
      5: { category: 'engineering_technical', label: 'Engineering & Technical' },
      6: { category: 'education_training', label: 'Education & Training' },
      7: { category: 'admin_office', label: 'Administration & Office' },
      8: { category: 'management_executive', label: 'Management & Executive' },
      9: { category: 'human_resources', label: 'Human Resources' },
      10: { category: 'customer_service', label: 'Customer Service' },
      11: { category: 'legal_compliance', label: 'Legal & Compliance' },
      12: { category: 'media_creative', label: 'Media & Creative' },
      13: { category: 'logistics_supply', label: 'Logistics & Supply Chain' },
      14: { category: 'security_safety', label: 'Security & Safety' },
      15: { category: 'construction_real_estate', label: 'Construction & Real Estate' },
      16: { category: 'manufacturing_production', label: 'Manufacturing & Production' },
      17: { category: 'transport_driving', label: 'Transport & Driving' },
      18: { category: 'retail_fashion', label: 'Retail & Fashion' },
      19: { category: 'other_general', label: 'General Jobs' }
    };
  }

  // ================================
  // MAIN MESSAGE HANDLER
  // ================================
// 1. First, add this debug logging at the VERY START of handleWhatsAppMessage:

// In bot.js - Add this COMPLETE replacement for handleWhatsAppMessage:
// FIXED: Interactive message handler in handleWhatsAppMessage
async handleWhatsAppMessage(phone, message, file = null, inboundMessageId = null) {
  console.log('🎯 handleWhatsAppMessage CALLED - COMPLETE VERSION');
  console.log('Message type:', typeof message);
  console.log('Message value:', message);
  
  try {
    // 1. FIRST - Handle interactive messages (CRITICAL FIX)
    if (message && typeof message === 'object' && message.type === 'interactive') {
      console.log('🎯🎯🎯 INTERACTIVE MESSAGE DETECTED');
      console.log('Interactive data:', JSON.stringify(message.interactive, null, 2));
      
if (message.interactive && message.interactive.type === 'list_reply' && message.interactive.list_reply) {
        const listReply = message.interactive.list_reply;
        console.log('List reply detected - ID:', listReply.id, 'Title:', listReply.title);
        
        // Handle job application
        if (listReply.id.startsWith('job_')) {
          const jobNumber = parseInt(listReply.id.replace('job_', ''));
          console.log('Applying to job number:', jobNumber);
          
          // Get jobs from Redis
          const lastJobsStr = await redis.get(`last_jobs:${normalizePhone(phone)}`);
          if (!lastJobsStr) {
            return this.sendWhatsAppMessage(phone, 'No jobs found. Please search again.', { instant: true });
          }
          
          const jobs = JSON.parse(lastJobsStr);
          const selectedJob = jobs[jobNumber - 1];
          
          if (!selectedJob) {
            return this.sendWhatsAppMessage(phone, `Job ${jobNumber} not found.`, { instant: true });
          }
          
          // Check payment status FIRST
          const usage = await this.checkDailyUsage(phone);
          if (usage.needsPayment || usage.expired) {
            const paymentUrl = await this.initiateDailyPayment(phone);
            return this.sendWhatsAppMessage(phone,
              `💳 Payment Required\n\nTo apply for "${selectedJob.title}" at ${selectedJob.company}, please complete payment:\n\n${paymentUrl}\n\nAfter payment, upload your CV to apply.`,
              { instant: true }
            );
          }

          if (usage.remaining <= 0) {
            return this.sendWhatsAppMessage(phone,
              `⌛ Application Limit Reached\n\nYou've used all your applications today. Try again tomorrow or make a new payment.`,
              { instant: true }
            );
          }
          
          // Store selected job
          await redis.set(`selected_jobs:${normalizePhone(phone)}`, JSON.stringify([selectedJob]), 'EX', 3600);
          
          // SUCCESS MESSAGE - This is what was missing!
          const successMessage = 
            `✅ Job Selected Successfully!\n\n` +
            `💼 Position: ${selectedJob.title}\n` +
            `🏢 Company: ${selectedJob.company}\n` +
            `📍 Location: ${selectedJob.is_remote ? '🌍 Remote' : selectedJob.location}\n` +
            `💰 Salary: ${selectedJob.salary || 'Competitive'}\n\n` +
            `📤 Next Step: Upload your CV (PDF or DOCX) to apply for this position.\n\n` +
            `You have ${usage.remaining} applications remaining today.`;

          return await ycloud.sendTextMessage(phone, successMessage);
        }

        // Handle navigation
        if (listReply.id.startsWith('nav_')) {
          const action = listReply.id.split('_')[1]; // prev or next
          const targetPage = parseInt(listReply.id.split('_')[2]);
          
          if (action === 'prev' || action === 'next') {
            const allJobsStr = await redis.get(`paginated_jobs:${normalizePhone(phone)}`);
            if (allJobsStr) {
              const allJobs = JSON.parse(allJobsStr);
              return await this.displayJobPageWithInteractive(phone, allJobs, targetPage);
            }
          }
        }
      }
      
      // REMOVED: Don't send generic "Interactive message received"
      // Instead, fall through to text handling or send specific error
    console.log('⚠️ Unknown interactive type - stopping here');
  return Promise.resolve(true);
}
    
    // 2. Handle file uploads
    if (file) {
      return await this.handleInstantFileUpload(phone, file, { inboundMessageId });
    }
    
    // 3. Handle text messages
    if (typeof message === 'string') {
      const text = message.trim();
      console.log('Text message received:', text);
      
      // Convert to lowercase for matching
      const lowerText = text.toLowerCase();
      
      // Show jobs command - KEEP ALL YOUR EXISTING PATTERNS
      const showJobsPatterns = [
        /\b(show\s*(job|jobs|jobz)|my\s*(job|jobs|jobz)|shows\s*(job|jobs|jobz)|see\s*(job|jobs|jobz)|view\s*(job|jobs|jobz)|display\s*(job|jobs|jobz))\b/i,
        /^(job|jobs|jobz)$/i,
        /^(list|listing)$/i,
        /^show$/i,
        /^show\s+jobs?$/i,
        /^(display|view|see|get)\s+(my\s+)?jobs?$/i
      ];
      
      if (showJobsPatterns.some(pattern => pattern.test(text))) {
        console.log('Show jobs command matched');
        return await this.showFullJobsAfterPaymentWithInteractive(phone);
      }

      // Menu command
      if (lowerText.includes('menu') || lowerText.includes('categories')) {
        return await this.showJobCategoriesMenu(phone);
      }

      // Status command
      if (lowerText.includes('status')) {
        return await this.handleStatusRequest(phone, { inboundMessageId });
      }

      // Apply patterns
      if (this.isJobApplicationCommand(text)) {
        await redis.set(`state:${normalizePhone(phone)}`, 'selecting_jobs', 'EX', 3600);
        return await this.handleJobSelection(phone, text, { inboundMessageId });
      }

      // Job details patterns
      if (lowerText.match(/\b(details|detail|detai|requirements|requirement|info|show)\s+\d+\b/) || 
          lowerText.match(/\b\d+\s+(details|detail|detai|requirements|requirement|info|show)\b/) ||
          lowerText.match(/^(show|details|detail|detai|info|requirements|requirement)\s+\d+$/i)) {
        return await this.handleJobDetailsRequest(phone, text);
      }

      // Hello/Hi patterns
      if (this.isGreeting(text)) {
        return this.sendWelcomeMessage(phone);
      }

      // Handle menu selection
      if (this.isMenuSelection(text)) {
        return await this.handleMenuSelection(phone, text, { inboundMessageId });
      }

      // Handle pagination navigation
      if (this.isPaginationCommand(text)) {
        return await this.handlePaginationNavigation(phone, text, { inboundMessageId });
      }

      // Check state for context-specific handling
      const state = await redis.get(`state:${normalizePhone(phone)}`);
      
      if (state === 'selecting_jobs') {
        return await this.handleJobSelection(phone, text, { inboundMessageId });
      }
      
      if (state === 'application_options') {
        return await this.handleApplicationOptionsText(phone, text, { inboundMessageId });
      }
      
      if (state === 'waiting_for_location') {
        return await this.handleLocationInput(phone, text, { inboundMessageId });
      }

      // AI processing for everything else
      const sessionContext = await getSessionContext(phone) || {};
      return await this.handleWithAI(phone, text, sessionContext, { inboundMessageId });
    }
    
    // 4. Fallback for unknown message types
    console.log('Unknown message type, sending welcome');
    return this.sendWelcomeMessage(phone);
    
  } catch (error) {
    console.error('Error in handleWhatsAppMessage:', error);
    return this.sendWhatsAppMessage(phone, 'Something went wrong. Please try again.', { instant: true });
  }
}

// KEEP ALL YOUR EXISTING HELPER METHODS:
isJobApplicationCommand(message) {
  const text = message.toLowerCase().trim();
  return /^apply\s+(\d+([,\s]+\d+)*|all)$/i.test(text) ||
         /^\d+([,\s]+\d+)*$/.test(text) ||
         /^(apply\s+)?all$/i.test(text);
}

isGreeting(message) {
  const greetingPatterns = [
    /^(hi|hello|hey|good morning|good afternoon|good evening|start|begin)$/i,
    /^(hi|hello|hey)\s/i,
    /\b(hello|hi|hey)\b/i
  ];
  return greetingPatterns.some(pattern => pattern.test(message.trim()));
}

isMenuSelection(message) {
  const text = message.trim();
  const number = parseInt(text);
  return !isNaN(number) && number >= 1 && number <= 19;
}

isPaginationCommand(message) {
  const text = message.toLowerCase().trim();
  return ['next', 'prev', 'previous', 'page', 'more'].some(cmd => text.includes(cmd)) ||
         text.match(/^page\s+\d+$/i) ||
         text === '>' || text === '<';
}

  // ================================
  // ENHANCED WELCOME MESSAGE
  // ================================
  async sendWelcomeMessage(phone) {
    let welcomeText = `🙌 You're in! SmartCVNaija makes job hunting easy.\n⚡ Search jobs (e.g. *sales jobs in Lagos* or *menu*)`;
    return this.sendWhatsAppMessage(phone, welcomeText, { instant: true });
  }

  // ================================
  // MENU SYSTEM
  // ================================
  async showJobCategoriesMenu(phone) {
    let menuText = `📋 **Job Categories Menu**\n\nSelect a category by replying with its number:\n\n`;
    
    Object.entries(this.categoryMapping).forEach(([number, { label }]) => {
      menuText += `${number}. ${label}\n`;
    });
    
    menuText += `\n💡 **How to use:**\n`;
    menuText += `• Reply with a number (e.g., "1" for IT jobs)\n`;
    menuText += `• Or use natural language: "developer jobs in Lagos"\n\n`;
    menuText += `Which category interests you? 🎯`;

    return this.sendWhatsAppMessage(phone, menuText, { instant: true });
  }

  isMenuSelection(message) {
    const text = message.trim();
    const number = parseInt(text);
    return !isNaN(number) && number >= 1 && number <= 19;
  }

  async handleMenuSelection(phone, message, context = {}) {
    const categoryNumber = parseInt(message.trim());
    const categoryInfo = this.categoryMapping[categoryNumber];
    
    if (!categoryInfo) {
      return this.sendWhatsAppMessage(phone, 
        'Please select a valid category number (1-19).\nType "menu" to see all categories.',
        { instant: true }
      );
    }

    await redis.set(`selected_category:${normalizePhone(phone)}`, JSON.stringify(categoryInfo), 'EX', 3600);
    await redis.set(`state:${normalizePhone(phone)}`, 'waiting_for_location', 'EX', 3600);

    const locationText = `You selected: **${categoryInfo.label}** ✅\n\n`;
    const locationPrompt = `📍 **Where do you want to work?**\n\n`;
    const examples = `Choose from:\n`;
    const locations = `• Lagos\n• Abuja\n• Port Harcourt\n• Kano\n• Ibadan\n• Remote\n• Any other Nigerian state\n\n`;
    const instruction = `Just reply with your preferred location! 🎯`;

    return this.sendWhatsAppMessage(phone, 
      locationText + locationPrompt + examples + locations + instruction,
      { instant: true }
    );
  }

  async handleLocationInput(phone, message, context = {}) {
    try {
      const categoryStr = await redis.get(`selected_category:${normalizePhone(phone)}`);
      
      if (!categoryStr) {
        await redis.del(`state:${normalizePhone(phone)}`);
        return this.sendWhatsAppMessage(phone, 
          'Session expired. Please select a job category again.\nType "menu" to see categories.',
          { instant: true }
        );
      }

      const categoryInfo = JSON.parse(categoryStr);
      const location = message.trim();

      const sessionContext = await getSessionContext(phone);
      
      const filters = {
        title: categoryInfo.category,
        rawTitle: categoryInfo.label.toLowerCase(),
        friendlyLabel: categoryInfo.label,
        location: location,
        remote: location.toLowerCase() === 'remote'
      };

      logger.info('Location input - using stored category', {
        phone: phone.substring(0, 6) + '***',
        storedCategory: categoryInfo.category,
        storedLabel: categoryInfo.label,
        location: location,
        filters: filters
      });

      await redis.del(`state:${normalizePhone(phone)}`);
      await redis.del(`selected_category:${normalizePhone(phone)}`);

      const displayTitle = this.getCorrectJobDisplayTitle(filters);
      const searchMessage = `Searching for ${displayTitle} in ${location}...`;
      await this.sendWhatsAppMessage(phone, searchMessage, { instant: true });

      return await this.searchJobs(phone, filters, context);

    } catch (error) {
      logger.error('Location input handling error', { phone, error: error.message });
      await redis.del(`state:${normalizePhone(phone)}`);
      await redis.del(`selected_category:${normalizePhone(phone)}`);
      
      return this.sendWhatsAppMessage(phone, 
        'Something went wrong. Please try again.\nType "menu" to browse categories.',
        { instant: true }
      );
    }
  }

  // ================================
  // PAGINATION SYSTEM
  // ================================
  isPaginationCommand(message) {
    const text = message.toLowerCase().trim();
    return ['next', 'prev', 'previous', 'page', 'more'].some(cmd => text.includes(cmd)) ||
           text.match(/^page\s+\d+$/i) ||
           text === '>' || text === '<';
  }

  async handlePaginationNavigation(phone, message, context = {}) {
    try {
      const text = message.toLowerCase().trim();
      const currentPageStr = await redis.get(`current_page:${normalizePhone(phone)}`);
      const totalJobsStr = await redis.get(`paginated_jobs:${normalizePhone(phone)}`);
      
      if (!currentPageStr || !totalJobsStr) {
        return this.sendWhatsAppMessage(phone, 
          'No jobs found for pagination. Please search for jobs first.',
          { instant: true }
        );
      }

      const currentPage = parseInt(currentPageStr);
      const allJobs = JSON.parse(totalJobsStr);
      const totalPages = Math.ceil(allJobs.length / 5); // Updated to match interactive jobsPerPage
      
      let newPage = currentPage;
      
      if (text.includes('next') || text === '>') {
        newPage = Math.min(currentPage + 1, totalPages);
      } else if (text.includes('prev') || text.includes('previous') || text === '<') {
        newPage = Math.max(currentPage - 1, 1);
      } else if (text.match(/^page\s+(\d+)$/i)) {
        const pageMatch = text.match(/^page\s+(\d+)$/i);
        const requestedPage = parseInt(pageMatch[1]);
        if (requestedPage >= 1 && requestedPage <= totalPages) {
          newPage = requestedPage;
        }
      }

      if (newPage === currentPage) {
        return this.sendWhatsAppMessage(phone, 
          `Already on page ${currentPage} of ${totalPages}.\nUse "next" or "prev" to navigate.`,
          { instant: true }
        );
      }

      return await this.displayJobPageWithInteractive(phone, allJobs, newPage, context);

    } catch (error) {
      logger.error('Pagination navigation error', { phone, error: error.message });
      return this.sendWhatsAppMessage(phone, 'Navigation failed. Please try again.', { instant: true });
    }
  }

  // ================================
  // INTERACTIVE JOB DISPLAY WITH BUTTONS
  // ================================
async displayJobPageWithInteractive(phone, allJobs, page = 1, context = {}) {
  try {
    const jobsPerPage = 8; // CHANGED: From 5 to 8
    const startIndex = (page - 1) * jobsPerPage;
    const endIndex = startIndex + jobsPerPage;
    const pageJobs = allJobs.slice(startIndex, endIndex);
    const totalPages = Math.ceil(allJobs.length / jobsPerPage);

    // Store current page and jobs
    await redis.set(`current_page:${normalizePhone(phone)}`, page.toString(), 'EX', 3600);
    await redis.set(`last_jobs:${normalizePhone(phone)}`, JSON.stringify(pageJobs), 'EX', 3600);
    await redis.set(`paginated_jobs:${normalizePhone(phone)}`, JSON.stringify(allJobs), 'EX', 3600);

    // 1. Send detailed job listing first
    let jobDetailsText = `📋 **Jobs - Page ${page} of ${totalPages}** (${allJobs.length} total)\n\n`;
    
    pageJobs.forEach((job, index) => {
      const jobNumber = index + 1; // Use 1-8 for display
      jobDetailsText += this.formatJobDisplay(job, jobNumber);
    });

    // Add text navigation instructions
    if (totalPages > 1) {
      jobDetailsText += `📄 **Navigation:**\n`;
      if (page > 1) {
        jobDetailsText += `⬅️ "prev" for previous page\n`;
      }
      if (page < totalPages) {
        jobDetailsText += `➡️ "next" for next page\n`;
      }
      jobDetailsText += `🔢 "page X" to jump to page X\n\n`;
    }

    jobDetailsText += `💡 **Quick Actions:**\n`;
    jobDetailsText += `• Click buttons below to apply\n`;
    jobDetailsText += `• Type "details 1" for full job info\n`;
    jobDetailsText += `• Type "apply 1,2,3" to select multiple jobs`;

    await this.sendWhatsAppMessage(phone, jobDetailsText, { instant: true });

    // 2. Send interactive buttons - Apply only for all 8 jobs
    try {
      const jobRows = pageJobs.map((job, i) => {
        const jobNumber = i + 1;
        
        // Truncate for WhatsApp limits
        const truncatedTitle = job.title.length > 20 ? job.title.substring(0, 17) + '...' : job.title;
        const truncatedCompany = job.company.length > 25 ? job.company.substring(0, 22) + '...' : job.company;
        
        return {
          id: `job_${jobNumber}`,
          title: `Apply Job ${jobNumber}`,
          description: `${truncatedTitle} - ${truncatedCompany}`
        };
      });

      const sections = [{
        title: "Apply to Jobs",
        rows: jobRows
      }];

      // Add navigation only if there are multiple pages
      if (totalPages > 1) {
        const navRows = [];
        
        if (page > 1) {
          navRows.push({
            id: `nav_prev_${page - 1}`,
            title: '⬅️ Previous',
            description: `Go to page ${page - 1}`
          });
        }
        
        if (page < totalPages) {
          navRows.push({
            id: `nav_next_${page + 1}`,
            title: '➡️ Next',
            description: `Go to page ${page + 1}`
          });
        }

        if (navRows.length > 0) {
          sections.push({
            title: "Navigate",
            rows: navRows
          });
        }
      }

      // Send interactive list
      await ycloud.sendInteractiveListMessage(
        phone,
        "Job Actions",
        "Quick apply to jobs:",
        sections,
        "Choose Action"
      );

      logger.info('Interactive job display completed', {
        phone: phone.substring(0, 6) + '***',
        page,
        jobsShown: pageJobs.length,
        totalJobs: allJobs.length,
        interactiveRowsCreated: jobRows.length
      });

    } catch (interactiveError) {
      logger.warn('Interactive buttons failed, but text display succeeded', {
        phone: phone.substring(0, 6) + '***',
        error: interactiveError.message
      });
    }

    return true;

  } catch (error) {
    logger.error('Enhanced job display failed', { 
      phone: phone.substring(0, 6) + '***', 
      error: error.message 
    });
    
    // Fallback to basic text display
    return await this.displayJobPage(phone, allJobs, page, context);
  }
}
  // ================================
  // LEGACY JOB DISPLAY (FALLBACK)
  // ================================
async displayJobPage(phone, allJobs, page, context = {}) {
  try {
    const jobsPerPage = 8; // CHANGED: From 10 to 8 for consistency
    const startIndex = (page - 1) * jobsPerPage;
    const endIndex = startIndex + jobsPerPage;
    const pageJobs = allJobs.slice(startIndex, endIndex);
    const totalPages = Math.ceil(allJobs.length / jobsPerPage);

    await redis.set(`current_page:${normalizePhone(phone)}`, page.toString(), 'EX', 3600);
    await redis.set(`last_jobs:${normalizePhone(phone)}`, JSON.stringify(pageJobs), 'EX', 3600);

    let response = `📋 **Jobs - Page ${page} of ${totalPages}** (${allJobs.length} total)\n\n`;

    pageJobs.forEach((job, index) => {
      const jobNumber = index + 1;
      response += this.formatJobDisplay(job, jobNumber);
    });

    response += `\n📄 **Navigation:**\n`;
    if (page > 1) response += `• "prev" - Previous page\n`;
    if (page < totalPages) response += `• "next" - Next page\n`;
    response += `• "page X" - Go to page X\n\n`;
    
    response += `🚀 **Quick Actions:**\n`;
    response += `• "${startIndex + 1},${startIndex + 2}" - Apply to specific jobs\n`;
    response += `• "details ${startIndex + 1}" - See full requirements\n`;
    response += `• "all" - Apply to all jobs on this page`;

    await this.sendWhatsAppMessage(phone, response, context);
    return true;

  } catch (error) {
    logger.error('Job page display error', { phone, error: error.message });
    return this.sendWhatsAppMessage(phone, 'Failed to display jobs. Please try again.', { instant: true });
  }
}

  // ================================
  // ENHANCED JOB DISPLAY FORMAT
  // ================================
  formatJobDisplay(job, jobNumber) {
    let jobText = `${jobNumber}. 💼 ${job.title}\n`;
    jobText += `   🏢 ${job.company}\n`;
    jobText += `   📍 ${job.is_remote ? '🌐 Remote' : job.location}\n`;
    
    if (job.salary && job.salary !== 'Competitive') {
      jobText += `   💰 ${job.salary}\n`;
    } else {
      jobText += `   💰 Competitive\n`;
    }
    
    if (job.description || job.requirements) {
      const preview = this.getJobPreview(job);
      if (preview) {
        jobText += `   📝 ${preview}\n`;
      }
    }
    
    if (job.experience) {
      const expPreview = this.formatExperienceLevel(job.experience);
      if (expPreview) {
        jobText += `   🎯 ${expPreview}\n`;
      }
    }
    
    if (job.expires_at) {
      const daysLeft = Math.ceil((new Date(job.expires_at) - new Date()) / (1000 * 60 * 60 * 24));
      if (daysLeft > 0) {
        jobText += `   ⏰ Expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}\n`;
      }
    }
    
    jobText += `   💬 Reply: "apply ${jobNumber}" to apply\n`;
    jobText += `   📋 Reply: "details ${jobNumber}" for full info\n\n`;
    
    return jobText;
  }

  getJobPreview(job) {
    let preview = '';
    const text = (job.requirements || job.description || '').toLowerCase();
    
    const skills = [];
    const techKeywords = [
      'javascript', 'python', 'java', 'react', 'nodejs', 'vue', 'angular',
      'php', 'laravel', 'wordpress', 'html', 'css', 'mysql', 'postgresql',
      'aws', 'azure', 'docker', 'kubernetes', 'git', 'api', 'rest',
      'accounting', 'quickbooks', 'excel', 'finance', 'audit', 'tax',
      'marketing', 'digital marketing', 'seo', 'social media', 'content',
      'sales', 'business development', 'crm', 'lead generation',
      'nursing', 'medical', 'healthcare', 'clinical', 'patient care',
      'teaching', 'education', 'curriculum', 'training', 'learning',
      'customer service', 'support', 'call center', 'help desk',
      'legal', 'law', 'contract', 'compliance', 'regulatory',
      'graphic design', 'adobe', 'photoshop', 'illustrator', 'video editing',
      'hr', 'recruitment', 'payroll', 'employee relations', 'talent',
      'logistics', 'supply chain', 'warehouse', 'inventory', 'procurement',
      'security', 'safety', 'surveillance', 'guard', 'protection',
      'construction', 'civil engineering', 'architecture', 'building',
      'manufacturing', 'production', 'quality control', 'assembly',
      'driving', 'delivery', 'transport', 'logistics', 'courier',
      'retail', 'sales', 'cashier', 'customer service', 'merchandising',
      'management', 'leadership', 'team lead', 'supervisor', 'coordinator'
    ];
    
    for (const keyword of techKeywords) {
      if (text.includes(keyword) && skills.length < 3) {
        skills.push(this.capitalizeFirst(keyword));
      }
    }
    
    if (skills.length > 0) {
      preview = skills.join(', ');
    } else {
      const fallbackText = (job.requirements || job.description || '').trim();
      if (fallbackText) {
        preview = fallbackText.substring(0, 60).replace(/\s+/g, ' ');
        if (fallbackText.length > 60) {
          preview += '...';
        }
      }
    }
    
    return preview;
  }

  formatExperienceLevel(experience) {
    const exp = experience.toLowerCase();
    
    if (exp.includes('entry') || exp.includes('graduate') || exp.includes('0-1') || exp.includes('0 - 1')) {
      return 'Entry Level';
    } else if (exp.includes('senior') || exp.includes('5+') || exp.includes('5 +') || exp.includes('lead')) {
      return 'Senior Level';
    } else if (exp.includes('mid') || exp.includes('2-4') || exp.includes('3-5')) {
      return 'Mid Level';
    } else if (exp.includes('manager') || exp.includes('director') || exp.includes('head')) {
      return 'Management';
    } else if (exp.match(/\d+/)) {
      const years = exp.match(/\d+/)[0];
      return `${years}+ years exp`;
    }
    
    return null;
  }

  capitalizeFirst(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  // ================================
  // GREETING DETECTION
  // ================================
  isGreeting(message) {
    const greetingPatterns = [
      /^(hi|hello|hey|good morning|good afternoon|good evening|start|begin)$/i,
      /^(hi|hello|hey)\s/i,
      /\b(hello|hi|hey)\b/i
    ];
    
    return greetingPatterns.some(pattern => pattern.test(message.trim()));
  }

  // ================================
  // JOB APPLICATION COMMAND DETECTION
  // ================================
  isJobApplicationCommand(message) {
    const text = message.toLowerCase().trim();
    
    if (/^apply\s+(\d+([,\s]+\d+)*|all)$/i.test(text)) {
      return true;
    }
    
    if (/^\d+([,\s]+\d+)*$/.test(text)) {
      return true;
    }
    
    if (/^(apply\s+)?all$/i.test(text)) {
      return true;
    }
    
    return false;
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
      
      const searchTerm = rawTitle || title;
      
      logger.info('Starting job search with bkopenai.js logic', {
        identifier,
        searchTerm,
        category: title,
        rawTitle,
        friendlyLabel,
        location
      });

      const cacheKey = `search:${SEARCH_CACHE_VERSION}:${identifier}:${searchTerm || ''}:${location || ''}:${company || ''}:${typeof remote === 'boolean' ? remote : ''}`;

      const cached = await redis.get(cacheKey);
      if (cached) {
        const cachedData = JSON.parse(cached);
        logger.info('Returning cached search results', { identifier, filters });
        return await this.showCleanJobTeaseWithLocationExpansion(identifier, cachedData.jobs, filters, context);
      }

      if (context.inboundMessageId) {
        await ycloud.showTypingIndicator(context.inboundMessageId);
      }

      let rows = [];

      if (rawTitle) {
        rows = await this.searchByRawTerms(rawTitle, location, company, remote);
        logger.info('Raw term search results', { 
          identifier, 
          searchTerm: rawTitle, 
          resultCount: rows.length 
        });
      }

      if (rows.length === 0 && title) {
        const expandedKeywords = this.getCategoryKeywords(title);
        rows = await this.searchByRawTerms(expandedKeywords, location, company, remote);
        logger.info('Category keyword search results', { 
          identifier, 
          category: title,
          keywords: expandedKeywords,
          resultCount: rows.length 
        });
      }

      if (rows.length === 0 && (rawTitle || title)) {
        const searchTerm = rawTitle || title;
        rows = await this.searchByBroadMatch(searchTerm, location);
        logger.info('Broad match search results', { 
          identifier, 
          searchTerm, 
          resultCount: rows.length 
        });
      }

      if (rows.length === 0 && location && (rawTitle || title)) {
        const searchTerm = rawTitle || title;
        logger.info('No results in specified location, searching nationwide', { 
          searchTerm, 
          originalLocation: location 
        });
        rows = await this.searchByBroadMatch(searchTerm, null);
        
        if (rows.length > 0) {
          await this.sendWhatsAppMessage(identifier, 
            `No ${friendlyLabel || searchTerm} found in ${location}, but I found ${rows.length} nationwide:`,
            { instant: true }
          );
        }
      }

      if (rows.length === 0) {
        const displayTitle = friendlyLabel || rawTitle || title || 'jobs';
        const locationText = location ? ` in ${location}` : '';
        return this.sendWhatsAppMessage(
          identifier,
          `No jobs found for "${displayTitle}"${locationText}\n\nTry broader terms:\n• "software jobs in Lagos"\n• "IT jobs"\n• "remote tech jobs"\n• "jobs in Lagos"\n\nOr type "menu" to browse categories`,
          { instant: true }
        );
      }

      const cacheData = {
        jobs: rows,
        searchParams: { title, rawTitle, location, company, remote },
        timestamp: Date.now()
      };
      
      await redis.set(cacheKey, JSON.stringify(cacheData), 'EX', 1800);
      logger.info('Cached search results', { 
        identifier, 
        filters, 
        resultCount: rows.length
      });

      return await this.showCleanJobTeaseWithLocationExpansion(identifier, rows, filters, context);

    } catch (error) {
      logger.error('Job search error', { identifier, filters, error: error.message });
      return this.sendWhatsAppMessage(identifier, 'Job search failed. Please try again.', { instant: true });
    }
  }

  async searchByRawTerms(searchTerm, location, company, remote) {
    try {
      let whereConditions = [];
      let queryParams = [];
      let paramIndex = 1;
      
      if (searchTerm) {
        const keywordResult = openaiService.extractSearchKeywords ? 
          openaiService.extractSearchKeywords(searchTerm) : 
          this.extractSearchKeywords(searchTerm);

        const keywords = keywordResult.include || (Array.isArray(keywordResult) ? keywordResult : []);
        
        if (keywords.length > 0) {
          const keywordConditions = keywords.map(keyword => {
            const condition = `(
              title ILIKE $${paramIndex} OR 
              description ILIKE $${paramIndex} OR 
              requirements ILIKE $${paramIndex} OR
              category ILIKE $${paramIndex} OR
              experience ILIKE $${paramIndex}
            )`;
            queryParams.push(`%${keyword}%`);
            paramIndex++;
            return condition;
          });
          
          whereConditions.push(`(${keywordConditions.join(' OR ')})`);
        }
      }
      
      if (location && location.toLowerCase() !== 'remote') {
        whereConditions.push(`(location ILIKE $${paramIndex} OR state ILIKE $${paramIndex})`);
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
        : 'WHERE (expires_at IS NULL OR expires_at > NOW())';
      
      let orderByClause = 'ORDER BY COALESCE(last_updated, scraped_at, NOW()) DESC';
      if (searchTerm && queryParams.length > 0) {
        orderByClause = `
          ORDER BY 
            CASE 
              WHEN title ILIKE $1 THEN 1
              WHEN description ILIKE $1 THEN 2
              ELSE 3
            END,
            COALESCE(last_updated, scraped_at, NOW()) DESC`;
      }
      
      const query = `
        SELECT * FROM jobs 
        ${whereClause}
        ${orderByClause}
        LIMIT 20`;

      const { rows } = await dbManager.query(query, queryParams);
      return rows;
      
    } catch (error) {
      logger.error('Raw term search failed', { error: error.message, searchTerm, location });
      return [];
    }
  }

  extractSearchKeywords(searchTerm) {
    if (!searchTerm) return [];
    
    const term = searchTerm.toLowerCase();
    const keywords = [];
    const excludeKeywords = [];
    
    const keywordMap = openaiService.jobKeywords || {};
    
    for (const [keyword, category] of Object.entries(keywordMap)) {
      if (term.includes(keyword)) {
        keywords.push(keyword);
        
        if (category === 'it_software') {
          keywords.push('software developer', 'web developer', 'frontend developer', 'backend developer', 
                       'fullstack developer', 'mobile developer', 'app developer', 'system developer',
                       'programmer', 'software engineer', 'web engineer', 'frontend engineer', 
                       'backend engineer', 'devops engineer', 'mobile engineer');
          
          excludeKeywords.push('business developer', 'business development', 'sales developer',
                             'market developer', 'client developer', 'account developer');
          
        } else if (category === 'accounting_finance') {
          keywords.push('accountant', 'accounting', 'finance', 'financial', 'bookkeeper', 'accounts');
        } else if (category === 'marketing_sales') {
          keywords.push('sales', 'marketing', 'business development', 'account manager', 'representative',
                       'business developer', 'market developer', 'sales developer');
        } else if (category === 'legal_compliance') {
          keywords.push('lawyer', 'legal', 'attorney', 'barrister', 'solicitor', 'paralegal');
        } else if (category === 'media_creative') {
          keywords.push('video', 'editor', 'graphic', 'designer', 'creative', 'content', 'photographer');
        }
        
        break;
      }
    }
    
    if (keywords.length === 0) {
      if (term.includes('developer') || term.includes('develop')) {
        if (term.includes('business') || term.includes('sales') || term.includes('market')) {
          keywords.push('business developer', 'business development', 'sales developer');
        } else if (term.includes('software') || term.includes('web') || term.includes('app') || 
                   term.includes('mobile') || term.includes('frontend') || term.includes('backend')) {
          keywords.push('software developer', 'web developer', 'app developer', 'mobile developer');
          excludeKeywords.push('business developer', 'business development');
        } else {
          keywords.push('developer', 'software developer', 'web developer');
        }
      } else {
        const words = term.split(/\s+/).filter(word => word.length > 2);
        keywords.push(...words);
      }
    }
    
    return {
      include: [...new Set(keywords)],
      exclude: [...new Set(excludeKeywords)]
    };
  }

  getCategoryKeywords(category) {
    const categoryKeywordMap = {
      'it_software': 'developer software programmer engineer web frontend backend fullstack javascript python java php react nodejs',
      'accounting_finance': 'accountant accounting finance financial bookkeeper audit treasury tax analyst',
      'marketing_sales': 'sales marketing business development account manager brand digital advertising',
      'healthcare_medical': 'doctor nurse medical healthcare clinical hospital pharmacy laboratory physician',
      'engineering_technical': 'engineer mechanical electrical civil chemical technical maintenance',
      'education_training': 'teacher lecturer instructor trainer educator tutor professor academic',
      'admin_office': 'admin administrative secretary receptionist office assistant clerical coordinator',
      'customer_service': 'customer service support representative agent call center help desk',
      'transport_driving': 'driver driving delivery transport courier logistics rider',
      'legal_compliance': 'lawyer legal attorney barrister solicitor paralegal compliance',
      'media_creative': 'designer graphic video editor content creator photographer creative media',
      'human_resources': 'hr human resources recruiter recruitment talent people payroll',
      'logistics_supply': 'logistics warehouse supply chain inventory procurement operations',
      'security_safety': 'security guard safety officer surveillance protection hse',
      'construction_real_estate': 'construction builder architect real estate property surveyor',
      'manufacturing_production': 'manufacturing production factory assembly quality control operator',
      'retail_fashion': 'retail sales shop store cashier fashion merchandising',
      'management_executive': 'manager director executive supervisor head lead coordinator',
      'other_general': 'general assistant officer associate coordinator entry level graduate'
    };
    
    return categoryKeywordMap[category] || category;
  }

  async searchByBroadMatch(searchTerm, location = null) {
    try {
      let whereConditions = [];
      let queryParams = [];
      let paramIndex = 1;
      
      whereConditions.push(`(
        title ILIKE $${paramIndex} OR
        description ILIKE $${paramIndex} OR
        requirements ILIKE $${paramIndex} OR
        category ILIKE $${paramIndex} OR
        company ILIKE $${paramIndex}
      )`);
      queryParams.push(`%${searchTerm}%`);
      paramIndex++;
      
      if (location && location.toLowerCase() !== 'remote') {
        whereConditions.push(`(location ILIKE $${paramIndex} OR state ILIKE $${paramIndex})`);
        queryParams.push(`%${location}%`);
        paramIndex++;
      }
      
      whereConditions.push('(expires_at IS NULL OR expires_at > NOW())');
      
      const query = `
        SELECT * FROM jobs
        WHERE ${whereConditions.join(' AND ')}
        ORDER BY COALESCE(last_updated, scraped_at, NOW()) DESC
        LIMIT 20`;
      
      const { rows } = await dbManager.query(query, queryParams);
      return rows;
      
    } catch (error) {
      logger.error('Broad match search failed', { error: error.message });
      return [];
    }
  }

  async showCleanJobTeaseWithLocationExpansion(identifier, jobs, filters, context = {}) {
    try {
      const displayTitle = this.getCorrectJobDisplayTitle(filters);
      const primaryLocation = filters.location;
      
      const locationTease = new LocationTeaseManager();
      
      const actualLocationGroups = {};
      jobs.forEach(job => {
        const loc = job.is_remote ? 'Remote' : job.location;
        if (!actualLocationGroups[loc]) actualLocationGroups[loc] = 0;
        actualLocationGroups[loc]++;
      });

      let expandedResults = actualLocationGroups;
      let totalJobsFound = jobs.length;
      
      const maxLocationsToShow = 5;
      
      if (primaryLocation && primaryLocation.toLowerCase() !== 'remote') {
        const nearbyStates = locationTease.getNearbyStates(primaryLocation);
        
        const expansionPromises = nearbyStates.slice(0, 2).map(async (state) => {
          try {
            const count = await this.quickCountJobsInLocation(filters.title, state);
            return { state, count };
          } catch (error) {
            return { state, count: 0 };
          }
        });

        const expansionResults = await Promise.all(expansionPromises);
        
        expansionResults.forEach(({ state, count }) => {
          if (count > 0 && Object.keys(expandedResults).length < maxLocationsToShow) {
            const formattedState = locationTease.formatStateName(state);
            if (!expandedResults[formattedState]) {
              expandedResults[formattedState] = count;
              totalJobsFound += count;
            }
          }
        });
      }

      let response = `🔥 Found ${totalJobsFound} ${displayTitle}!\n\n`;
      
      response += `📍 Locations:\n`;
      
      const sortedLocations = Object.entries(expandedResults)
        .sort(([locA, countA], [locB, countB]) => {
          if (locA === primaryLocation) return -1;
          if (locB === primaryLocation) return 1;
          return countB - countA;
        })
        .slice(0, maxLocationsToShow);

      sortedLocations.forEach(([location, count]) => {
        response += `• ${location}: ${count} jobs\n`;
      });

      if (Object.keys(expandedResults).length > maxLocationsToShow) {
        response += `• ...and more locations\n`;
      }

      response += `\n💳 Pay ₦300 for full access\n\n`;
      response += `✅ View all job details\n`;
      response += `✅ Apply to 3 jobs with AI-generated cover letters\n`;
      response += `✅ Instant professional applications\n\n`;

      await redis.set(`pending_jobs:${normalizePhone(identifier)}`, JSON.stringify(jobs), 'EX', 3600);
      await redis.set(`search_context:${normalizePhone(identifier)}`, JSON.stringify(filters), 'EX', 3600);

      const paymentUrl = await this.initiateDailyPayment(identifier);
      response += `Pay now: ${paymentUrl}\n\n`;
      response += `Already paid? Type "show jobs"`;

      if (response.length > 4000) {
        response = response.substring(0, 3900) + '\n\nPay to see all details: ' + paymentUrl;
      }

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
  schedulePaymentReminders(identifier) {
    setTimeout(async () => {
      const usage = await this.checkDailyUsage(identifier);
      if (usage.needsPayment) {
        await this.sendPaymentReminderWithCommunity(identifier);
      }
    }, 600000); // 10 minutes

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
      `🔥 ${jobs.length} new jobs found!\n\n💡 See what others say about us:\nhttps://whatsapp.com/channel/0029VbAp71RA89Mc5GPDKl1h\n\n💳 Unlock full details here:\n${paymentUrl}\n\n⚡ 50+ applicants daily - don't miss out!`,
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
      `⏰ Final reminder!\n\nYour ${jobs.length} job search results expire soon\n\n💳 Complete payment now:\n${paymentUrl}\n\n🚀 New jobs added daily - don't miss out!`,
      { instant: true }
    );
  } catch (error) {
    logger.error('Final reminder error', { identifier, error: error.message });
  }
}
  async quickCountJobsInLocation(jobCategory, location) {
    try {
      let whereConditions = ['(expires_at IS NULL OR expires_at > NOW())'];
      let queryParams = [];
      let paramIndex = 1;

      if (jobCategory) {
        whereConditions.push(`(
          title ILIKE $${paramIndex} 
          OR category ILIKE $${paramIndex}
        )`);
        queryParams.push(`%${jobCategory}%`);
        paramIndex++;
      }

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

  // ================================
  // INTERACTIVE JOB APPLICATION SELECTION
  // ================================
  async showJobApplicationOptions(phone, selectedJobs) {
    try {
      const header = "Application Options";
      const body = `You selected ${selectedJobs.length} job(s). Choose how to proceed:`;

      const sections = [{
        title: "Application Actions",
        rows: [
          {
            id: 'apply_selected',
            title: '📤 Apply to Selected Jobs',
            description: `Apply to all ${selectedJobs.length} selected jobs`
          },
          {
            id: 'review_jobs',
            title: '👀 Review Selected Jobs',
            description: 'See details of your selected jobs'
          },
          {
            id: 'select_more',
            title: '➕ Select More Jobs',
            description: 'Add more jobs to your selection'
          },
          {
            id: 'clear_selection',
            title: '🗑️ Clear Selection',
            description: 'Start job selection over'
          }
        ]
      }];

      await ycloud.sendInteractiveListMessage(
        phone,
        header,
        body,
        sections,
        "Choose Action"
      );

      await redis.set(`state:${normalizePhone(phone)}`, 'application_options', 'EX', 3600);
      
      return true;

    } catch (error) {
      logger.error('Application options error', { phone, error: error.message });
      return this.sendWhatsAppMessage(phone, 
        'Upload your CV to apply to the selected jobs, or type "more" to select additional jobs.',
        { instant: true }
      );
    }
  }

  // ================================
  // INTERACTIVE RESPONSE HANDLER
  // ================================
// FIXED: Interactive Response Handler
async handleInteractiveResponse(phone, message, context = {}) {
  console.log('🎯 INTERACTIVE HANDLER STARTED');
  
  try {
    // Extract the interactive data
    const interactive = message.interactive;
    console.log('Interactive data:', JSON.stringify(interactive, null, 2));
    
    if (!interactive) {
      console.log('❌ No interactive data found');
      return this.sendWhatsAppMessage(phone, 'No interactive data received.', { instant: true });
    }
    
    // Handle list reply (what YCloud sends)
    if (interactive.type === 'list_reply' && interactive.list_reply) {
      const listReply = interactive.list_reply;
      console.log('📋 List reply detected:', listReply);
      
      const actionId = listReply.id; // This will be "job_1"
      const actionTitle = listReply.title; // This will be "Apply Job 1"
      
      console.log('Action ID:', actionId, 'Title:', actionTitle);
      
      // Handle job application
      if (actionId.startsWith('job_')) {
        const jobNumber = parseInt(actionId.replace('job_', ''));
        console.log('🎯 Job number to apply:', jobNumber);
        
        if (isNaN(jobNumber)) {
          return this.sendWhatsAppMessage(phone, 'Invalid job selection.', { instant: true });
        }
        
        // Get the jobs from Redis
        const lastJobsStr = await redis.get(`last_jobs:${normalizePhone(phone)}`);
        if (!lastJobsStr) {
          return this.sendWhatsAppMessage(phone, 'No jobs found. Please search again.', { instant: true });
        }
        
        const jobs = JSON.parse(lastJobsStr);
        const selectedJob = jobs[jobNumber - 1];
        
        if (!selectedJob) {
          return this.sendWhatsAppMessage(phone, `Job ${jobNumber} not found.`, { instant: true });
        }
        
        // Store the selected job
        await redis.set(`selected_jobs:${normalizePhone(phone)}`, JSON.stringify([selectedJob]), 'EX', 3600);
        
        // Success message
        const successMsg = `✅ Selected: ${selectedJob.title}\n🏢 ${selectedJob.company}\n\n📤 Please upload your CV (PDF/DOCX) to apply.`;
        
        console.log('✅ Interactive selection successful');
        return this.sendWhatsAppMessage(phone, successMsg, { instant: true });
      }
    }
    
    // If we get here, it's an unknown interactive type
    console.log('❓ Unknown interactive type:', interactive.type);
    return this.sendWhatsAppMessage(phone, 'Unknown action. Please try text commands.', { instant: true });
    
  } catch (error) {
    console.error('💥 Interactive handler error:', error);
    return this.sendWhatsAppMessage(phone, 'Selection failed. Try typing "apply 1" instead.', { instant: true });
  }
}

async handleInteractiveJobSelection(phone, jobNumber, context = {}) {
  try {
    console.log('🎯 handleInteractiveJobSelection called with jobNumber:', jobNumber);
    logger.info('🎯 Starting interactive job selection', { 
      phone: phone.substring(0, 6) + '***', 
      jobNumber 
    });
    
    // Get the current page jobs from Redis
    const lastJobsStr = await redis.get(`last_jobs:${normalizePhone(phone)}`);
    
    if (!lastJobsStr) {
      console.log('🔴 No jobs found in Redis');
      logger.warn('❌ No current page jobs found');
      return this.sendWhatsAppMessage(phone, 'No jobs available. Please search for jobs first.', { instant: true });
    }

    const currentPageJobs = JSON.parse(lastJobsStr);
    console.log('🟢 Found jobs in Redis:', currentPageJobs.length);
    
    // Validate job number
    if (jobNumber < 1 || jobNumber > currentPageJobs.length) {
      console.log('🔴 Invalid job number:', jobNumber, 'Available:', currentPageJobs.length);
      return this.sendWhatsAppMessage(phone, 
        `Invalid job number ${jobNumber}. Please select from jobs 1-${currentPageJobs.length}.`, 
        { instant: true }
      );
    }

    const selectedJob = currentPageJobs[jobNumber - 1];
    console.log('🟢 Selected job:', selectedJob.title);
    
    if (!selectedJob) {
      console.log('🔴 Job not found at index:', jobNumber - 1);
      return this.sendWhatsAppMessage(phone, 
        `Job ${jobNumber} not found. Please try again.`, 
        { instant: true }
      );
    }
    
    logger.info('✅ Found job for selection', { 
      phone: phone.substring(0, 6) + '***',
      jobTitle: selectedJob.title,
      company: selectedJob.company
    });
    
    // Check payment status
    const usage = await this.checkDailyUsage(phone);
    console.log('💰 Payment check:', usage);
    logger.info('📊 Payment status checked', { 
      remaining: usage.remaining, 
      needsPayment: usage.needsPayment 
    });
    
    if (usage.needsPayment) {
      console.log('🔴 Payment required');
      const paymentUrl = await this.initiateDailyPayment(phone);
      return this.sendWhatsAppMessage(phone,
        `💳 Payment Required\n\nTo apply for "${selectedJob.title}" at ${selectedJob.company}, please complete payment:\n\n${paymentUrl}\n\nAfter payment, upload your CV to apply.`,
        { instant: true }
      );
    }

    if (usage.remaining <= 0) {
      console.log('🔴 Application limit reached');
      return this.sendWhatsAppMessage(phone,
        `❌ Application Limit Reached\n\nYou've used all your applications today. Try again tomorrow or make a new payment.`,
        { instant: true }
      );
    }

    // Store the selected job for application
    await redis.set(`selected_jobs:${normalizePhone(phone)}`, JSON.stringify([selectedJob]), 'EX', 3600);
    
    console.log('✅ Job stored in Redis');
    logger.info('✅ Job stored for application', { 
      phone: phone.substring(0, 6) + '***',
      jobTitle: selectedJob.title
    });

    // Success message with clear instructions
    const successMessage = 
      `✅ Job Selected Successfully!\n\n` +
      `💼 Position: ${selectedJob.title}\n` +
      `🏢 Company: ${selectedJob.company}\n` +
      `📍 Location: ${selectedJob.is_remote ? '🌐 Remote' : selectedJob.location}\n` +
      `💰 Salary: ${selectedJob.salary || 'Competitive'}\n\n` +
      `📤 Next Step: Upload your CV (PDF or DOCX) to apply for this position.\n\n` +
      `You have ${usage.remaining} applications remaining today.`;

    console.log('✅ Sending success message');
    return this.sendWhatsAppMessage(phone, successMessage, { instant: true });

  } catch (error) {
    console.error('💥 handleInteractiveJobSelection ERROR:', error);
    logger.error('💥 Interactive job selection error', { 
      phone: phone.substring(0, 6) + '***',
      error: error.message,
      stack: error.stack
    });
    
    return this.sendWhatsAppMessage(phone, 
      'Failed to process job selection. Please try typing "apply 1" instead.', 
      { instant: true }
    );
  }
}

// SIMPLIFIED: Apply Job Interactive
async handleApplyJobInteractive(phone, jobNumber, context = {}) {
  // This is now just an alias for handleInteractiveJobSelection
  return await this.handleInteractiveJobSelection(phone, jobNumber, context);
}
  // ================================
  // INTERACTIVE HANDLERS
  // ================================
async handleInteractiveJobSelection(phone, id, context = {}) {
  try {
    logger.info('🎯 Starting interactive job selection', { 
      phone: phone.substring(0, 6) + '***', 
      id 
    });
    
    const jobNumber = parseInt(id.replace('job_', ''), 10);
    
    if (isNaN(jobNumber)) {
      logger.warn('❌ Invalid job number in interactive selection', { phone, id });
      return this.sendWhatsAppMessage(phone, 'Invalid job number. Please try again.', { instant: true });
    }
    
    // Get the current page jobs (these are already the correct 5 jobs for this page)
    const lastJobsStr = await redis.get(`last_jobs:${normalizePhone(phone)}`);
    
    if (!lastJobsStr) {
      logger.warn('❌ No current page jobs found for selection', { phone });
      return this.sendWhatsAppMessage(phone, 'Please search for jobs first.', { instant: true });
    }

    const currentPageJobs = JSON.parse(lastJobsStr);
    const selectedJob = currentPageJobs[jobNumber - 1]; // jobNumber is 1-based, array is 0-based
    
    if (!selectedJob) {
      logger.warn('❌ Selected job not found on current page', { 
        phone, 
        jobNumber, 
        availableJobs: currentPageJobs.length 
      });
      return this.sendWhatsAppMessage(phone, 
        `Job ${jobNumber} not found. Please select from jobs 1-${currentPageJobs.length}.`, 
        { instant: true }
      );
    }
    
    logger.info('✅ Found job for selection', { 
      phone: phone.substring(0, 6) + '***',
      jobNumber,
      jobTitle: selectedJob.title,
      company: selectedJob.company
    });
    
    const usage = await this.checkDailyUsage(phone);
    logger.info('📊 Checked daily usage', { 
      phone: phone.substring(0, 6) + '***',
      remaining: usage.remaining, 
      needsPayment: usage.needsPayment 
    });
    
    const currentSelectionStr = await redis.get(`selected_jobs:${normalizePhone(phone)}`);
    let selectedJobs = currentSelectionStr ? JSON.parse(currentSelectionStr) : [];
    
    // Check if job is already selected
    const alreadySelected = selectedJobs.some(job => 
      job.id === selectedJob.id || 
      (job.title === selectedJob.title && job.company === selectedJob.company)
    );
    
    if (alreadySelected) {
      logger.info('ℹ️ Job already selected', { 
        phone: phone.substring(0, 6) + '***',
        jobTitle: selectedJob.title 
      });
      return this.sendWhatsAppMessage(phone, 
        `✅ Job "${selectedJob.title}" is already selected.\n\nCurrent selection: ${selectedJobs.length} job(s)`,
        { instant: true }
      );
    }

    if (selectedJobs.length >= usage.remaining && !usage.needsPayment) {
      logger.warn('⚠️ Application limit reached', { 
        phone: phone.substring(0, 6) + '***',
        remaining: usage.remaining 
      });
      return this.sendWhatsAppMessage(phone,
        `Limit reached: You can only apply to ${usage.remaining} more jobs today.`,
        { instant: true }
      );
    }

    // Add job to selection
    selectedJobs.push(selectedJob);
    await redis.set(`selected_jobs:${normalizePhone(phone)}`, JSON.stringify(selectedJobs), 'EX', 3600);
    
    logger.info('✅ Job added to selection successfully', { 
      phone: phone.substring(0, 6) + '***',
      jobTitle: selectedJob.title, 
      totalSelected: selectedJobs.length 
    });

    await this.sendWhatsAppMessage(phone, 
      `✅ Added: ${selectedJob.title}\n🏢 Company: ${selectedJob.company}\n\n📋 Total selected: ${selectedJobs.length} job(s)`,
      { instant: true }
    );

    logger.info('🎛️ Showing job application options', { 
      phone: phone.substring(0, 6) + '***',
      selectedJobs: selectedJobs.length 
    });
    
    return await this.showJobApplicationOptions(phone, selectedJobs);

  } catch (error) {
    logger.error('💥 Interactive job selection error', { 
      phone: phone.substring(0, 6) + '***',
      error: error.message,
      id 
    });
    return this.sendWhatsAppMessage(phone, 'Selection failed. Try typing the job number instead.', { instant: true });
  }
}
async handleInteractiveJobDetails(phone, detailsId, context = {}) {
  try {
    const jobNumber = parseInt(detailsId.replace('details_', ''), 10);
    if (isNaN(jobNumber)) {
      return this.sendWhatsAppMessage(phone, 'Invalid job details request. Please try again.');
    }

    const jobsStr = await redis.get(`paginated_jobs:${normalizePhone(phone)}`);
    if (!jobsStr) {
      return this.sendWhatsAppMessage(phone, 'No jobs found. Please search again.');
    }

    const allJobs = JSON.parse(jobsStr);
    const selectedJob = allJobs[jobNumber - 1];

    if (!selectedJob) {
      return this.sendWhatsAppMessage(phone, 'Job not found. Please try again.');
    }

    // Build job details message
    const detailsMsg = 
      `📋 *Job Details*\n\n` +
      `💼 ${selectedJob.title}\n` +
      `🏢 ${selectedJob.company}\n` +
      `📍 ${selectedJob.location}\n` +
      (selectedJob.salary ? `💰 ${selectedJob.salary}\n` : '') +
      (selectedJob.category ? `📝 ${selectedJob.category}\n` : '') +
      (selectedJob.experience ? `🎯 ${selectedJob.experience}\n` : '') +
      (selectedJob.deadline ? `⏰ Expires: ${selectedJob.deadline}\n` : '') +
      (selectedJob.description ? `\n📝 Description:\n${selectedJob.description}\n` : '');

    return this.sendWhatsAppMessage(phone, detailsMsg);

  } catch (error) {
    logger.error('Interactive job details failed', { 
      phone: phone.substring(0, 6) + '***',
      error: error.message 
    });
    return this.sendWhatsAppMessage(phone, 'Something went wrong fetching job details. Please try again.');
  }
}

async handleInteractivePageNavigation(phone, targetPage, context = {}) {
  try {
    const allJobsStr = await redis.get(`paginated_jobs:${normalizePhone(phone)}`);
    
    if (!allJobsStr) {
      return this.sendWhatsAppMessage(phone, 'No jobs found for navigation.', { instant: true });
    }

    const allJobs = JSON.parse(allJobsStr);
    const totalPages = Math.ceil(allJobs.length / 5);
    
    if (targetPage < 1 || targetPage > totalPages) {
      return this.sendWhatsAppMessage(phone, 
        `Invalid page number. Please select page 1-${totalPages}.`, 
        { instant: true }
      );
    }

    return await this.displayJobPageWithInteractive(phone, allJobs, targetPage, context);

  } catch (error) {
    logger.error('Interactive page navigation error', { phone, error: error.message });
    return this.sendWhatsAppMessage(phone, 'Navigation failed. Please try again.', { instant: true });
  }
}

  async handleApplySelected(phone, context = {}) {
    const selectedJobsStr = await redis.get(`selected_jobs:${normalizePhone(phone)}`);
    if (!selectedJobsStr) {
      return this.sendWhatsAppMessage(phone, 'No jobs selected. Please select jobs first.', { instant: true });
    }

    const selectedJobs = JSON.parse(selectedJobsStr);
    const usage = await this.checkDailyUsage(phone);
    
    if (usage.needsPayment) {
      const paymentUrl = await this.initiateDailyPayment(phone);
      return this.sendWhatsAppMessage(phone, 
        `Complete payment first:\n\n${paymentUrl}\n\nAfter payment, upload your CV to apply to ${selectedJobs.length} selected jobs.`,
        { instant: true }
      );
    }

    await redis.del(`state:${normalizePhone(phone)}`);
    
    let jobList = '';
    selectedJobs.slice(0, 3).forEach((job, index) => {
      jobList += `${index + 1}. ${job.title} - ${job.company}\n`;
    });

    if (selectedJobs.length > 3) {
      jobList += `...and ${selectedJobs.length - 3} more!\n`;
    }

    const response = `Ready to apply to ${selectedJobs.length} job(s):\n\n${jobList}\n📤 Upload your CV to start applications!\n\n✅ We'll generate personalized cover letters\n✅ Submit professional applications instantly\n✅ Email copies to you for records`;

    return this.sendWhatsAppMessage(phone, response);
  }

  async handleReviewJobs(phone, context = {}) {
    const selectedJobsStr = await redis.get(`selected_jobs:${normalizePhone(phone)}`);
    if (!selectedJobsStr) {
      return this.sendWhatsAppMessage(phone, 'No jobs selected.', { instant: true });
    }

    const selectedJobs = JSON.parse(selectedJobsStr);
    let response = `📋 Your Selected Jobs (${selectedJobs.length}):\n\n`;

    selectedJobs.forEach((job, index) => {
      response += `${index + 1}. 💼 ${job.title}\n`;
      response += `   🏢 ${job.company}\n`;
      response += `   📍 ${job.is_remote ? '🌐 Remote' : job.location}\n`;
      if (job.salary && job.salary !== 'Competitive') {
        response += `   💰 ${job.salary}\n`;
      }
      response += '\n';
    });

    response += 'Ready to apply? Upload your CV or select more jobs.';
    
    setTimeout(() => {
      this.showJobApplicationOptions(phone, selectedJobs);
    }, 2000);

    return this.sendWhatsAppMessage(phone, response);
  }

  async handleSelectMore(phone, context = {}) {
    await redis.del(`state:${normalizePhone(phone)}`);
    
    const currentPageStr = await redis.get(`current_page:${normalizePhone(phone)}`);
    const allJobsStr = await redis.get(`paginated_jobs:${normalizePhone(phone)}`);
    
    if (currentPageStr && allJobsStr) {
      const currentPage = parseInt(currentPageStr);
      const allJobs = JSON.parse(allJobsStr);
      return await this.displayJobPageWithInteractive(phone, allJobs, currentPage, context);
    }

    return this.sendWhatsAppMessage(phone, 'Please search for jobs first.', { instant: true });
  }

  async handleClearSelection(phone, context = {}) {
    await redis.del(`selected_jobs:${normalizePhone(phone)}`);
    await redis.del(`state:${normalizePhone(phone)}`);
    
    return this.sendWhatsAppMessage(phone, 
      '🗑️ Job selection cleared.\n\nSearch for jobs to start over:\n• "Find developer jobs in Lagos"\n• Type "menu" to browse categories',
      { instant: true }
    );
  }

  async handleApplicationOptionsText(phone, message, context = {}) {
    try {
      const text = message.toLowerCase().trim();
      const selectedJobsStr = await redis.get(`selected_jobs:${normalizePhone(phone)}`);
      
      if (!selectedJobsStr) {
        await redis.del(`state:${normalizePhone(phone)}`);
        return this.sendWhatsAppMessage(phone, 
          'No jobs selected. Search and select jobs first.',
          { instant: true }
        );
      }

      const selectedJobs = JSON.parse(selectedJobsStr);

      if (text.includes('apply') || text.includes('submit')) {
        return await this.handleApplySelected(phone, context);
      } else if (text.includes('review') || text.includes('see') || text.includes('show')) {
        return await this.handleReviewJobs(phone, context);
      } else if (text.includes('more') || text.includes('add') || text.includes('select')) {
        return await this.handleSelectMore(phone, context);
      } else if (text.includes('clear') || text.includes('reset') || text.includes('start over')) {
        return await this.handleClearSelection(phone, context);
      }

      return this.sendWhatsAppMessage(phone, 
        'Please choose an option:\n• "apply" - Apply to selected jobs\n• "review" - See selected jobs\n• "more" - Select more jobs\n• "clear" - Clear selection',
        { instant: true }
      );

    } catch (error) {
      logger.error('Application options text handler error', { phone, error: error.message });
      return this.sendWhatsAppMessage(phone, 'Failed to process option. Please try again.', { instant: true });
    }
  }

  // ================================
  // ENHANCED SHOW JOBS WITH INTERACTIVE
  // ================================
  async showFullJobsAfterPaymentWithInteractive(phone) {
    try {
      const usage = await this.checkDailyUsage(phone);
      if (usage.needsPayment || usage.expired) {
        const paymentUrl = await this.initiateDailyPayment(phone);
        return this.sendWhatsAppMessage(phone,
          `💳 Payment Required\n\nPay ₦300 for premium service:\n✅ Full job details\n✅ 3 applications with AI cover letters\n\n${paymentUrl}`,
          { instant: true }
        );
      }

      const searchContextStr = await redis.get(`search_context:${normalizePhone(phone)}`);
      if (!searchContextStr) {
        return this.sendWhatsAppMessage(phone,
          '🔍 No jobs found. Search first:\n• "Find developer jobs in Lagos"\n• Type "menu" to browse categories',
          { instant: true }
        );
      }

      const filters = JSON.parse(searchContextStr);
      const searchTerm = filters.rawTitle || filters.title;
      
      let jobs = [];
      
      if (filters.rawTitle) {
        jobs = await this.searchByRawTerms(filters.rawTitle, filters.location, filters.company, filters.remote);
      }
      
      if (jobs.length === 0 && filters.title) {
        const expandedKeywords = this.getCategoryKeywords(filters.title);
        jobs = await this.searchByRawTerms(expandedKeywords, filters.location, filters.company, filters.remote);
      }
      
      if (jobs.length === 0) {
        const searchTerm = filters.rawTitle || filters.title;
        jobs = await this.searchByBroadMatch(searchTerm, filters.location);
      }

      const now = new Date();
      jobs = jobs.filter(job => !job.expires_at || new Date(job.expires_at) > now);

      if (jobs.length === 0) {
        return this.sendWhatsAppMessage(phone,
          'No active jobs available from your search. Try searching again!',
          { instant: true }
        );
      }

      jobs.sort((a, b) => {
        const searchTermLower = (filters.rawTitle || '').toLowerCase();
        const aHasMatch = a.title.toLowerCase().includes(searchTermLower);
        const bHasMatch = b.title.toLowerCase().includes(searchTermLower);
        
        if (aHasMatch && !bHasMatch) return -1;
        if (!aHasMatch && bHasMatch) return 1;
        
        const dateA = new Date(a.last_updated || a.scraped_at || now);
        const dateB = new Date(b.last_updated || b.scraped_at || now);
        return dateB - dateA;
      });

      await redis.set(`paginated_jobs:${normalizePhone(phone)}`, JSON.stringify(jobs), 'EX', 3600);
      await redis.set(`current_page:${normalizePhone(phone)}`, '1', 'EX', 3600);
      await redis.del(`pending_jobs:${normalizePhone(phone)}`);

      return await this.displayJobPageWithInteractive(phone, jobs, 1);

    } catch (error) {
      logger.error('Interactive show full jobs error', { phone, error: error.message });
      return this.sendWhatsAppMessage(phone, 'Failed to show jobs. Please try again.', { instant: true });
    }
  }

  // ================================
  // JOB DETAILS HANDLER
  // ================================
  async handleJobDetailsRequest(phone, message) {
    try {
      const lastJobsStr = await redis.get(`last_jobs:${normalizePhone(phone)}`);
      if (!lastJobsStr) {
        return this.sendWhatsAppMessage(phone,
          'No jobs available. Please search for jobs first.',
          { instant: true }
        );
      }

      const jobs = JSON.parse(lastJobsStr);
      const jobNumber = this.extractSingleJobNumber(message);
      
      if (!jobNumber || jobNumber < 1 || jobNumber > jobs.length) {
        return this.sendWhatsAppMessage(phone,
          `Please specify a valid job number (1-${jobs.length})\nExample: "details 1" or "requirements 2"`,
          { instant: true }
        );
      }

      const job = jobs[jobNumber - 1];
      
      let response = `📋 **Job ${jobNumber} - Full Details**\n\n`;
      response += `💼 **${job.title}**\n`;
      response += `🏢 Company: ${job.company}\n`;
      response += `📍 Location: ${job.is_remote ? '🌐 Remote work' : job.location}\n`;
      response += `💰 Salary: ${job.salary || 'Competitive salary'}\n\n`;
      
      if (job.experience) {
        response += `💼 **Experience Required:**\n${job.experience}\n\n`;
      }
      
      if (job.requirements) {
        response += `✅ **Requirements:**\n${job.requirements}\n\n`;
      }
      
      if (job.description) {
        const shortDesc = job.description.length > 300 
          ? job.description.substring(0, 300) + '...' 
          : job.description;
        response += `📝 **Description:**\n${shortDesc}\n\n`;
      }
      
      if (job.expires_at) {
        const daysLeft = Math.ceil((new Date(job.expires_at) - new Date()) / (1000 * 60 * 60 * 24));
        response += `⏰ **Deadline:** ${daysLeft} days remaining\n\n`;
      }
      
      response += `🚀 **Ready to apply?**\n`;
      response += `Reply: "apply ${jobNumber}" or "${jobNumber}" to apply to this job`;

      return this.sendWhatsAppMessage(phone, response);

    } catch (error) {
      logger.error('Job details error', { phone, error: error.message });
      return this.sendWhatsAppMessage(phone, 'Failed to get job details.', { instant: true });
    }
  }

  extractSingleJobNumber(text) {
    const matches = text.match(/\b(\d+)\b/);
    return matches ? parseInt(matches[1]) : null;
  }

  // ================================
  // AI PROCESSING & PATTERNS
  // ================================
  async handleWithAI(phone, message, sessionContext = {}) {
    try {
      const startTime = Date.now();
      
      const intent = await openaiService.parseJobQuery(message, phone, {
        platform: 'whatsapp',
        timestamp: Date.now(),
        sessionData: sessionContext
      });
      logger.info('Intent parsed using bkopenai.js logic', { 
        duration: Date.now() - startTime, 
        action: intent.action,
        jobType: intent?.filters?.title,
        rawTitle: intent?.filters?.rawTitle,
        friendlyLabel: intent?.filters?.friendlyLabel
      });

      await this.updateSessionContext(phone, message, intent, sessionContext);
      logger.info('Session updated', { 
        phone: phone.substring(0, 6) + '***',
        action: intent.action,
        pendingJobType: intent?.filters?.updateSession?.pendingJobType 
      });

      if (intent.action === 'greeting' || intent.action === 'clarify' || intent.action === 'help') {
        const sendStart = Date.now();
        await this.sendWhatsAppMessage(phone, intent.response, { instant: true });
        logger.info('Response sent', { duration: Date.now() - sendStart, action: intent.action });
        return true;
      }

      const result = await this.processIntent(phone, intent, message, sessionContext);
      
      return result;

    } catch (error) {
      logger.error('AI processing error', { phone, error: error.message });
      return this.handleSimplePatterns(phone, message, sessionContext);
    }
  }

  async updateSessionContext(phone, message, intent, currentContext) {
    try {
      const updatedContext = { ...currentContext };
      
      if (intent?.filters?.updateSession) {
        logger.info('Applying session updates from bkopenai.js', {
          phone: phone.substring(0, 6) + '***',
          updates: intent.filters.updateSession,
          before: {
            pendingJobType: currentContext.pendingJobType,
            lastJobType: currentContext.lastJobType
          }
        });
        
        Object.assign(updatedContext, intent.filters.updateSession);
        
        logger.info('Session updates applied from bkopenai.js', {
          phone: phone.substring(0, 6) + '***',
          after: {
            pendingJobType: updatedContext.pendingJobType,
            lastJobType: updatedContext.lastJobType
          }
        });
      }
      
      const currentState = await redis.get(`state:${normalizePhone(phone)}`);
      
      if (currentState === 'waiting_for_location') {
        logger.info('Preserving job context while waiting for location', {
          phone: phone.substring(0, 6) + '***',
          currentState: currentState,
          preservedJobType: updatedContext.pendingJobType || updatedContext.lastJobType
        });
      } else {
        if (intent?.filters?.title) {
          updatedContext.lastJobType = intent.filters.title;
        }
        
        if (intent?.filters?.location) {
          updatedContext.lastLocation = intent.filters.location;
        }

        if (intent?.filters?.rawTitle) {
          updatedContext.lastRawTitle = intent.filters.rawTitle;
        }

        if (intent?.filters?.friendlyLabel) {
          updatedContext.lastFriendlyLabel = intent.filters.friendlyLabel;
        }
      }
      
      updatedContext.lastMessage = message;
      updatedContext.lastAction = intent?.action || 'unknown';
      updatedContext.timestamp = Date.now();
      updatedContext.interactionCount = (updatedContext.interactionCount || 0) + 1;
      updatedContext.lastInteraction = Date.now();
      
      const saveSuccess = await saveSessionContext(phone, updatedContext);
      
      if (!saveSuccess) {
        logger.error('Session save failed!', {
          phone: phone.substring(0, 6) + '***',
          action: intent?.action,
          pendingJobType: updatedContext.pendingJobType
        });
      }
      
      return saveSuccess;
      
    } catch (error) {
      logger.error('Failed to update session context', { 
        phone: phone.substring(0, 6) + '***',
        error: error.message 
      });
      return false;
    }
  }

  async processIntent(phone, intent, originalMessage, sessionContext = {}) {
    try {
      switch (intent?.action) {
        case 'search_jobs':
          if (intent.filters && (intent.filters.title || intent.filters.location || intent.filters.remote)) {
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

            if (filters.title) {
              await redis.set(`lastJobType:${normalizePhone(phone)}`, filters.title, 'EX', 3600);
            }
            if (filters.location) {
              await redis.set(`lastLocation:${normalizePhone(phone)}`, filters.location, 'EX', 3600);
            }

            const displayTitle = this.getCorrectJobDisplayTitle(filters);
            const responseMessage = intent.response || `Searching for ${displayTitle}...`;
            
            await this.sendWhatsAppMessage(phone, responseMessage, { instant: true });
            return await this.searchJobs(phone, filters);
          }
          return this.sendWhatsAppMessage(phone, 
            'What type of jobs are you looking for?\n\nTry: "developer jobs in Lagos" or "remote marketing jobs"\n\nOr type "menu" to browse categories',
            { instant: true }
          );

        case 'clarify':
          if (intent.filters?.title) {
            await redis.set(`lastJobType:${normalizePhone(phone)}`, intent.filters.title, 'EX', 3600);
            logger.info('Clarify: Stored job type to Redis', {
              phone: phone.substring(0, 6) + '***',
              jobType: intent.filters.title,
              rawTitle: intent.filters.rawTitle
            });
          }
          if (intent.filters?.location) {
            await redis.set(`lastLocation:${normalizePhone(phone)}`, intent.filters.location, 'EX', 3600);
            logger.info('Clarify: Stored location to Redis', {
              phone: phone.substring(0, 6) + '***',
              location: intent.filters.location
            });
          }

          logger.info('Clarify handler enter using bkopenai.js logic', {
            phone: phone.substring(0, 6) + '***',
            originalMessage: originalMessage,
            intentFilters: intent.filters || null,
            sessionLastJobType: sessionContext?.lastJobType || null,
            sessionLastLocation: sessionContext?.lastLocation || null,
            sessionPendingJobType: sessionContext?.pendingJobType || null,
            sessionPendingLocation: sessionContext?.pendingLocation || null
          });

          if (intent.filters?.title && !intent.filters?.location) {
            logger.info('Clarify Step 1: Job detected, no location - saving to pending', {
              phone: phone.substring(0, 6) + '***',
              detectedJob: intent.filters.title,
              detectedRawTitle: intent.filters.rawTitle,
              detectedFriendlyLabel: intent.filters.friendlyLabel
            });
            
            sessionContext.pendingJobType = intent.filters.title;
            sessionContext.pendingRawTitle = intent.filters.rawTitle;
            sessionContext.pendingFriendlyLabel = intent.filters.friendlyLabel;
            
            return this.sendWhatsAppMessage(phone, 
              `What location for ${intent.filters.friendlyLabel || intent.filters.title}? Try: Lagos, Abuja, or Remote`,
              { instant: true }
            );
          }

          if (intent.filters?.location && !intent.filters?.title) {
            logger.info('Clarify Step 2: Location detected, no job - saving to pending', {
              phone: phone.substring(0, 6) + '***',
              detectedLocation: intent.filters.location
            });
            
            sessionContext.pendingLocation = intent.filters.location;
            
            return this.sendWhatsAppMessage(
              phone,
              `What kind of job are you looking for in ${intent.filters.location}?\n\nOr type "menu" to browse categories`,
              { instant: true }
            );
          }

          const hasPendingJob = !!sessionContext.pendingJobType;
          const hasPendingLocation = !!sessionContext.pendingLocation;
          
          logger.info('Clarify Step 3: Checking for pending combinations', {
            phone: phone.substring(0, 6) + '***',
            hasPendingJob: hasPendingJob,
            hasPendingLocation: hasPendingLocation,
            pendingJobType: sessionContext.pendingJobType,
            pendingLocation: sessionContext.pendingLocation
          });

          if (hasPendingJob && hasPendingLocation) {
            const filters = {
              title: sessionContext.pendingJobType,
              rawTitle: sessionContext.pendingRawTitle || sessionContext.pendingJobType,
              friendlyLabel: sessionContext.pendingFriendlyLabel || sessionContext.pendingJobType,
              location: sessionContext.pendingLocation
            };
            
            logger.info('Clarify Step 4: Combining pending job and location for search', {
              phone: phone.substring(0, 6) + '***',
              jobType: filters.title,
              location: filters.location
            });
            
            await clearSessionContext(phone);
            await this.sendWhatsAppMessage(phone, 
              `Searching for ${filters.friendlyLabel || filters.title} in ${filters.location}...`,
              { instant: true }
            );
            return await this.searchJobs(phone, filters);
          }

          return this.sendWhatsAppMessage(phone, 
            intent.response || 'Please provide more details about the job or location.',
            { instant: true }
          );

        case 'show_jobs':
          return await this.showFullJobsAfterPaymentWithInteractive(phone);

        case 'status':
          return await this.handleStatusRequest(phone);

        case 'show_menu':
          return await this.showJobCategoriesMenu(phone);

        default:
          logger.info('Falling back to simple patterns for unhandled intent', { 
            phone: phone.substring(0, 6) + '***', 
            action: intent.action 
          });
          const simpleResponse = this.handleSimplePatterns(phone, originalMessage, sessionContext);
          if (simpleResponse) {
            return simpleResponse;
          }
          
          const response = intent.response || 
            'I’m here to help! Try:\n• "Find developer jobs in Lagos"\n• "menu" to browse categories\n• "status" to check your applications';
          return this.sendWhatsAppMessage(phone, response, { instant: true });
      }
    } catch (error) {
      logger.error('Intent processing error', { phone, error: error.message });
      return this.sendWhatsAppMessage(phone, 'Something went wrong. Please try again.', { instant: true });
    }
  }

  handleSimplePatterns(phone, message, sessionContext) {
    const text = message.toLowerCase().trim();
    
    if (text.includes('thanks') || text.includes('thank you')) {
      return this.sendWhatsAppMessage(phone, 'You’re welcome! 😊 Need more help?', { instant: true });
    }
    
    if (text.includes('cancel') || text.includes('stop')) {
      clearSessionContext(phone);
      redis.del(`state:${normalizePhone(phone)}`);
      redis.del(`selected_category:${normalizePhone(phone)}`);
      redis.del(`selected_jobs:${normalizePhone(phone)}`);
      return this.sendWhatsAppMessage(phone, 'Session cleared. Start over with "menu" or a job search.', { instant: true });
    }
    
    return null;
  }

  // ================================
  // PAYMENT HANDLING
  // ================================
async initiateDailyPayment(identifier) {
  const email = 'hr@smartcvnaija.com.ng';
  const cleanIdentifier = identifier.replace(/\+/g, '');
  const reference = `daily_${uuidv4()}_${cleanIdentifier}`;
  
  await dbManager.query(`
    INSERT INTO daily_usage (user_identifier, payment_reference, payment_status, updated_at)
    VALUES ($2, $1, 'pending', NOW())
    ON CONFLICT (user_identifier) 
    DO UPDATE SET 
      payment_reference = $1, 
      payment_status = 'pending', 
      updated_at = NOW()
  `, [reference, identifier]);
  
  return paystackService.initializePayment(identifier, reference, email);
}

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

  async processPayment(reference) {
    try {
      logger.info('Processing payment started', { reference });

      const [type, uuid, identifier] = reference.split('_');
      if (type !== 'daily') return;

      const originalIdentifier = `+${identifier}`;

     const result = await dbManager.query(`
  UPDATE daily_usage 
  SET 
    applications_remaining = 3,
    payment_status = 'completed',
    valid_until = NOW() + interval '24 hours',
    updated_at = NOW()
  WHERE user_identifier = $1
  RETURNING *
`, [originalIdentifier]);

      logger.info('Database update result', { rowsAffected: result.rowCount, updatedRow: result.rows[0] });

      if (result.rowCount === 0) {
        await dbManager.query(`
  INSERT INTO daily_usage (user_identifier, applications_remaining, total_applications_today, payment_status, valid_until, updated_at)
  VALUES ($1, 3, 0, 'completed', NOW() + interval '24 hours', NOW())
`, [originalIdentifier]);
      }

      const pendingJobs = await redis.get(`pending_jobs:${originalIdentifier}`);
      if (pendingJobs) {
        return this.showFullJobsAfterPaymentWithInteractive(originalIdentifier);
      } else {
        return this.sendWhatsAppMessage(originalIdentifier, 
  'Payment Successful! You now have 3 job applications valid for the next 24 hours!',
  { instant: true }
);
      }

    } catch (error) {
      logger.error('Payment processing failed', { error: error.message, reference });
      throw error;
    }
  }



  // ================================
  // FILE UPLOAD HANDLING
  // ================================
  async handleInstantFileUpload(phone, file, context = {}) {
    try {
      const uploadId = uuidv4();
      const normalizedPhone = normalizePhone(phone);
      
      const usage = await this.checkDailyUsage(phone);
      if (usage.needsPayment || usage.expired) {
        const paymentUrl = await this.initiateDailyPayment(phone);
        return this.sendWhatsAppMessage(phone,
          `💳 Payment required to upload CV\n\nPay ₦300 for premium service:\n${paymentUrl}`,
          { instant: true }
        );
      }
      
      if (usage.remaining === 0) {
        return this.sendWhatsAppMessage(phone,
          'You’ve reached your daily application limit. Try again tomorrow or upgrade your plan.',
          { instant: true }
        );
      }

      const selectedJobsStr = await redis.get(`selected_jobs:${normalizedPhone}`);
      let selectedJobs = selectedJobsStr ? JSON.parse(selectedJobsStr) : [];
      
      if (selectedJobs.length === 0) {
        const lastJobsStr = await redis.get(`last_jobs:${normalizedPhone}`);
        if (lastJobsStr) {
          selectedJobs = JSON.parse(lastJobsStr).slice(0, usage.remaining);
          await redis.set(`selected_jobs:${normalizedPhone}`, JSON.stringify(selectedJobs), 'EX', 3600);
        }
      }
      
      if (selectedJobs.length === 0) {
        return this.sendWhatsAppMessage(phone,
          'No jobs selected. Please select jobs first:\n• "show jobs"\n• "menu" to browse categories',
          { instant: true }
        );
      }

      const jobIds = selectedJobs.map(job => job.id).join(',');
      await this.sendWhatsAppMessage(phone, 
        `📄 Processing your CV for ${selectedJobs.length} job(s)...`,
        { instant: true }
      );

      const job = await cvQueue.add('process-cv', {
        phone: normalizedPhone,
        file,
        jobIds,
        uploadId,
        timestamp: Date.now()
      });

      await cvBackgroundQueue.add('extract-cv-data', {
        uploadId,
        phone: normalizedPhone,
        file,
        jobIds
      });

      return true;

    } catch (error) {
      logger.error('File upload error', { phone, error: error.message });
      return this.sendWhatsAppMessage(phone, 
        'Failed to process your CV. Please try again.',
        { instant: true }
      );
    }
  }

  // ================================
  // JOB APPLICATION HANDLING
  // ================================
  async handleJobSelection(phone, message, context = {}) {
    try {
      const normalizedPhone = normalizePhone(phone);
      const lastJobsStr = await redis.get(`last_jobs:${normalizedPhone}`);
      
      if (!lastJobsStr) {
        await redis.del(`state:${normalizedPhone}`);
        return this.sendWhatsAppMessage(phone, 
          'No jobs available. Please search for jobs first.',
          { instant: true }
        );
      }

      const jobs = JSON.parse(lastJobsStr);
      const usage = await this.checkDailyUsage(phone);
      
      if (usage.needsPayment || usage.expired) {
        const paymentUrl = await this.initiateDailyPayment(phone);
        return this.sendWhatsAppMessage(phone,
          `💳 Payment Required\n\nPay ₦300 to apply:\n${paymentUrl}`,
          { instant: true }
        );
      }

      const text = message.toLowerCase().trim();
      let selectedJobs = [];
      
      if (text === 'all') {
        selectedJobs = jobs.slice(0, usage.remaining);
      } else {
        const jobNumbers = text.split(/[\s,]+/).map(num => parseInt(num)).filter(num => !isNaN(num));
        selectedJobs = jobNumbers
          .filter(num => num > 0 && num <= jobs.length)
          .map(num => jobs[num - 1])
          .slice(0, usage.remaining);
      }

      if (selectedJobs.length === 0) {
        return this.sendWhatsAppMessage(phone,
          `Please select valid job numbers (1-${jobs.length}) or "all".`,
          { instant: true }
        );
      }

      await redis.set(`selected_jobs:${normalizedPhone}`, JSON.stringify(selectedJobs), 'EX', 3600);
      await redis.del(`state:${normalizedPhone}`);

      return await this.showJobApplicationOptions(phone, selectedJobs);

    } catch (error) {
      logger.error('Job selection error', { phone, error: error.message });
      await redis.del(`state:${normalizePhone(phone)}`);
      return this.sendWhatsAppMessage(phone, 
        'Failed to process job selection. Please try again.',
        { instant: true }
      );
    }
  }

  // ================================
  // STATUS HANDLING
  // ================================
  async handleStatusRequest(phone, context = {}) {
    try {
      const normalizedPhone = normalizePhone(phone);
      const usage = await this.checkDailyUsage(phone);
      
      let response = `📊 **Your Status**\n\n`;
      
      if (usage.needsPayment || usage.expired) {
        const paymentUrl = await this.initiateDailyPayment(phone);
        response += `💳 **Payment Required**\nPay ₦300 for premium access:\n${paymentUrl}\n\n`;
      } else {
        response += `✅ **Premium Access Active**\n`;
        response += `Applications today: ${usage.applications}/3\n`;
        response += `Remaining: ${usage.remaining} applications\n\n`;
      }

      const selectedJobsStr = await redis.get(`selected_jobs:${normalizedPhone}`);
      if (selectedJobsStr) {
        const selectedJobs = JSON.parse(selectedJobsStr);
        response += `📋 **Selected Jobs**: ${selectedJobs.length}\n`;
        selectedJobs.forEach((job, index) => {
          response += `${index + 1}. ${job.title} - ${job.company}\n`;
        });
        response += `\nUpload your CV to apply!\n`;
      } else {
        response += `📋 **No jobs selected**\nSearch for jobs to start applying.\n`;
      }

      const applications = await dbManager.query(
        'SELECT * FROM applications WHERE phone = $1 ORDER BY applied_at DESC LIMIT 5',
        [normalizedPhone]
      );

      if (applications.rows.length > 0) {
        response += `\n📤 **Recent Applications**:\n`;
        applications.rows.forEach((app, index) => {
          response += `${index + 1}. ${app.job_title} - ${app.company} (${app.status})\n`;
        });
      } else {
        response += `\n📤 **No recent applications**\n`;
      }

      response += `\n🚀 **Next Steps**:\n`;
      response += `• "show jobs" - View your job search\n`;
      response += `• "menu" - Browse job categories\n`;
      response += `• Upload CV to apply to selected jobs`;

      return this.sendWhatsAppMessage(phone, response, context);

    } catch (error) {
      logger.error('Status request error', { phone, error: error.message });
      return this.sendWhatsAppMessage(phone, 'Failed to check status. Please try again.', { instant: true });
    }
  }

  // ================================
  // UTILITY METHODS
  // ================================
  getCorrectJobDisplayTitle(filters) {
    if (filters.friendlyLabel) {
      return filters.friendlyLabel;
    }
    if (filters.rawTitle) {
      return filters.rawTitle.replace(/\s+/g, ' ').trim();
    }
    if (filters.title) {
      const matchedCategory = Object.values(this.categoryMapping).find(
        cat => cat.category === filters.title
      );
      return matchedCategory ? matchedCategory.label : filters.title;
    }
    return 'jobs';
  }

async sendWhatsAppMessage(phone, message, context = {}) {
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
  
  return await ycloud.sendSmartMessage(phone, message, {
    messageType: 'response',
    ...context
  });
}
}
// Instantiate and export the bot
const botInstance = new CleanTeaseThenPayBot();
module.exports = botInstance;
