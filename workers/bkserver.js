// server.js - PRODUCTION READY FOR 1000+ USERS
console.log('=== SERVER STARTING ===', new Date());
console.log('NODE_ENV:', process.env.NODE_ENV);
require('events').EventEmitter.defaultMaxListeners = 30; // Increased from 20
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const fs = require('fs');
const axios = require('axios');
const config = require('./config');
const logger = require('./utils/logger');
const { statsd, trackMetric } = require('./utils/metrics');
const bot = require('./services/bot');
const ycloud = require('./services/ycloud');
const openaiWorker = require('./workers/openai');
const cvWorker = require('./workers/cv');
const cvBackgroundWorker = require('./workers/cv-background'); // ✅ NEW
const applicationWorker = require('./workers/application');
const { redis, redisWrapper } = require('./config/redis');
const dbManager = require('./config/database');
const cvCleanup = require('./services/cv-cleanup');
const jobCleanup = require('./services/job-cleanup');
const RateLimiter = require('./utils/rateLimiter');
const rateLimit = require('express-rate-limit');
const app = express();
const helmet = require('helmet');
const validator = require('validator');
const xss = require('xss');
const { body, validationResult } = require('express-validator');
const nodemailer = require('nodemailer');
// ✅ ENHANCED STARTUP SEQUENCE
(async () => {
  try {
    logger.info('🚀 Starting SmartCVNaija server...');
    
    // Initialize database first
    await dbManager.connect();
    
    // Schedule cleanup services
    cvCleanup.scheduleCleanup();
    
    // Create uploads directory
    if (!fs.existsSync('./uploads')) {
      fs.mkdirSync('./uploads', { recursive: true });
      logger.info('Created uploads directory');
    }
    
    logger.info('✅ All services initialized successfully');
    
  } catch (error) {
    logger.error('❌ Failed to initialize services', { error: error.message });
    process.exit(1);
  }
})();
const alertEmailTransporter = nodemailer.createTransport({
    host: 'smtp.zeptomail.com',
    port: 587,
    secure: false,
    auth: {
        user: process.env.ALERT_SMTP_USER,
        pass: process.env.ALERT_SMTP_PASS
    }
})

// ================================
// ENHANCED MIDDLEWARE STACK
// ================================

// Request ID and logging
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || uuidv4();
  res.setHeader('X-Request-Id', req.id);
  req.logger = logger.child({ requestId: req.id });
  req.startTime = Date.now();
  next();
});

// ✅ GLOBAL RATE LIMITING FOR PRODUCTION
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: {
    error: 'Too many requests from this IP',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const ip = req.ip || req.connection.remoteAddress || req.socket.remoteAddress || 'unknown';
    return ip.replace(/^::ffff:/, '');
  },
});
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", "data:", "https:"],
            fontSrc: ["'self'", "https://cdnjs.cloudflare.com"],
        },
    },
}));

app.use(globalLimiter);

// ✅ CORS CONFIGURATION
app.use(cors({ 
  origin: [
    config.get('baseUrl'),
    'http://localhost:3000',
    'https://smartcvnaija.com.ng',
    'https://www.smartcvnaija.com.ng',
    'https://api.smartcvnaija.com.ng',  // Add this line
  ], 
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true,
  maxAge: 86400,
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization']
}));
// ✅ WEBHOOK SPECIFIC RATE LIMITING
const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,  // 1 minute
  max: 5000,                // Very high limit for webhooks
  message: {
    error: 'Webhook rate limit exceeded',
    retryAfter: '1 minute'
  },
 keyGenerator: (req) => {
  const ip = req.ip || req.connection.remoteAddress || req.socket.remoteAddress || 'unknown';
  return ip.replace(/^::ffff:/, '');
  },
});

const jobPostingLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 5, // Limit each IP to 5 job postings per hour
    message: {
        error: 'Too many job postings from this IP. Please try again later.',
        retryAfter: '1 hour'
    },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        return req.ip || req.connection.remoteAddress || 'unknown';
    },
    // Skip rate limiting for trusted IPs (optional)
    skip: (req) => {
        const trustedIPs = process.env.TRUSTED_IPS ? process.env.TRUSTED_IPS.split(',') : [];
        return trustedIPs.includes(req.ip);
    }
});
const validateJobInput = [
    // Sanitize and validate company name
    body('companyName')
        .trim()
        .isLength({ min: 2, max: 100 })
        .withMessage('Company name must be between 2-100 characters')
        .matches(/^[a-zA-Z0-9\s\-&.,()]+$/)
        .withMessage('Company name contains invalid characters')
        .customSanitizer(value => xss(value)),
    
    // Sanitize and validate job title
    body('jobTitle')
        .trim()
        .isLength({ min: 3, max: 150 })
        .withMessage('Job title must be between 3-150 characters')
        .matches(/^[a-zA-Z0-9\s\-&.,()\/]+$/)
        .withMessage('Job title contains invalid characters')
        .customSanitizer(value => xss(value)),
    
    // Validate location
    body('location')
        .trim()
        .isIn(['Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno', 'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara', 'Abuja', 'Remote'])
        .withMessage('Invalid location selected'),
    
    // Validate experience level
    body('experience')
        .isIn(['entry', 'mid', 'senior', 'executive'])
        .withMessage('Invalid experience level'),
    
    // Validate job category
    body('jobCategory')
        .isIn(['accounting_finance', 'admin_office', 'it_software', 'engineering_technical', 'marketing_sales', 'healthcare_medical', 'education_training', 'management_executive', 'human_resources', 'logistics_supply', 'customer_service', 'legal_compliance', 'media_creative', 'security_safety', 'construction_real_estate', 'manufacturing_production', 'retail_fashion', 'transport_driving', 'other_general'])
        .withMessage('Invalid job category'),
    
    // Validate and sanitize job description
    body('jobDescription')
        .trim()
        .isLength({ min: 50, max: 5000 })
        .withMessage('Job description must be between 50-5000 characters')
        .customSanitizer(value => xss(value, {
            whiteList: {
                'p': [],
                'br': [],
                'strong': [],
                'em': [],
                'ul': [],
                'ol': [],
                'li': []
            }
        })),
    
    // Validate requirements
    body('requirements')
        .trim()
        .isLength({ min: 10, max: 2000 })
        .withMessage('Requirements must be between 10-2000 characters')
        .customSanitizer(value => xss(value)),
    
    // Validate email
    body('contactEmail')
        .trim()
        .isEmail()
        .withMessage('Invalid email address')
        .normalizeEmail()
        .isLength({ max: 100 })
        .withMessage('Email too long'),
    
    // Validate phone (optional)
    body('contactPhone')
        .optional()
        .trim()
        .matches(/^\+?[\d\s\-()]{10,20}$/)
        .withMessage('Invalid phone number format'),
    
    // Validate salary (optional)
    body('salary')
        .optional()
        .trim()
        .isLength({ max: 100 })
        .withMessage('Salary range too long')
        .customSanitizer(value => xss(value)),
    
    // Validate deadline (optional)
    body('applicationDeadline')
        .optional()
        .isISO8601()
        .withMessage('Invalid date format')
        .custom(value => {
            if (value && new Date(value) <= new Date()) {
                throw new Error('Application deadline must be in the future');
            }
            return true;
        })
];

app.use('/webhook/', webhookLimiter);

// ✅ BODY PARSING WITH LIMITS
app.use(express.json({ 
  limit: '10mb',
  verify: (req, res, buf) => {
    // Store raw body for webhook signature verification
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/public', express.static('public'));
app.use('/admin', express.static('public/admin'));
// ✅ RESPONSE TIME TRACKING
app.use((req, res, next) => {
  res.on('finish', () => {
    const responseTime = Date.now() - req.startTime;
    
    // Track metrics
    trackMetric('http.response_time', responseTime, [
      `method:${req.method}`,
      `status:${res.statusCode}`,
      `route:${req.route?.path || req.path}`
    ]);
    
    // Log slow requests
    if (responseTime > 1000) {
      req.logger.warn('Slow request detected', {
        method: req.method,
        url: req.url,
        responseTime: responseTime + 'ms',
        statusCode: res.statusCode
      });
    }
  });
  next();
});


// ================================
// ENHANCED HEALTH CHECKS
// ================================

app.get('/health', async (req, res) => {
  try {
    const checks = await Promise.allSettled([
      dbManager.healthCheck(),
      redisWrapper.ping(),
      checkSystemHealth()
    ]);
    
    const dbHealthy = checks[0].status === 'fulfilled' && checks[0].value === true;
    const redisHealthy = checks[1].status === 'fulfilled';
    const systemHealthy = checks[2].status === 'fulfilled' && checks[2].value.healthy;
    
    const allHealthy = dbHealthy && redisHealthy && systemHealthy;
    
    res.status(allHealthy ? 200 : 503).json({ 
      status: allHealthy ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      services: {
        database: dbHealthy ? 'healthy' : 'unhealthy',
        redis: redisHealthy ? 'healthy' : 'unhealthy',
        system: systemHealthy ? 'healthy' : 'unhealthy',
        ycloud: 'active',
        workers: 'running'
      },
      uptime: process.uptime(),
      version: '2.0.0'
    });
  } catch (error) {
    req.logger.error('Health check failed', { error: error.message });
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
});

// ✅ DETAILED API HEALTH CHECK
app.get('/api/health', async (req, res) => {
  try {
    const [dbHealth, redisHealth, systemHealth] = await Promise.allSettled([
      dbManager.healthCheck(),
      redis.ping(),
      checkSystemHealth()
    ]);
    
    const dbStatus = dbHealth.status === 'fulfilled' && dbHealth.value;
    const redisStatus = redisHealth.status === 'fulfilled';
    const systemStatus = systemHealth.status === 'fulfilled' && systemHealth.value?.healthy;
    
    // Get detailed system metrics
    const memUsage = process.memoryUsage();
    const poolStatus = dbManager.getPoolStatus();
    
    res.json({ 
      status: (dbStatus && redisStatus && systemStatus) ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      services: {
        database: {
          status: dbStatus ? 'healthy' : 'unhealthy',
          connections: poolStatus.connected ? {
            total: poolStatus.totalConnections,
            idle: poolStatus.idleConnections,
            waiting: poolStatus.waitingRequests,
            max: poolStatus.maxConnections
          } : null
        },
        redis: {
          status: redisStatus ? 'healthy' : 'unhealthy'
        },
        ycloud: {
          status: 'configured'
        },
        workers: {
          cv: 'running',
          cvBackground: 'running',
          application: 'running',
          openai: 'running'
        }
      },
      system: {
        uptime: Math.round(process.uptime()),
        memory: {
          usagePercent: Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100),
          heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
          heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB'
        },
        performance: poolStatus.performance
      },
      version: '2.0.0',
      environment: config.get('env')
    });
    
  } catch (error) {
    req.logger.error('API health check failed', { error: error.message });
    res.status(503).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
});

// ✅ SYSTEM HEALTH CHECK FUNCTION
// CORRECTED VERSION for server.js
async function checkSystemHealth() {
  try {
    const memUsage = process.memoryUsage();
    const heapLimit = require('v8').getHeapStatistics().heap_size_limit;
    const memoryUsagePercent = (memUsage.heapUsed / heapLimit) * 100;  // FIXED!
    
    return {
      healthy: memoryUsagePercent < 90,
      memoryUsage: memoryUsagePercent,
      uptime: process.uptime(),
      memoryDetails: {
        usedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
        limitMB: Math.round(heapLimit / 1024 / 1024)
      }
    };
  } catch (error) {
    return { healthy: false, error: error.message };
  }
}

// ================================
// ENHANCED MONITORING ENDPOINTS
// ================================

// ✅ COMPREHENSIVE METRICS ENDPOINT
app.get('/api/metrics', async (req, res) => {
  try {
    const memUsage = process.memoryUsage();
    const poolStatus = dbManager.getPoolStatus();
    
    // Test database response time
    let dbResponseTime = 0;
    try {
      const start = Date.now();
      await dbManager.healthCheck();
      dbResponseTime = Date.now() - start;
    } catch (dbError) {
      req.logger.error('Database metrics check failed', { error: dbError.message });
    }
    
    // Test Redis response time
    let redisResponseTime = 0;
    try {
      const start = Date.now();
      await redis.ping();
      redisResponseTime = Date.now() - start;
    } catch (redisError) {
      req.logger.error('Redis metrics check failed', { error: redisError.message });
    }
    
    const os = require('os');
    const totalMemoryGB = (os.totalmem() / (1024 * 1024 * 1024)).toFixed(1);
    const usedMemoryGB = ((os.totalmem() - os.freemem()) / (1024 * 1024 * 1024)).toFixed(1);
    
    res.json({
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
      memory: {
       usage_percent: Math.round((memUsage.heapUsed / require('v8').getHeapStatistics().heap_size_limit) * 100),
       heap_used_mb: Math.round(memUsage.heapUsed / 1024 / 1024),
       heap_total_mb: Math.round(memUsage.heapTotal / 1024 / 1024),
       heap_limit_mb: Math.round(require('v8').getHeapStatistics().heap_size_limit / 1024 / 1024),
       rss_mb: Math.round(memUsage.rss / 1024 / 1024),
       system_total_gb: parseFloat(totalMemoryGB),
       system_used_gb: parseFloat(usedMemoryGB)
       },
      cpu: {
        cores: os.cpus().length,
        load_average: os.loadavg()[0].toFixed(2)
      },
      services: {
        database: {
          status: poolStatus.connected ? 'connected' : 'disconnected',
          response_time_ms: dbResponseTime,
          connections: poolStatus.connected ? {
            active: poolStatus.totalConnections,
            idle: poolStatus.idleConnections,
            waiting: poolStatus.waitingRequests,
            max: poolStatus.maxConnections
          } : null,
          performance: poolStatus.performance
        },
        redis: {
          status: redisResponseTime > 0 ? 'connected' : 'error',
          response_time_ms: redisResponseTime
        }
      },
      workers: {
        cv_main: { concurrency: 30, status: 'running' },
        cv_background: { concurrency: 20, status: 'running' },
        application: { concurrency: 8, status: 'running' },
        openai: { concurrency: 3, status: 'running' }
      },
      capacity: {
        cv_processing: '3000+ CVs/hour',
        applications: '480+ applications/hour',
        concurrent_users: '1000+ supported'
      },
      environment: config.get('env'),
      version: '2.0.0'
    });
    
  } catch (error) {
    req.logger.error('Metrics endpoint error', { error: error.message });
    res.status(500).json({
      error: 'Failed to retrieve metrics',
      timestamp: new Date().toISOString()
    });
  }
});

// ✅ QUEUE STATISTICS
app.get('/api/queue/stats', async (req, res) => {
  try {
    const { Queue } = require('bullmq');
    const { queueRedis } = require('./config/redis');
    
    const cvQueue = new Queue('cv-processing', { connection: queueRedis });
    const cvBackgroundQueue = new Queue('cv-processing-background', { connection: queueRedis });
    const applicationQueue = new Queue('job-applications', { connection: queueRedis });
    
    const [cvWaiting, cvActive, cvCompleted, cvFailed] = await Promise.all([
      cvQueue.getWaiting(),
      cvQueue.getActive(),
      cvQueue.getCompleted(),
      cvQueue.getFailed()
    ]);
    
    const [cvBgWaiting, cvBgActive, cvBgCompleted, cvBgFailed] = await Promise.all([
      cvBackgroundQueue.getWaiting(),
      cvBackgroundQueue.getActive(),
      cvBackgroundQueue.getCompleted(),
      cvBackgroundQueue.getFailed()
    ]);
    
    const [appWaiting, appActive, appCompleted, appFailed] = await Promise.all([
      applicationQueue.getWaiting(),
      applicationQueue.getActive(),
      applicationQueue.getCompleted(),
      applicationQueue.getFailed()
    ]);

    res.json({
      timestamp: new Date().toISOString(),
      cvProcessing: {
        main: {
          waiting: cvWaiting.length,
          active: cvActive.length,
          completed: cvCompleted.length,
          failed: cvFailed.length,
          concurrency: 30
        },
        background: {
          waiting: cvBgWaiting.length,
          active: cvBgActive.length,
          completed: cvBgCompleted.length,
          failed: cvBgFailed.length,
          concurrency: 20
        },
        totalCapacity: '3000+ CVs/hour'
      },
      applications: {
        waiting: appWaiting.length,
        active: appActive.length,
        completed: appCompleted.length,
        failed: appFailed.length,
        concurrency: 8,
        capacity: '480+ applications/hour'
      },
      activeJobs: {
        cvMain: cvActive.slice(0, 5).map(job => ({
          id: job.id,
          progress: job.progress || 0,
          user: job.data?.identifier ? job.data.identifier.substring(0, 6) + '***' : 'unknown'
        })),
        applications: appActive.slice(0, 5).map(job => ({
          id: job.id,
          progress: job.progress || 0,
          user: job.data?.identifier ? job.data.identifier.substring(0, 6) + '***' : 'unknown',
          jobCount: job.data?.jobs?.length || 0
        }))
      }
    });

  } catch (error) {
    req.logger.error('Queue stats failed', { error: error.message });
    res.status(500).json({ error: 'Failed to get queue statistics' });
  }
});

// ✅ JOB STATISTICS
app.get('/api/jobs/stats', async (req, res) => {
  try {
    const stats = await jobCleanup.getJobStats();
    res.json({
      status: 'success',
      data: stats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    req.logger.error('Failed to get job stats', { error: error.message });
    res.status(500).json({ error: 'Failed to get job stats' });
  }
});

// ================================
// WEBHOOK ENDPOINTS
// ================================
// Helper to process YCloud inbound messages
async function processYCloudMessage(inboundMessage, logger) {
  try {
    const phone = inboundMessage.from;
    const messageId = inboundMessage.id;

    // Text message body or interactive payload
    const messageText = inboundMessage.text?.body || inboundMessage.interactive;

    // Pass to bot.js handler
    return await bot.handleWhatsAppMessage(phone, messageText, null, messageId);

  } catch (err) {
    logger.error('processYCloudMessage failed', { error: err.message });
    throw err;
  }
}

// ✅ YCLOUD WEBHOOK WITH ENHANCED ERROR HANDLING
app.post('/webhook/ycloud', async (req, res) => {
  res.sendStatus(200);

  try {
    // 🔥 dump everything so we see the raw structure
    logger.info('🔥 FULL YCloud webhook body', { body: JSON.stringify(req.body, null, 2) });

    logger.info('YCloud webhook received', {
      type: req.body?.type,
      hasMessage: !!req.body?.whatsappInboundMessage
    });

    const { type, whatsappInboundMessage } = req.body;

    if (type !== 'whatsapp.inbound_message.received') {
      logger.info('YCloud: Non-message event, skipping', { type });
      return;
    }

    if (!whatsappInboundMessage) {
      logger.warn('YCloud: No inbound message found');
      return;
    }

    const userPhone = whatsappInboundMessage.from;
    const messageId = whatsappInboundMessage.id;

    const messageLimit = await RateLimiter.checkLimit(userPhone, 'message');

    if (!messageLimit.allowed) {
      logger.warn('User message rate limited', {
        phone: RateLimiter.maskIdentifier(userPhone),
        remaining: messageLimit.remaining
      });

      await ycloud.sendSmartMessage(userPhone, messageLimit.message, {
        inboundMessageId: messageId,
        messageType: 'instant_response'
      });
      return;
    }

    await processYCloudMessage(whatsappInboundMessage, req.logger);

  } catch (error) {
    req.logger.error('YCloud webhook error', { error: error.message });
  }
});

// Add this BEFORE your error handling middleware
app.post('/webhook/paystack', (req, res) => {
  try {
    const hash = crypto
      .createHmac('sha512', config.get('paystack.secret'))
      .update(JSON.stringify(req.body))
      .digest('hex');
      
    if (hash !== req.headers['x-paystack-signature']) {
      req.logger.warn('Invalid Paystack webhook signature');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const { event, data } = req.body;
    req.logger.info('Paystack webhook received', { event, reference: data?.reference });
    
    if (event === 'charge.success') {
      bot.processPayment(data.reference)
        .then(() => {
          req.logger.info('Paystack webhook processed successfully');
          res.sendStatus(200);
        })
        .catch((error) => {
          req.logger.error('Paystack webhook processing error', { error: error.message });
          res.status(500).json({ error: 'Webhook processing failed' });
        });
    } else {
      req.logger.info('Ignored Paystack webhook event', { event });
      res.sendStatus(200);
    }
  } catch (error) {
    req.logger.error('Paystack webhook error', { error: error.message });
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});
app.post('/api/recruiter/post-job', 
    jobPostingLimiter,
    validateJobInput,
    async (req, res) => {
        try {
            // Check validation errors
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                req.logger.warn('Job posting validation failed', { 
                    errors: errors.array(),
                    ip: req.ip 
                });
                return res.status(400).json({
                    success: false,
                    error: 'Invalid input data',
                    details: errors.array()
                });
            }

            const jobData = req.body;
            const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
            
            req.logger.info('Received job posting request', { 
                company: jobData.companyName,
                title: jobData.jobTitle,
                ip: clientIP,
                userAgent: req.get('User-Agent')
            });

            // Additional business logic validation
            await performBusinessValidation(jobData, req);

          

            // Process and sanitize the job data
            const processedJob = await processJobDataSecurely(jobData, clientIP);
            
            // Insert into database with transaction
            const insertedJob = await insertJobToDatabase(processedJob);
            
            // ADD THIS LINE HERE - NOTIFY ADMIN
        await notifyAdminNewJob(insertedJob, clientIP, req.get('User-Agent'));
            // Log successful job posting
            req.logger.info('Job posted successfully', {
                jobId: insertedJob.id,
                company: insertedJob.company,
                title: insertedJob.title,
                ip: clientIP
            });

            // Send response (don't expose internal job ID structure)
            res.json({
                success: true,
                message: 'Job posted successfully!',
                jobId: insertedJob.id,
                jobTitle: sanitizeForOutput(insertedJob.title),
                company: sanitizeForOutput(insertedJob.company),
                expiresIn: '30 days'
            });

        } catch (error) {
            req.logger.error('Job posting error', { 
                error: error.message,
                stack: error.stack,
                ip: req.ip,
                body: sanitizeLogData(req.body)
            });

            res.status(500).json({
                success: false,
                error: 'Unable to process job posting. Please try again.'
            });
        }
    }
);



// ✅ ENHANCED YCLOUD MESSAGE PROCESSING
async function processYCloudMessage(message, logger) {
  try {
    const { from, type, id: messageId } = message;
    
    // Duplicate detection
    const duplicateKey = `msg:${messageId}`;
    const exists = await redis.exists(duplicateKey);
    if (exists) {
      logger.info('Duplicate YCloud message ignored', { messageId });
      return;
    }
    
    await redis.set(duplicateKey, '1', 'EX', 3600);

    logger.info('Processing YCloud message', { type, from, messageId });

    switch (type) {
      case 'text':
        const messageText = message.text?.body;
        if (messageText) {
          // ✅ Pass messageId for typing indicator
          await bot.handleWhatsAppMessage(from, messageText, null, messageId);
        }
        break;
        
      case 'document':
        await handleYCloudDocumentMessage(message, logger);
        break;
        
      case 'image':
        // ✅ Use smart messaging with typing
        await ycloud.sendSmartMessage(from, 
          '📄 Please send your CV as a document (PDF/DOCX), not an image.',
          {
            inboundMessageId: messageId,
            messageType: 'instant_response'
          }
        );
        break;
        
      case 'video':
      case 'audio':
        // ✅ Handle unsupported media with typing
        await ycloud.sendSmartMessage(from,
          '📄 I can only process PDF and DOCX files for job applications. Please upload your CV as a document.',
          {
            inboundMessageId: messageId,
            messageType: 'instant_response'
          }
        );
        break;
        
      default:
        // ✅ Default response with typing
        await ycloud.sendSmartMessage(from,
          'Hi! I help you find jobs in Nigeria. Send me a message or upload your CV.',
          {
            inboundMessageId: messageId,
            messageType: 'instant_response'
          }
        );
    }

  } catch (error) {
    logger.error('YCloud message processing error', {
      messageId: message.id,
      error: error.message
    });
    
    try {
      // ✅ Error message with typing
      await ycloud.sendSmartMessage(message.from, 
        '⚠️ Sorry, something went wrong. Please try again.',
        {
          inboundMessageId: message.id,
          messageType: 'instant_response'
        }
      );
    } catch (sendError) {
      logger.error('Failed to send error message', { sendError: sendError.message });
    }
  }
}
// ✅ DOCUMENT MESSAGE HANDLER
async function handleYCloudDocumentMessage(message, logger) {
  const { from, document, id: messageId } = message;
  
  try {
    if (!document) {
      await ycloud.sendSmartMessage(from, '⚠️ No document found in message.', {
        inboundMessageId: messageId,
        messageType: 'instant_response'
      });
      return;
    }

    // Validate file type
    const allowedTypes = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword'
    ];
    
    if (!allowedTypes.includes(document.mime_type)) {
      await ycloud.sendSmartMessage(from,
        `⚠️ Unsupported file type: ${document.mime_type}\n\n✅ Please send:\n• PDF files (.pdf)\n• Word documents (.docx)`,
        {
          inboundMessageId: messageId,
          messageType: 'instant_response'
        }
      );
      return;
    }

    // Show processing typing while downloading
    await ycloud.sendSmartMessage(from, '⏳ Downloading your CV...', {
      inboundMessageId: messageId,
      messageType: 'processing'
    });

    // Download document
    const downloadResult = await ycloud.downloadDocument(document);
    
    // Validate downloaded file
    ycloud.validateDocument(document, downloadResult.buffer);

    logger.info('YCloud document downloaded successfully', {
      from,
      filename: downloadResult.filename,
      size: downloadResult.size,
      method: downloadResult.method
    });

    // ✅ Send to bot with messageId for typing indicators
    await bot.handleWhatsAppMessage(from, null, {
      buffer: downloadResult.buffer,
      originalname: downloadResult.filename || 'document.pdf',
      mimetype: downloadResult.mimeType || document.mime_type,
      email: null,
      phone: from
    }, messageId);

  } catch (error) {
    logger.error('YCloud document processing error', {
      from,
      error: error.message
    });

    await ycloud.sendSmartMessage(from,
      '⚠️ Failed to process document. Please try again.',
      {
        inboundMessageId: messageId,
        messageType: 'instant_response'
      }
    );
  }
}
function processJobData(rawJobData) {
    const jobId = uuidv4();
    
    return {
        id: jobId,
        title: rawJobData.jobTitle.trim(),
        company: rawJobData.companyName.trim(),
        description: rawJobData.jobDescription.trim(),
        requirements: rawJobData.requirements ? rawJobData.requirements.trim() : extractRequirementsFromDescription(rawJobData.jobDescription),
        experience: mapExperienceLevel(rawJobData.experience),
        salary: rawJobData.salary ? rawJobData.salary.trim() : 'Competitive',
        location: rawJobData.location.trim(),
        state: cleanStateName(rawJobData.location),
        email: rawJobData.contactEmail.toLowerCase().trim(),
        phone: rawJobData.contactPhone ? rawJobData.contactPhone.trim() : null,
        category: rawJobData.jobCategory,
        is_remote: isRemoteJob(rawJobData.location),
        recruiter_name: rawJobData.companyName.trim(),
        recruiter_id: null,
        expires_at: rawJobData.applicationDeadline ? new Date(rawJobData.applicationDeadline) : new Date(Date.now() + (30 * 24 * 60 * 60 * 1000)), // 30 days from now or custom deadline
        scraped_at: new Date(),
        last_updated: new Date(),
        source: 'free_website_form',
        external_id: `website_free_${jobId}`,
        application_url: null,
        url: null
    };
}
async function performBusinessValidation(jobData, req) {
    // Check for suspicious patterns
    const suspiciousPatterns = [
        /\b(bitcoin|crypto|investment|earn money|work from home|guaranteed income)\b/i,
        /\b(click here|visit|website|link)\b/i,
        /\$\d{4,}|\₦\d{6,}/g // Suspiciously high salaries
    ];

    const fullText = `${jobData.jobTitle} ${jobData.jobDescription} ${jobData.requirements}`.toLowerCase();
    
    for (const pattern of suspiciousPatterns) {
        if (pattern.test(fullText)) {
            req.logger.warn('Suspicious job posting detected', { 
                pattern: pattern.toString(),
                ip: req.ip,
                company: jobData.companyName 
            });
            // Could either block or flag for review
            // throw new Error('Job posting flagged for review');
        }
    }

    // Validate email domain (basic check)
    const emailDomain = jobData.contactEmail.split('@')[1];
    const suspiciousDomains = ['tempmail.com', '10minutemail.com', 'guerrillamail.com'];
    if (suspiciousDomains.includes(emailDomain)) {
        throw new Error('Please use a business email address');
    }
}


async function processJobDataSecurely(rawJobData, clientIP) {
    const jobId = uuidv4();
    
    // Additional sanitization
    const sanitizedData = {
        id: jobId,
        title: sanitizeText(rawJobData.jobTitle),
        company: sanitizeText(rawJobData.companyName),
        description: sanitizeHTML(rawJobData.jobDescription),
        requirements: sanitizeHTML(rawJobData.requirements),
        experience: rawJobData.experience, // Already validated
        salary: rawJobData.salary ? sanitizeText(rawJobData.salary) : 'Competitive',
        location: rawJobData.location, // Already validated against whitelist
        state: cleanStateName(rawJobData.location),
        email: rawJobData.contactEmail.toLowerCase(), // Already normalized
        phone: rawJobData.contactPhone ? sanitizeText(rawJobData.contactPhone) : null,
        category: rawJobData.jobCategory, // Already validated
        is_remote: isRemoteJob(rawJobData.location),
        recruiter_name: sanitizeText(rawJobData.companyName),
        recruiter_id: null,
        expires_at: rawJobData.applicationDeadline ? 
            new Date(rawJobData.applicationDeadline) : 
            new Date(Date.now() + (30 * 24 * 60 * 60 * 1000)),
        scraped_at: new Date(),
        last_updated: new Date(),
        source: 'free_website_form',
        external_id: `website_free_${jobId}`,
        application_url: null,
        url: null,
        poster_ip: hashIP(clientIP) // Store hashed IP for abuse prevention
    };

    return sanitizedData;
}

function sanitizeText(text) {
    if (!text) return null;
    return xss(text, { whiteList: {} }); // Strip all HTML
}

function sanitizeHTML(html) {
    if (!html) return null;
    return xss(html, {
        whiteList: {
            'p': [],
            'br': [],
            'strong': [],
            'em': [],
            'ul': [],
            'ol': [],
            'li': []
        }
    });
}

function sanitizeForOutput(text) {
    if (!text) return '';
    return validator.escape(text);
}

function sanitizeLogData(data) {
    const sanitized = { ...data };
    // Remove sensitive data from logs
    if (sanitized.contactEmail) {
        sanitized.contactEmail = sanitized.contactEmail.replace(/(.{3}).*(@.*)/, '$1***$2');
    }
    if (sanitized.contactPhone) {
        sanitized.contactPhone = sanitized.contactPhone.replace(/(.{3}).*(.{3})/, '$1***$2');
    }
    return sanitized;
}

function hashIP(ip) {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(ip + process.env.IP_SALT || 'default_salt').digest('hex');
}

async function insertJobToDatabase(jobData) {
    const query = `
        INSERT INTO jobs (
            id, title, company, description, requirements, experience, salary,
            location, state, email, phone, category, is_remote,
            recruiter_id, expires_at, scraped_at, last_updated, source,
            external_id, application_url, url
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
            $14, $15, $16, $17, $18, $19, $20, $21
        )
        RETURNING *
    `;

    const values = [
        jobData.id, jobData.title, jobData.company, jobData.description,
        jobData.requirements, jobData.experience, jobData.salary,
        jobData.location, jobData.state, jobData.email, jobData.phone,
        jobData.category, jobData.is_remote,
        jobData.recruiter_id, jobData.expires_at, jobData.scraped_at,
        jobData.last_updated, jobData.source, jobData.external_id,
        jobData.application_url, jobData.url
    ];

    try {
        const { rows } = await dbManager.query(query, values);
        return rows[0];
    } catch (error) {
        logger.error('Database insertion error', {
            error: error.message,
            jobData: { id: jobData.id, title: jobData.title, company: jobData.company }
        });
        throw new Error('Failed to save job to database: ' + error.message);
    }
}

function extractRequirementsFromDescription(description) {
    const requirementKeywords = [
        'bachelor', 'degree', 'certification', 'experience', 'years',
        'skills', 'knowledge', 'proficient', 'excel', 'office', 'required',
        'must have', 'should have', 'qualification', 'minimum', 'preferred'
    ];
    
    const sentences = description.split(/[.!?]+/).filter(s => s.trim().length > 10);
    const requirements = sentences.filter(sentence => 
        requirementKeywords.some(keyword => 
            sentence.toLowerCase().includes(keyword)
        )
    );
    
    return requirements.length > 0 ? requirements.slice(0, 5).join('; ') : null;
}

function mapExperienceLevel(experience) {
    const mapping = {
        'entry': 'Fresh Graduate',
        'mid': '3 years',
        'senior': '5 years', 
        'executive': '10 years'
    };
    return mapping[experience] || 'Not specified';
}

function isRemoteJob(location) {
    return location.toLowerCase().includes('remote') || 
           location === 'Remote Work' ||
           location === 'Remote';
}

function cleanStateName(location) {
    if (location === 'Abuja (FCT)') return 'Abuja';
    if (location === 'Remote Work') return 'Remote';
    if (location === 'Remote') return 'Remote';
    return location;
}

async function notifyAdminNewJob(job, clientIP, userAgent) {
    try {
        const adminEmail = process.env.ADMIN_EMAIL || 'ugobakare@gmail.com';
        
        // Create transporter inside function to avoid scope issues
        const emailTransporter = nodemailer.createTransport({
            host: 'smtp.zeptomail.com',
            port: 587,
            secure: false,
            auth: {
                user: process.env.ALERT_SMTP_USER,
                pass: process.env.ALERT_SMTP_PASS
            }
        });
        
        const emailContent = {
              from: 'alerts@smartcvnaija.com.ng', 
            to: adminEmail,
            subject: `New Job: ${job.title} - ${job.company}`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #667eea;">New Job Posted</h2>
                    
                    <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
                        <h3 style="margin-top: 0;">${job.title}</h3>
                        <p><strong>Company:</strong> ${job.company}</p>
                        <p><strong>Location:</strong> ${job.location}</p>
                        <p><strong>Experience:</strong> ${job.experience}</p>
                        <p><strong>Category:</strong> ${job.category}</p>
                        <p><strong>Salary:</strong> ${job.salary}</p>
                        <p><strong>Contact:</strong> ${job.email}</p>
                        <p><strong>Phone:</strong> ${job.phone || 'Not provided'}</p>
                        <p><strong>Posted:</strong> ${new Date().toLocaleString()}</p>
                        <p><strong>Expires:</strong> ${job.expires_at.toLocaleString()}</p>
                    </div>
                    
                    <div style="background: #e8f4fd; padding: 15px; border-radius: 8px; margin: 20px 0;">
                        <h4>Description:</h4>
                        <p>${job.description}</p>
                    </div>
                    
                    <div style="background: #fff3cd; padding: 15px; border-radius: 8px; margin: 20px 0;">
                        <h4>Requirements:</h4>
                        <p>${job.requirements}</p>
                    </div>
                    
                    <div style="background: #f0f0f0; padding: 10px; border-radius: 5px; margin: 20px 0; font-size: 12px;">
                        <p><strong>Job ID:</strong> ${job.id}</p>
                        <p><strong>Source:</strong> ${job.source}</p>
                        <p><strong>IP:</strong> ${clientIP}</p>
                        <p><strong>Remote:</strong> ${job.is_remote ? 'Yes' : 'No'}</p>
                    </div>
                </div>
            `
        };
        
        await emailTransporter.sendMail(emailContent);
        logger.info('Admin job notification sent', { 
            jobId: job.id, 
            company: job.company,
            title: job.title 
        });
        
    } catch (error) {
        logger.error('Admin notification failed', { 
            error: error.message,
            jobId: job.id 
        });
        // Don't throw - job posting should still succeed
    }
}

// ================================
// SUCCESS PAGE FOR FREE POSTING
// ================================

app.get('/job-posted-success', (req, res) => {
    const { jobId, title, company } = req.query;
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Job Posted Successfully - SmartCV Nigeria</title>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { 
                    font-family: Arial, sans-serif; 
                    text-align: center; 
                    padding: 50px; 
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    min-height: 100vh;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    margin: 0;
                }
                .container { 
                    max-width: 600px; 
                    background: white; 
                    color: #333; 
                    padding: 40px; 
                    border-radius: 15px;
                    box-shadow: 0 10px 30px rgba(0,0,0,0.3);
                }
                .success-icon { 
                    font-size: 4rem; 
                    color: #27ae60; 
                    margin-bottom: 1rem; 
                }
                .job-details { 
                    background: #f8f9fa; 
                    padding: 20px; 
                    border-radius: 8px; 
                    margin: 20px 0;
                    text-align: left;
                }
                .btn {
                    display: inline-block;
                    background: #667eea;
                    color: white;
                    padding: 12px 24px;
                    text-decoration: none;
                    border-radius: 25px;
                    margin: 10px;
                    transition: all 0.3s ease;
                    font-weight: bold;
                }
                .btn:hover {
                    background: #764ba2;
                    transform: translateY(-2px);
                }
                .btn-whatsapp {
                    background: #25D366;
                }
                .btn-whatsapp:hover {
                    background: #20b954;
                }
                ul {
                    text-align: left;
                    max-width: 400px;
                    margin: 20px auto;
                }
                li {
                    margin: 8px 0;
                    line-height: 1.5;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="success-icon">🎉</div>
                <h1>Job Posted Successfully!</h1>
                <p>Your job opening is now live on SmartCV Nigeria</p>
                
                <div class="job-details">
                    <h3>${title || 'Your Job'}</h3>
                    <p><strong>Company:</strong> ${company || 'Your Company'}</p>
                    <p><strong>Job ID:</strong> ${jobId || 'N/A'}</p>
                    <p><strong>Status:</strong> ✅ Active for 30 days</p>
                </div>
                
                <h3>What happens next?</h3>
                <ul>
                    <li>📢 Your job is now visible to thousands of job seekers</li>
                    <li>📧 Qualified candidates will apply directly via email</li>
                    <li>⏰ You should start receiving applications within 24-48 hours</li>
                    <li>📨 Applications will be sent to your provided email address</li>
                </ul>
                
                <div style="margin-top: 30px;">
                    <a href="/" class="btn">Post Another Job</a>
                    <a href="https://wa.me/+2349049456183?text=Hi,%20I%20just%20posted%20a%20job%20and%20need%20help" class="btn btn-whatsapp">Get Support</a>
                </div>
                
                <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; font-size: 14px; color: #666;">
                    <p>Thank you for using SmartCV Nigeria!</p>
                </div>
            </div>
        </body>
        </html>
    `);
});
// ================================
// PAYMENT SUCCESS PAGE
// ================================

app.get('/payment/success', async (req, res) => {
  try {
    const { ref, reference } = req.query;
    const paymentRef = ref || reference;
    
    if (!paymentRef) {
      return res.status(400).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Payment Error - SmartCVNaija</title>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
            .container { max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; }
            .error { color: #e74c3c; font-size: 18px; margin: 20px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>⚠️ Payment Error</h1>
            <p class="error">Invalid payment reference</p>
            <p>Please contact support if you completed a payment.</p>
          </div>
        </body>
        </html>
      `);
    }

    // Verify payment
    let paymentStatus = 'pending';
    let amount = 0;
    
    try {
      const paystackService = require('./services/paystack');
      const isValid = await paystackService.verifyPayment(paymentRef);
      
      if (isValid) {
        const axios = require('axios');
        const response = await axios.get(
          `https://api.paystack.co/transaction/verify/${paymentRef}`,
          {
            headers: {
              Authorization: `Bearer ${config.get('paystack.secret')}`
            }
          }
        );
        
        if (response.data.data.status === 'success') {
          amount = response.data.data.amount / 100;
          paymentStatus = 'success';
        }
      }
    } catch (error) {
      req.logger.error('Payment verification error', { paymentRef, error: error.message });
    }

    if (paymentStatus === 'success') {
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Payment Successful - SmartCVNaija</title>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; }
            .container { max-width: 600px; margin: 0 auto; background: white; color: #333; padding: 40px; border-radius: 15px; }
            .success { color: #27ae60; font-size: 24px; margin: 20px 0; }
            .amount { background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0; font-size: 18px; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>🎉 Payment Successful!</h1>
            <p class="success">Your payment has been processed successfully</p>
            <div class="amount">
              <strong>Amount Paid: ₦${amount.toFixed(2)}</strong><br>
              <small>Reference: ${paymentRef}</small>
            </div>
            <p><strong>You now have 10 job applications for today!</strong></p>
            <p>Return to WhatsApp to continue your job search.</p>
          </div>
        </body>
        </html>
      `);
    } else {
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Payment Failed - SmartCVNaija</title>
        </head>
        <body>
          <div style="text-align: center; padding: 50px;">
            <h1>❌ Payment Failed</h1>
            <p>Your payment could not be processed</p>
            <p>Reference: <code>${paymentRef}</code></p>
          </div>
        </body>
        </html>
      `);
    }

  } catch (error) {
    req.logger.error('Payment success page error', { error: error.message });
    res.status(500).send('System error occurred');
  }
});

// ================================
// ADMIN ENDPOINTS
// ================================

app.get('/admin/rate-limits/:phone', async (req, res) => {
  try {
    const phone = req.params.phone;
    const stats = {};
    
    for (const action of ['message', 'job_search', 'cv_upload', 'application']) {
      const usage = await RateLimiter.getUsageStats(phone, action);
      stats[action] = usage;
    }
    
    res.json({
      phone: phone.substring(0, 6) + '***',
      rate_limits: stats,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    req.logger.error('Error getting rate limits', { error: error.message });
    res.status(500).json({ error: 'Failed to get rate limit stats' });
  }
});

app.delete('/admin/rate-limits/:phone', async (req, res) => {
  try {
    const phone = req.params.phone;
    const clearedCount = await RateLimiter.clearUserLimits(phone);
    
    res.json({
      message: 'Rate limits cleared',
      phone: phone.substring(0, 6) + '***',
      cleared_keys: clearedCount,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    req.logger.error('Error clearing rate limits', { error: error.message });
    res.status(500).json({ error: 'Failed to clear rate limits' });
  }
});

// ================================
// ERROR HANDLING
// ================================

app.use((err, req, res, next) => {
  req.logger.error('Unhandled error', { 
    error: err.message, 
    stack: err.stack,
    url: req.url,
    method: req.method
  });
  
  trackMetric('http.error', 1, [`status:500`, `method:${req.method}`]);
  res.status(500).json({ error: 'An internal server error occurred' });
});

app.use((req, res) => {
  req.logger.warn('Route not found', { url: req.url, method: req.method });
  trackMetric('http.not_found', 1, [`method:${req.method}`]);
  res.status(404).json({ error: 'Route not found' });
});

// ================================
// SERVER STARTUP
// ================================

const server = app.listen(config.get('port'), () => {
  logger.info(`🚀 SmartCVNaija Production Server Started Successfully`, {
    port: config.get('port'),
    environment: config.get('env'),
    baseUrl: config.get('baseUrl'),
    platform: 'WhatsApp (YCloud)',
    capacity: {
      cvProcessing: '3000+ CVs/hour',
      applications: '480+ applications/hour',
      concurrentUsers: '1000+ supported'
    },
    workers: {
      cvMain: 30,
      cvBackground: 20,
      application: 8,
      openai: 3
    },
    timestamp: new Date().toISOString()
  });
});

// ================================
// GRACEFUL SHUTDOWN
// ================================

const gracefulShutdown = async (signal) => {
  logger.info(`Received ${signal}, starting graceful shutdown`);
  
  try {
    await new Promise((resolve) => {
      server.close((err) => {
        if (err) {
          logger.error('Error closing server', { error: err.message });
        } else {
          logger.info('Server closed successfully');
        }
        resolve();
      });
    });
    
    // Close workers
    if (openaiWorker && typeof openaiWorker.close === 'function') {
      await openaiWorker.close();
      logger.info('OpenAI worker closed');
    }
    
    if (cvWorker && typeof cvWorker.close === 'function') {
      await cvWorker.close();
      logger.info('CV worker closed');
    }
    
    if (cvBackgroundWorker && typeof cvBackgroundWorker.close === 'function') {
      await cvBackgroundWorker.close();
      logger.info('CV background worker closed');
    }
    
    if (applicationWorker && typeof applicationWorker.close === 'function') {
      await applicationWorker.close();
      logger.info('Application worker closed');
    }
    
    await dbManager.close();
    logger.info('Database connection closed');
    
    if (statsd && typeof statsd.close === 'function') {
      statsd.close();
      logger.info('StatsD connection closed');
    }
    
    logger.info('Graceful shutdown completed');
    process.exit(0);
    
  } catch (error) {
    logger.error('Error during graceful shutdown', { error: error.message });
    process.exit(1);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', { 
    reason: reason?.message || reason,
    stack: reason?.stack
  });
  
  setTimeout(() => {
    logger.error('Exiting due to unhandled rejection');
    process.exit(1);
  }, 1000);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', { 
    error: error.message, 
    stack: error.stack 
  });
  process.exit(1);
});

module.exports = app;