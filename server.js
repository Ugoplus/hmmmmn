require('events').EventEmitter.defaultMaxListeners = 20;
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
const cvCleanup = require('./services/cv-cleanup');
cvCleanup.scheduleCleanup();

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

// FIXED /api/metrics endpoint in server.js
app.get('/api/metrics', async (req, res) => {
  try {
    // Get basic system metrics
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    
    // Test database connection with dbManager
    let dbStatus = 'connected';
    let dbResponseTime = 0;
    let activeConnections = 0;
    
    try {
      const start = Date.now();
      await dbManager.query('SELECT 1');
      dbResponseTime = Date.now() - start;
      
      // Get active connection count
      const connResult = await dbManager.query(`
        SELECT count(*) as active_connections 
        FROM pg_stat_activity 
        WHERE state = 'active'
      `);
      activeConnections = parseInt(connResult.rows[0]?.active_connections || 0);
      
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
    
    // Calculate memory usage safely
    const memoryUsagePercent = memUsage.heapTotal > 0 
      ? Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100) 
      : 0;
    
    // Calculate CPU usage safely
    const cpuUsagePercent = (cpuUsage.user && cpuUsage.system) 
      ? Math.min(Math.round(((cpuUsage.user + cpuUsage.system) / 1000000) * 100), 100)
      : 0;
    
    // Get system info
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
        telegram_bot: {
          status: telegramBot ? 'initialized' : 'not_configured'
        }
      },
      environment: config.get('env'),
      version: '1.0.0',
      // Add these for dashboard compatibility
      database: {
        active_connections: activeConnections,
        status: dbStatus
      },
      active_users: 0, // You can implement this later
      queue_status: 'running' // You can implement this later
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



// WhatsApp webhook
  app.post('/webhook/whatsapp', async (req, res) => {
  // Send 200 IMMEDIATELY to prevent WHAPI retries
  res.sendStatus(200);
  
  try {
    // console.log('=== WHAPI Webhook Received ===');
    // console.log('Body keys:', Object.keys(req.body || {}));
    
    // Check what type of webhook this is
    const { messages, statuses, event } = req.body;
    
    // Skip status updates (sent, delivered, read receipts)
    if (statuses && Array.isArray(statuses)) {
      // console.log('Skipping status update webhook');
      return; // These are just delivery confirmations, not actual messages
    }
    
    // Skip non-message events
    if (event && event.type !== 'messages' && event.type !== 'message') {
      // console.log(`Skipping ${event.type} event`);
      return;
    }
    
    // Process actual messages
    if (messages && Array.isArray(messages) && messages.length > 0) {
      console.log(`=== Processing ${messages.length} WhatsApp message(s) ===`);
      processWhatsAppMessages(messages, req.logger).catch(err => {
        console.error('Background processing error:', err);
      });
    } else if (req.body.message) {
      // Single message format
      console.log('=== Processing single WhatsApp message ===');
      processWhatsAppMessages([req.body.message], req.logger).catch(err => {
        console.error('Background processing error:', err);
      });
    }
    // If none of the above, it's probably a webhook we don't need to process
    
  } catch (error) {
    console.error('=== Webhook Error ===', error.message);
    req.logger.error('WhatsApp webhook error', { error: error.message });
  }
});

async function processWhatsAppMessages(messages, logger) {
  const BOT_PHONE_NUMBER = process.env.BOT_WHATSAPP_NUMBER || config.get('whatsapp.botNumber');
  
  for (const message of messages) {
    try {
      // Skip if no actual message content
      if (!message.from || !message.type) {
        console.log('Skipping invalid message structure');
        continue;
      }
      
      // Skip outgoing messages (from bot)
      if (message.from_me === true || 
          message.fromMe === true ||
          message.outgoing === true ||
          message.from === BOT_PHONE_NUMBER ||
          message.from === `${BOT_PHONE_NUMBER}@s.whatsapp.net`) {
        console.log('Skipping outgoing/bot message');
        continue;
      }
      
      // Only process incoming messages
      if (message.type === 'incoming' || !message.hasOwnProperty('outgoing')) {
        console.log(`Processing ${message.type} message from ${message.from}`);
        
        // Check for duplicate messages
        if (message.id) {
          const messageKey = `processed:${message.id}`;
          const alreadyProcessed = await redis.get(messageKey);
          
          if (alreadyProcessed) {
            console.log('Skipping duplicate message', { id: message.id });
            continue;
          }
          
          // Mark as processed
          await redis.set(messageKey, '1', 'EX', 3600);
        }
        
        // Process based on content type
        if (message.type === 'text' || message.type === 'chat' || message.type === 'incoming') {
          let messageText = message.body || message.text?.body || message.text || message.content;
          if (messageText) {
            console.log(`Text message: "${messageText.substring(0, 50)}..."`);
            await bot.handleWhatsAppMessage(message.from, messageText);
          }
        } else if (message.type === 'document') {
          console.log('Document received');
          await handleWhatsAppDocument(message, logger);
        } else if (message.type === 'image') {
          console.log('Image received - sending rejection');
          await bot.sendWhatsAppMessage(message.from, 
            '📄 Please send your CV as a document (PDF/DOCX), not an image.');
        }
      }
      
    } catch (messageError) {
      console.error('Message processing error:', messageError.message);
      logger.error('Error processing WhatsApp message', {
        error: messageError.message,
        messageId: message.id
      });
    }
  }
}




// ADD this new function after your webhook
  async function handleWhatsAppDocument(message, logger) {
  const axios = require('axios');
  
  console.log('=== Processing WhatsApp Document ===');
  console.log('Document object:', JSON.stringify(message.document, null, 2));
  
  if (!message.document) {
    await bot.sendWhatsAppMessage(message.from, 
      '❌ Invalid document. Please send a valid PDF or DOCX file.');
    return;
  }
  
  // Extract file information from WHAPI document object
  const {
    mime_type: mimeType,
    file_name: fileName,
    filename: altFileName,
    file_size: fileSize,
    id: mediaId,
    link: directLink
  } = message.document;
  
  // Use file_name or filename as fallback
  const finalFileName = fileName || altFileName || 'document';
  
  console.log('File details from WHAPI:');
  console.log('- MIME type:', mimeType);
  console.log('- File name:', finalFileName);
  console.log('- File size:', fileSize);
  console.log('- Media ID:', mediaId);
  console.log('- Direct link:', directLink ? 'Available' : 'Not available');
  
  // Validate file type
  const allowedTypes = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword'
  ];
  
  if (!mimeType || !allowedTypes.includes(mimeType)) {
    console.log('MIME type not allowed:', mimeType);
    await bot.sendWhatsAppMessage(message.from, 
      `❌ Unsupported file type: ${mimeType || 'unknown'}\n\n✅ Supported formats:\n• PDF files (.pdf)\n• Word documents (.docx, .doc)`);
    return;
  }

  // Validate file size
  if (fileSize && fileSize > 5 * 1024 * 1024) {
    await bot.sendWhatsAppMessage(message.from, 
      `❌ File too large: ${Math.round(fileSize / (1024 * 1024))}MB\n\nPlease send a file smaller than 5MB.`);
    return;
  }

  let fileBuffer;
  
  try {
    // METHOD 1: Use direct link if available (Auto Download enabled)
    if (directLink) {
      console.log('Using direct link method (Auto Download enabled)');
      console.log('Downloading from:', directLink);
      
      const response = await axios.get(directLink, {
        responseType: 'arraybuffer',
        timeout: 30000,
        maxContentLength: 5 * 1024 * 1024,
        headers: {
          'User-Agent': 'SmartCVNaija-Bot/1.0'
        }
      });
      
      fileBuffer = Buffer.from(response.data);
      console.log('✅ Downloaded via direct link, size:', fileBuffer.length);
      
    } 
    // METHOD 2: Use WHAPI Media API with Media ID
    else if (mediaId) {
      console.log('Using WHAPI Media API method');
      console.log('Media ID:', mediaId);
      
      const response = await axios.get(
        `https://gate.whapi.cloud/media/${mediaId}`,
        {
          headers: {
            'Authorization': `Bearer ${config.get('whatsapp.token')}`,
            'Accept': mimeType // Set correct Accept header
          },
          responseType: 'arraybuffer',
          timeout: 30000,
          maxContentLength: 5 * 1024 * 1024
        }
      );
      
      fileBuffer = Buffer.from(response.data);
      console.log('✅ Downloaded via Media API, size:', fileBuffer.length);
      
    } else {
      throw new Error('No download method available - neither direct link nor media ID found');
    }

    // Verify the downloaded file
    if (!fileBuffer || fileBuffer.length === 0) {
      throw new Error('Downloaded file is empty');
    }

    // Validate file size matches expected
    if (fileSize && Math.abs(fileBuffer.length - fileSize) > 1000) {
      console.warn('File size mismatch:', {
        expected: fileSize,
        actual: fileBuffer.length
      });
    }

    console.log('✅ File processing successful:', {
      filename: finalFileName,
      mimeType: mimeType,
      expectedSize: fileSize,
      actualSize: fileBuffer.length,
      downloadMethod: directLink ? 'direct_link' : 'media_api'
    });

    // Send to bot for CV processing
    await bot.handleWhatsAppMessage(message.from, null, {
      buffer: fileBuffer,
      originalname: finalFileName,
      mimetype: mimeType,
      email: message.from_email || null,
      phone: message.from
    });
    
  } catch (downloadError) {
    console.error('❌ File download failed:', downloadError.message);
    logger.error('WHAPI file download error', { 
      error: downloadError.message,
      mediaId: mediaId,
      directLink: !!directLink,
      fileName: finalFileName,
      mimeType: mimeType
    });
    
    // Send helpful error message to user
    let errorMessage = '❌ Failed to download your CV. ';
    
    if (downloadError.message.includes('timeout')) {
      errorMessage += 'The download timed out. Please try a smaller file.';
    } else if (downloadError.message.includes('401') || downloadError.message.includes('403')) {
      errorMessage += 'Access denied. Please contact support.';
    } else if (downloadError.message.includes('404')) {
      errorMessage += 'File not found. Please upload again.';
    } else {
      errorMessage += 'Please try uploading again.';
    }
    
    await bot.sendWhatsAppMessage(message.from, errorMessage);
  }
}
 

async function debugWhapiWebhook(req, res) {
  console.log('=== WHAPI Webhook Debug ===');
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Body:', JSON.stringify(req.body, null, 2));
  
  if (req.body.messages && req.body.messages.length > 0) {
    req.body.messages.forEach((msg, index) => {
      console.log(`Message ${index + 1}:`, {
        type: msg.type,
        from: msg.from,
        hasDocument: !!msg.document,
        documentId: msg.document?.id,
        documentLink: msg.document?.link,
        mimeType: msg.document?.mime_type,
        fileName: msg.document?.file_name || msg.document?.filename
      });
    });
  }
  
  res.sendStatus(200);
}





// Add this route BEFORE the webhook routes
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
            .container { max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
            .error { color: #e74c3c; font-size: 18px; margin: 20px 0; }
            .btn { background: #3498db; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block; margin-top: 20px; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>⚠️ Payment Error</h1>
            <p class="error">Invalid payment reference</p>
            <p>Please contact support if you completed a payment.</p>
            <a href="https://smartcvnaija.com.ng" class="btn">Go to SmartCVNaija</a>
          </div>
        </body>
        </html>
      `);
    }

    // Verify payment with Paystack
    let paymentStatus = 'pending';
    let amount = 0;
    
    try {
      const paystackService = require('./services/paystack');
      const isValid = await paystackService.verifyPayment(paymentRef);
      paymentStatus = isValid ? 'success' : 'failed';
      
      // Get payment details
      const response = await axios.get(
        `https://api.paystack.co/transaction/verify/${paymentRef}`,
        {
          headers: {
            Authorization: `Bearer ${config.get('paystack.secret')}`
          }
        }
      );
      
      if (response.data.data.status === 'success') {
        amount = response.data.data.amount / 100; // Convert from kobo
        paymentStatus = 'success';
      }
    } catch (error) {
      req.logger.error('Payment verification error', { paymentRef, error: error.message });
    }

    // Return appropriate success/failure page
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
            .container { max-width: 600px; margin: 0 auto; background: white; color: #333; padding: 40px; border-radius: 15px; box-shadow: 0 10px 25px rgba(0,0,0,0.2); }
            .success { color: #27ae60; font-size: 24px; margin: 20px 0; }
            .amount { background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0; font-size: 18px; }
            .btn { background: #27ae60; color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; display: inline-block; margin: 10px; font-weight: bold; }
            .btn-secondary { background: #3498db; }
            .instructions { background: #e8f5e8; border: 1px solid #27ae60; padding: 20px; border-radius: 8px; margin: 20px 0; text-align: left; }
            .whatsapp { background: #25d366; }
            .telegram { background: #0088cc; }
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
            
            <div class="instructions">
              <h3>✅ What's Next?</h3>
              <ol>
                <li><strong>You now have 10 job applications for today!</strong></li>
                <li>Return to WhatsApp or Telegram to continue</li>
                <li>Upload your CV if you haven't already</li>
                <li>Search for jobs and start applying</li>
              </ol>
            </div>
            
            <p><strong>Continue your job search:</strong></p>
            <a href="https://wa.me/your-whatsapp-number" class="btn whatsapp">📱 Continue on WhatsApp</a>
            <a href="https://t.me/your-telegram-bot" class="btn telegram">💬 Continue on Telegram</a>
            
            <hr style="margin: 30px 0;">
            <p><small>Thank you for using SmartCVNaija! 🇳🇬</small></p>
            <p><small>Need help? Contact: <a href="mailto:support@smartcvnaija.com.ng">support@smartcvnaija.com.ng</a></small></p>
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
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
            .container { max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
            .error { color: #e74c3c; font-size: 18px; margin: 20px 0; }
            .btn { background: #3498db; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block; margin: 10px; }
            .btn-retry { background: #e74c3c; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>❌ Payment Failed</h1>
            <p class="error">Your payment could not be processed</p>
            <p>Reference: <code>${paymentRef}</code></p>
            
            <p><strong>What to do:</strong></p>
            <ul style="text-align: left;">
              <li>Check if payment was deducted from your account</li>
              <li>If deducted, contact support with reference number</li>
              <li>If not deducted, try payment again</li>
            </ul>
            
            <a href="https://wa.me/your-whatsapp-number" class="btn">📱 Contact Support on WhatsApp</a>
            <a href="mailto:support@smartcvnaija.com.ng" class="btn btn-retry">📧 Email Support</a>
          </div>
        </body>
        </html>
      `);
    }

  } catch (error) {
    req.logger.error('Payment success page error', { error: error.message });
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Error - SmartCVNaija</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
          .container { max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>⚠️ System Error</h1>
          <p>Unable to verify payment status. Please contact support.</p>
          <a href="mailto:support@smartcvnaija.com.ng" style="background: #3498db; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px;">Contact Support</a>
        </div>
      </body>
      </html>
    `);
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

// Telegram webhook endpoint - FIXED
app.post('/webhook/telegram', async (req, res) => {
  try {
    console.log('=== TELEGRAM Webhook Received ===', JSON.stringify(req.body, null, 2));
    
    const telegramToken = config.get('telegram.token');
    
    if (!telegramToken || telegramToken.trim() === '' || telegramToken === 'your-telegram-token') {
      req.logger.warn('Telegram webhook received but not configured');
      return res.status(503).json({ 
        error: 'Telegram not configured',
        message: 'Please configure TELEGRAM_TOKEN in environment variables'
      });
    }

    if (!telegramBot) {
      req.logger.warn('Telegram webhook received but bot not initialized');
      return res.status(503).json({ 
        error: 'Telegram bot not initialized',
        message: 'Telegram bot failed to initialize - check token validity'
      });
    }

    // Process the update MANUALLY (not using event handlers)
    const update = req.body;
    
    if (update.message) {
      const msg = update.message;
      const chatId = msg.chat.id;
      
      try {
        if (msg.document) {
          // Handle document upload
          const file = await telegramBot.getFile(msg.document.file_id);
          const fileStream = telegramBot.getFileStream(file.file_id);
          
          // Convert stream to buffer
          const chunks = [];
          for await (const chunk of fileStream) {
            chunks.push(chunk);
          }
          const fileBuffer = Buffer.concat(chunks);
          
          if (fileBuffer.length > 5 * 1024 * 1024) {
            await bot.sendTelegramMessage(chatId, 'File is too large. Please upload a CV smaller than 5MB.');
            return res.sendStatus(200);
          }
          
          await bot.handleTelegramMessage(chatId, null, {
            buffer: fileBuffer,
            originalname: msg.document.file_name,
            mimetype: msg.document.mime_type,
            email: msg.from.email || null,
            chatId: chatId
          });
          
        } else if (msg.text) {
          // Handle text message
          await bot.handleTelegramMessage(chatId, msg.text);
          
        } else {
          // Handle other message types
          await bot.sendTelegramMessage(chatId, 'I can only process text messages and document files (PDF/DOCX).');
        }
        
      } catch (messageError) {
        req.logger.error('Telegram message processing error', { 
          chatId: chatId, 
          error: messageError.message 
        });
        
        try {
          await bot.sendTelegramMessage(chatId, 'An error occurred while processing your message. Please try again.');
        } catch (sendError) {
          req.logger.error('Failed to send Telegram error message', { sendError: sendError.message });
        }
      }
    }
    
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
