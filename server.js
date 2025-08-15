// server.js - CORRECTED VERSION with proper database initialization

require('events').EventEmitter.defaultMaxListeners = 20;
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const fs = require('fs');
const config = require('./config');
const logger = require('./utils/logger');
const { statsd, trackMetric } = require('./utils/metrics');
const bot = require('./services/bot');
const ycloud = require('./services/ycloud');
const openaiWorker = require('./workers/openai');
const cvWorker = require('./workers/cv');
const redis = require('./config/redis');
const dbManager = require('./config/database'); // ✅ FIXED: Use dbManager consistently
const cvCleanup = require('./services/cv-cleanup');
const jobCleanup = require('./services/job-cleanup');

const app = express();

// Schedule cleanup services
cvCleanup.scheduleCleanup();

// Redis connection handlers
redis.on('error', (error) => {
  logger.error('Redis connection error', { error: error.message });
});

redis.on('connect', () => {
  logger.info('Redis connected successfully');
});

// Create Uploads directory
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
app.get('/health', async (req, res) => {
  try {
    // ✅ FIXED: Test database connection properly
    const dbHealthy = await dbManager.healthCheck();
    
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      services: {
        database: dbHealthy ? 'connected' : 'error',
        redis: 'connected',
        ycloud: 'active',
        workers: 'running'
      }
    });
  } catch (error) {
    req.logger.error('Health check failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      services: {
        database: 'error',
        redis: 'unknown',
        ycloud: 'unknown',
        workers: 'unknown'
      }
    });
  }
});

// API Health endpoint
app.get('/api/health', async (req, res) => {
  try {
    const dbHealthy = await dbManager.healthCheck();
    
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      services: {
        database: dbHealthy ? 'connected' : 'error',
        redis: 'connected',
        ycloud: 'active',
        workers: 'running'
      },
      version: '1.0.0',
      uptime: process.uptime()
    });
  } catch (error) {
    req.logger.error('API health check failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      timestamp: new Date().toISOString()
    });
  }
});

// Job statistics endpoint
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
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    
    // ✅ FIXED: Test database connection properly
    let dbStatus = 'connected';
    let dbResponseTime = 0;
    let activeConnections = 0;
    
    try {
      const start = Date.now();
      const isHealthy = await dbManager.healthCheck();
      dbResponseTime = Date.now() - start;
      
      if (isHealthy) {
        // Get active connections count
        const connResult = await dbManager.query(`
          SELECT count(*) as active_connections 
          FROM pg_stat_activity 
          WHERE state = 'active'
        `);
        activeConnections = parseInt(connResult.rows[0]?.active_connections || 0);
      } else {
        dbStatus = 'error';
      }
      
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
    
    const memoryUsagePercent = memUsage.heapTotal > 0 
      ? Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100) 
      : 0;
    
    const cpuUsagePercent = (cpuUsage.user && cpuUsage.system) 
      ? Math.min(Math.round(((cpuUsage.user + cpuUsage.system) / 1000000) * 100), 100)
      : 0;
    
    const os = require('os');
    const totalMemoryGB = (os.totalmem() / (1024 * 1024 * 1024)).toFixed(1);
    const usedMemoryGB = ((os.totalmem() - os.freemem()) / (1024 * 1024 * 1024)).toFixed(1);
    const cpuCores = os.cpus().length;
    
    res.json({
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
      memory: {
        usage_percent: memoryUsagePercent,
        heap_used_mb: Math.round(memUsage.heapUsed / 1024 / 1024),
        heap_total_mb: Math.round(memUsage.heapTotal / 1024 / 1024),
        rss_mb: Math.round(memUsage.rss / 1024 / 1024),
        system_total_gb: parseFloat(totalMemoryGB),
        system_used_gb: parseFloat(usedMemoryGB)
      },
      cpu: {
        usage_percent: cpuUsagePercent,
        cores: cpuCores,
        load_average: os.loadavg()[0].toFixed(2)
      },
      services: {
        database: {
          status: dbStatus,
          response_time_ms: dbResponseTime,
          active_connections: activeConnections
        },
        redis: {
          status: redisStatus,
          response_time_ms: redisResponseTime
        },
        ycloud: {
          status: 'active'
        }
      },
      environment: config.get('env'),
      version: '1.0.0',
      database: {
        active_connections: activeConnections,
        status: dbStatus
      },
      active_users: 0,
      queue_status: 'running'
    });
    
  } catch (error) {
    req.logger.error('Metrics endpoint error', { error: error.message });
    res.status(500).json({
      error: 'Failed to retrieve metrics',
      timestamp: new Date().toISOString(),
      memory: { usage_percent: 0, system_total_gb: 0, system_used_gb: 0 },
      cpu: { usage_percent: 0, cores: 1 },
      database: { active_connections: 0, status: 'error' },
      services: { database: { status: 'error' }, redis: { status: 'error' } }
    });
  }
});

// YCloud webhook endpoint
app.post('/webhook/ycloud', async (req, res) => {
  res.sendStatus(200);
  
  try {
    console.log('=== YCloud Webhook ===', JSON.stringify(req.body, null, 2));
    
    const { type, whatsappInboundMessage } = req.body;
    
    if (type !== 'whatsapp.inbound_message.received') {
      console.log('YCloud: Non-message event, skipping');
      return;
    }

    if (!whatsappInboundMessage) {
      console.log('YCloud: No inbound message found');
      return;
    }

    await processYCloudMessage(whatsappInboundMessage, req.logger);

  } catch (error) {
    req.logger.error('YCloud webhook error', { error: error.message });
  }
});

// Process YCloud messages
async function processYCloudMessage(message, logger) {
  try {
    const { from, type, id: messageId } = message;
    
    // Duplicate detection
    const duplicateKey = `msg:${messageId}`;
    const exists = await redis.exists(duplicateKey);
    if (exists) {
      logger.info('Duplicate YCloud message', { messageId });
      return;
    }
    
    await redis.set(duplicateKey, '1', 'EX', 3600);

    logger.info('Processing YCloud message', { type, from, messageId });

    switch (type) {
      case 'text':
        const messageText = message.text?.body;
        if (messageText) {
          await handleYCloudTextMessage(from, messageText);
        }
        break;
        
      case 'document':
        await handleYCloudDocumentMessage(message, logger);
        break;
        
      case 'image':
        await ycloud.sendTextMessage(from, 
          '📄 Please send your CV as a document (PDF/DOCX), not an image.'
        );
        break;
        
      default:
        await ycloud.sendTextMessage(from,
          'Hi! I help you find jobs in Nigeria. Send me a message or upload your CV.'
        );
    }

  } catch (error) {
    logger.error('YCloud message processing error', {
      messageId: message.id,
      error: error.message
    });
    
    try {
      await ycloud.sendTextMessage(message.from, 
        '❌ Sorry, something went wrong. Please try again.'
      );
    } catch (sendError) {
      logger.error('Failed to send error message', { sendError: sendError.message });
    }
  }
}

// Handle text messages
async function handleYCloudTextMessage(from, messageText) {
  console.log('YCloud text message:', { from, text: messageText });

  // Fast pattern matching first
  const fastResponse = await handleFastPatterns(from, messageText);
  if (fastResponse) {
    return;
  }

  // Send to bot for processing
  await bot.handleWhatsAppMessage(from, messageText);
}

// Handle document messages
async function handleYCloudDocumentMessage(message, logger) {
  const { from, document } = message;
  
  try {
    if (!document) {
      await ycloud.sendTextMessage(from, '❌ No document found in message.');
      return;
    }

    // Validate file type
    const allowedTypes = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword'
    ];
    
    if (!allowedTypes.includes(document.mime_type)) {
      await ycloud.sendTextMessage(from,
        `❌ Unsupported file type: ${document.mime_type}\n\n✅ Please send:\n• PDF files (.pdf)\n• Word documents (.docx)`
      );
      return;
    }

    await ycloud.sendTextMessage(from, '⏳ Downloading your CV...');

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

    // Send to bot
    await bot.handleWhatsAppMessage(from, null, {
      buffer: downloadResult.buffer,
      originalname: downloadResult.filename || 'document.pdf',
      mimetype: downloadResult.mimeType || document.mime_type,
      email: null,
      phone: from
    });

  } catch (error) {
    logger.error('YCloud document processing error', {
      from,
      error: error.message
    });

    await ycloud.sendTextMessage(from,
      '❌ Failed to process document. Please try again.'
    );
  }
}

// Fast local patterns
async function handleFastPatterns(phone, text) {
  const lower = text.toLowerCase().trim();
  
  if (lower === 'status') {
    const usage = await bot.checkDailyUsage(phone);
    const hasCV = await redis.exists(`cv:${phone}`);
    const hasCoverLetter = await redis.exists(`cover_letter:${phone}`);
    
    await ycloud.sendTextMessage(phone, 
      `📊 Your Status:\n\n• Applications today: ${usage.totalToday}/10\n• Remaining: ${usage.remaining}/10\n• CV uploaded: ${hasCV ? '✅' : '❌'}\n• Cover letter: ${hasCoverLetter ? '✅' : '❌'}\n\n${usage.needsPayment ? '💰 Payment required' : '✅ Ready to apply!'}`
    );
    return true;
  }

  if (lower === 'help' || lower === 'start') {
    await ycloud.sendTextMessage(phone,
      `🇳🇬 Welcome to SmartCVNaija!\n\n📋 What I can do:\n• Find jobs across Nigeria\n• Help you apply with one click\n• Only ₦500 for 10 applications daily\n\n💡 Try:\n• "find jobs in Lagos"\n• Upload your CV\n• "status" to check usage`
    );
    return true;
  }

  if (lower === 'reset') {
    await bot.handleResetCommand(phone);
    return true;
  }

  return false;
}

// Payment success page
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
      paymentStatus = isValid ? 'success' : 'failed';
      
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

// Paystack webhook
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

// Test endpoints
app.get('/test/ycloud/:phone', async (req, res) => {
  try {
    const phone = req.params.phone;
    const message = req.query.message || 'YCloud test message!';
    
    const success = await ycloud.sendTextMessage(phone, message);
    res.json({ success, phone, message });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/test/webhooks', (req, res) => {
  const ycloudKey = config.get('ycloud.apiKey');
  const paystackSecret = config.get('paystack.secret');
  
  res.json({
    status: 'ok',
    webhooks: {
      ycloud: {
        endpoint: '/webhook/ycloud',
        configured: !!(ycloudKey && ycloudKey.trim() !== '')
      },
      paystack: {
        endpoint: '/webhook/paystack',
        configured: !!(paystackSecret && paystackSecret.trim() !== '')
      }
    }
  });
});

// Error handling
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
  req.logger.warn('Route not found', { url: req.url, method: req.method });
  trackMetric('http.not_found', 1, [`method:${req.method}`]);
  res.status(404).json({ error: 'Route not found' });
});

// ✅ FIXED: Proper database initialization
async function initializeDatabase() {
  try {
    await dbManager.connect();
    logger.info('Database connection established');
    
    // Test the connection
    const isHealthy = await dbManager.healthCheck();
    if (!isHealthy) {
      throw new Error('Database health check failed');
    }
    
    logger.info('Database health check passed');
  } catch (error) {
    logger.error('Failed to initialize database', { error: error.message });
    process.exit(1);
  }
}

// ✅ FIXED: Start server with proper database initialization
initializeDatabase().then(() => {
  const server = app.listen(config.get('port'), () => {
    logger.info(`SmartCVNaija server started successfully`, {
      port: config.get('port'),
      environment: config.get('env'),
      baseUrl: config.get('baseUrl'),
      platform: 'WhatsApp (YCloud)',
      timestamp: new Date().toISOString()
    });
  });

  // Graceful shutdown
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
      
      if (openaiWorker && typeof openaiWorker.close === 'function') {
        await openaiWorker.close();
        logger.info('OpenAI worker closed');
      }
      
      if (cvWorker && typeof cvWorker.close === 'function') {
        await cvWorker.close();
        logger.info('CV worker closed');
      }
      
      await dbManager.close();
      logger.info('Database connection closed');
      
      await redis.quit();
      logger.info('Redis connection closed');
      
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

}).catch((error) => {
  logger.error('Failed to start server', { error: error.message });
  process.exit(1);
});

module.exports = app;