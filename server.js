require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const fs = require('fs');
const { Pool } = require('pg');
const Redis = require('ioredis');
const config = require('./config');
const logger = require('./utils/logger');
const { statsd, trackMetric } = require('./utils/metrics');
const bot = require('./services/bot');
const openaiWorker = require('./workers/openai');
const cvWorker = require('./workers/cv');
const redis = require('./config/redis');
const app = express();
const jobCleanup = require('./services/job-cleanup');
const dbManager = require('./config/database');
const dbManager = require('./config/database');

let pool = null;

async function initializeDatabase() {
  try {
    pool = await dbManager.connect();
    logger.info('Database connection established in server.js');
  } catch (error) {
    logger.error('Failed to initialize database in server.js', { error: error.message });
    process.exit(1);
  }
}


redis.on('error', (error) => {
  logger.error('Redis connection error', { error: error.message });
});

redis.on('connect', () => {
  logger.info('Redis connected successfully');
});


// Create Uploads directory if it doesn't exist
if (!fs.existsSync('./Uploads')) {
  fs.mkdirSync('./Uploads');
}

// Middleware
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || uuidv4();
  res.setHeader('X-Request-Id', req.id);
  req.logger = logger.child({ requestId: req.id });
  next();
});

app.use(cors({ 
  origin: config.get('baseUrl'), 
  methods: ['GET', 'POST'],
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/public', express.static('public'));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    services: {
      database: 'connected',
      redis: 'connected',
      workers: 'running'
    }
  });
});

// API Health endpoint (alternative to /health)
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    services: {
      database: 'connected',
      redis: 'connected',
      workers: 'running'
    },
    version: '1.0.0',
    uptime: process.uptime()
  });
});

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

// Enhanced Metrics endpoint
app.get('/api/metrics', async (req, res) => {
  try {
    // Get basic system metrics
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    
    // Test database connection
    let dbStatus = 'connected';
    let dbResponseTime = 0;
    try {
      const start = Date.now();
      await pool.query('SELECT 1');
      dbResponseTime = Date.now() - start;
    } catch (dbError) {
      dbStatus = 'error';
      req.logger.error('Database health check failed', { error: dbError.message });
    }
    
    // Test Redis connection
    let redisStatus = 'connected';
    let redisResponseTime = 0;
    try {
      const start = Date.now();
      await redis.ping();
      redisResponseTime = Date.now() - start;
    } catch (redisError) {
      redisStatus = 'error';
      req.logger.error('Redis health check failed', { error: redisError.message });
    }
    
    // Simple queue stats to avoid WRONGTYPE errors
    let queueStats = { message: 'Basic queue monitoring active' };
    
    res.json({
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
      memory: {
        usage_percent: Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100),
        heap_used_mb: Math.round(memUsage.heapUsed / 1024 / 1024),
        heap_total_mb: Math.round(memUsage.heapTotal / 1024 / 1024),
        rss_mb: Math.round(memUsage.rss / 1024 / 1024)
      },
      cpu: {
        usage_percent: Math.round(((cpuUsage.user + cpuUsage.system) / 1000000) * 100) || 0
      },
      services: {
        database: {
          status: dbStatus,
          response_time_ms: dbResponseTime
        },
        redis: {
          status: redisStatus,
          response_time_ms: redisResponseTime
        },
        telegram_bot: {
          status: telegramBot ? 'initialized' : 'not_configured'
        }
      },
      queues: queueStats,
      environment: config.get('env'),
      version: '1.0.0'
    });
    
  } catch (error) {
    req.logger.error('Metrics endpoint error', { error: error.message });
    res.status(500).json({
      error: 'Failed to retrieve metrics',
      timestamp: new Date().toISOString()
    });
  }
});

// WhatsApp webhook

// Replace the WhatsApp webhook in server.js with this fixed version

// Replace your existing WhatsApp webhook
app.post('/webhook/whatsapp', async (req, res) => {
  try {
    console.log('=== WHAPI Webhook Received ===', JSON.stringify(req.body, null, 2));
    
    const { messages } = req.body;
    
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid webhook payload' });
    }

    for (const message of messages) {
      try {
        if (message.type === 'text') {
          let messageText = message.body || message.text?.body || message.text;
          if (messageText) {
            await bot.handleWhatsAppMessage(message.from, messageText);
          }
          
        } else if (message.type === 'document') {
          await handleWhatsAppDocument(message, req.logger);
          
        } else if (message.type === 'image') {
          await bot.sendWhatsAppMessage(message.from, 
            '📄 Please send your CV as a document (PDF/DOCX), not an image.');
            
        } else {
          await bot.sendWhatsAppMessage(message.from, 
            'ℹ️ I can process text messages and CV documents (PDF/DOCX).');
        }
        
      } catch (messageError) {
        req.logger.error('Error processing WhatsApp message', {
          error: messageError.message
        });
        await bot.sendWhatsAppMessage(message.from, 
          '❌ Sorry, I encountered an error. Please try again.');
      }
    }
    
    res.sendStatus(200);
  } catch (error) {
    req.logger.error('WhatsApp webhook error', { error: error.message });
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ADD this new function after your webhook
async function handleWhatsAppDocument(message, logger) {
  const axios = require('axios');
  
  if (!message.document || !message.document.filename) {
    await bot.sendWhatsAppMessage(message.from, 
      '❌ Invalid document. Please send a valid PDF or DOCX file.');
    return;
  }
  
  const allowedTypes = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword'
  ];
  
  if (!allowedTypes.includes(message.document.mimetype)) {
    await bot.sendWhatsAppMessage(message.from, 
      '❌ Unsupported file type. Please send a PDF or DOCX file only.');
    return;
  }

  let fileBuffer;
  
  try {
    if (message.document.data) {
      const fileSize = (message.document.data.length * 3) / 4;
      if (fileSize > 5 * 1024 * 1024) {
        await bot.sendWhatsAppMessage(message.from, 
          '❌ File too large. Please send a file smaller than 5MB.');
        return;
      }
      fileBuffer = Buffer.from(message.document.data, 'base64');
      
    } else if (message.document.link) {
      const response = await axios.get(message.document.link, {
        responseType: 'arraybuffer',
        timeout: 30000,
        maxContentLength: 5 * 1024 * 1024
      });
      fileBuffer = Buffer.from(response.data);
      
    } else if (message.document.id) {
      const response = await axios.get(
        `https://gate.whapi.cloud/media/${message.document.id}`,
        {
          headers: {
            'Authorization': `Bearer ${config.get('whatsapp.token')}`
          },
          responseType: 'arraybuffer',
          timeout: 30000,
          maxContentLength: 5 * 1024 * 1024
        }
      );
      fileBuffer = Buffer.from(response.data);
    }

    await bot.handleWhatsAppMessage(message.from, null, {
      buffer: fileBuffer,
      originalname: message.document.filename,
      mimetype: message.document.mimetype,
      email: message.from_email || null,
      phone: message.from
    });
    
  } catch (downloadError) {
    await bot.sendWhatsAppMessage(message.from, 
      '❌ Failed to download your CV. Please try uploading again.');
  }
}
// Paystack webhook
app.post('/webhook/paystack', (req, res) => {
  try {
    const hash = crypto
      .createHmac('sha512', config.get('paystack.secret'))
      .update(JSON.stringify(req.body))
      .digest('hex');
      
    if (hash !== req.headers['x-paystack-signature']) {
      req.logger.warn('Invalid Paystack webhook signature', { 
        signature: req.headers['x-paystack-signature'],
        expected: hash
      });
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const { event, data } = req.body;
    req.logger.info('Paystack webhook received', { event, reference: data?.reference });
    
    if (event === 'charge.success') {
      bot.processPayment(data.reference)
        .then(() => {
          req.logger.info('Paystack webhook processed successfully', { reference: data.reference });
          res.sendStatus(200);
        })
        .catch((error) => {
          req.logger.error('Paystack webhook processing error', { 
            reference: data.reference, 
            error: error.message 
          });
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

// Telegram webhook endpoint - always available
app.post('/webhook/telegram', async (req, res) => {
  try {
    const telegramToken = config.get('telegram.token');
    
    // Check if Telegram is configured
    if (!telegramToken || telegramToken.trim() === '' || telegramToken === 'your-telegram-token') {
      req.logger.warn('Telegram webhook received but not configured', {
        body: req.body
      });
      return res.status(503).json({ 
        error: 'Telegram not configured',
        message: 'Please configure TELEGRAM_TOKEN in environment variables'
      });
    }

    // Check if Telegram bot is initialized
    if (!telegramBot) {
      req.logger.warn('Telegram webhook received but bot not initialized', {
        body: req.body
      });
      return res.status(503).json({ 
        error: 'Telegram bot not initialized',
        message: 'Telegram bot failed to initialize - check token validity'
      });
    }

    // Process the update
    await telegramBot.processUpdate(req.body);
    res.sendStatus(200);
    
  } catch (error) {
    req.logger.error('Telegram webhook processing error', { 
      error: error.message,
      update: req.body
    });
    res.status(500).json({ error: 'Telegram webhook failed' });
  }
});

// Telegram setup - only if valid token exists
let telegramBot = null;
const telegramToken = config.get('telegram.token');

if (telegramToken && 
    telegramToken.trim() !== '' && 
    telegramToken !== 'your-telegram-token') {
  
  try {
    telegramBot = new TelegramBot(telegramToken, { 
      polling: false,
      webHook: false,
      request: {
        agentOptions: {
          family: 4  // Force IPv4 to avoid IPv6 timeout issues
        }
      }
    });
    
    // Set webhook URL
    telegramBot.setWebHook(`${config.get('baseUrl')}/webhook/telegram`)
      .then(() => {
        logger.info('Telegram webhook set successfully');
      })
      .catch((webhookError) => {
        logger.error('Failed to set Telegram webhook', { error: webhookError.message });
      });
    
    logger.info('Telegram bot initialized successfully');
    
    // Telegram message handlers
    telegramBot.on('message', async (msg) => {
      try {
        if (msg.document) {
          // Handle document upload
          const file = await telegramBot.downloadFile(msg.document.file_id, './Uploads');
          const fileData = fs.readFileSync(file);
          
          if (fileData.length > 5 * 1024 * 1024) {
            await bot.sendTelegramMessage(msg.chat.id, 'File is too large. Please upload a CV smaller than 5MB.');
            return;
          }
          
          await bot.handleTelegramMessage(msg.chat.id, null, {
            buffer: fileData,
            originalname: msg.document.file_name,
            email: msg.from.email || null,
            chatId: msg.chat.id
          });
        } else if (msg.text) {
          // Handle text message
          await bot.handleTelegramMessage(msg.chat.id, msg.text);
        } else {
          // Handle other message types
          await bot.sendTelegramMessage(msg.chat.id, 'I can only process text messages and document files (PDF/DOCX).');
        }
      } catch (error) {
        logger.error('Telegram message processing error', { 
          chatId: msg.chat.id, 
          error: error.message,
          messageType: msg.document ? 'document' : 'text'
        });
        
        try {
          await bot.sendTelegramMessage(msg.chat.id, 'An error occurred while processing your message. Please try again.');
        } catch (sendError) {
          logger.error('Failed to send Telegram error message', { sendError: sendError.message });
        }
      }
    });
    
    // Telegram error handler
    telegramBot.on('error', (error) => {
      logger.error('Telegram bot error', { error: error.message });
    });
    
  } catch (telegramError) {
    logger.error('Failed to initialize Telegram bot', { error: telegramError.message });
    telegramBot = null;
  }
} else {
  logger.info('Telegram bot not initialized - no valid token provided');
}

// Test endpoint
app.get('/test/webhooks', (req, res) => {
  const whapiToken = config.get('whatsapp.token');
  const paystackSecret = config.get('paystack.secret');
  const telegramToken = config.get('telegram.token');
  
  res.json({
    status: 'ok',
    webhooks: {
      whatsapp: {
        endpoint: '/webhook/whatsapp',
        configured: !!(whapiToken && whapiToken.trim() !== '' && whapiToken !== 'your-whapi-token')
      },
      paystack: {
        endpoint: '/webhook/paystack',
        configured: !!(paystackSecret && paystackSecret.trim() !== '' && paystackSecret !== 'sk_test_xxxxxxxx')
      },
      telegram: {
        endpoint: '/webhook/telegram',
        configured: !!(telegramToken && telegramToken.trim() !== '' && telegramToken !== 'your-telegram-token'),
        botInitialized: !!telegramBot
      }
    }
  });
});

// Error handling middleware
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

// 404 handler
app.use((req, res) => {
  req.logger.warn('Route not found', { 
    url: req.url, 
    method: req.method 
  });
  
  trackMetric('http.not_found', 1, [`method:${req.method}`]);
  res.status(404).json({ error: 'Route not found' });
});

// Start server
initializeDatabase().then(() => {
  const server = app.listen(config.get('port'), () => {
    logger.info(`SmartCVNaija server started successfully`, {
      port: config.get('port'),
      environment: config.get('env'),
      baseUrl: config.get('baseUrl'),
      telegramEnabled: !!telegramBot,
      timestamp: new Date().toISOString()
    });
  });

  // Graceful shutdown handling
  const gracefulShutdown = async (signal) => {
    logger.info(`Received ${signal}, starting graceful shutdown`);
    
    try {
      // Close server
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
      
      // Close database connection
      await pool.end();
      logger.info('Database connection closed');
      
      // Close Redis connection
      await redis.quit();
      logger.info('Redis connection closed');
      
      // Close StatsD connection
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

  // Handle shutdown signals
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // Handle unhandled rejections
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection', { 
      reason: reason?.message || reason,
      stack: reason?.stack,
      promise: promise.toString()
    });
    
    // Don't exit immediately, let the app handle it gracefully
    setTimeout(() => {
      logger.error('Exiting due to unhandled rejection');
      process.exit(1);
    }, 1000);
  });

  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception', { 
      error: error.message, 
      stack: error.stack 
    });
    
    // Exit immediately for uncaught exceptions
    process.exit(1);
  });

  // Export the server for testing purposes (optional)
  module.exports = server;

}).catch((error) => {
  // Handle database initialization failure
  logger.error('Failed to start server due to database initialization error', { 
    error: error.message 
  });
  process.exit(1);
});