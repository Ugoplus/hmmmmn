// routes/webhook.js - Unified Payment Handler for Both Flows

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bot = require('../services/bot');
const autoApplyPayment = require('../services/autoApplyPayment');
const dbManager = require('../config/database');
const logger = require('../utils/logger');

/**
 * Paystack Webhook Handler
 * Routes payments to correct flow based on reference prefix
 */
router.post('/paystack', async (req, res) => {
  try {
    // Verify Paystack signature
    const hash = crypto
      .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
      .update(JSON.stringify(req.body))
      .digest('hex');

    if (hash !== req.headers['x-paystack-signature']) {
      logger.warn('Invalid Paystack signature');
      return res.status(400).send('Invalid signature');
    }

    const { event, data } = req.body;

    // Only process successful payments
    if (event !== 'charge.success') {
      logger.info('Ignoring non-success event', { event });
      return res.sendStatus(200);
    }

    const { reference, amount, customer } = data;

    logger.info('Payment webhook received', {
      reference,
      amount: amount / 100,
      email: customer.email
    });

    // Route based on reference prefix
    if (reference.startsWith('auto_')) {
      await handleAutoApplyPayment(reference, data);
    } else if (reference.startsWith('quick_')) {
      await handleQuickApplyPayment(reference, data);
    } else {
      // Fallback for legacy references
      logger.warn('Unknown payment reference format', { reference });
    }

    res.sendStatus(200);

  } catch (error) {
    logger.error('Webhook processing failed', {
      error: error.message,
      stack: error.stack
    });
    res.sendStatus(500);
  }
});

/**
 * Handle Auto-Apply Payment (₦1k or ₦2.5k)
 */
async function handleAutoApplyPayment(reference, paymentData) {
  try {
    logger.info('Processing auto-apply payment', { reference });

    // Extract phone from reference
    // Format: auto_basic_uuid_2348012345678 or auto_unlimited_uuid_2348012345678
    const parts = reference.split('_');
    const tier = parts[1]; // 'basic' or 'unlimited'
    const phone = `+${parts[parts.length - 1]}`;

    // Process payment through auto-apply service
    const result = await autoApplyPayment.processPayment(reference);

    if (!result.success) {
      throw new Error('Auto-apply payment processing failed');
    }

    // Send WhatsApp confirmation
    await bot.handleAutoApplyPaymentSuccess(phone, reference);

    logger.info('Auto-apply payment processed successfully', {
      phone: phone.substring(0, 6) + '***',
      tier,
      reference
    });

  } catch (error) {
    logger.error('Auto-apply payment handling failed', {
      reference,
      error: error.message
    });
    
    // Send error notification to admin
    await sendAdminNotification('Auto-Apply Payment Failed', {
      reference,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
}

/**
 * Handle Quick Apply Payment (₦300)
 */
async function handleQuickApplyPayment(reference, paymentData) {
  try {
    logger.info('Processing quick apply payment', { reference });

    // Extract phone from reference
    // Format: quick_uuid_2348012345678
    const parts = reference.split('_');
    const phone = `+${parts[parts.length - 1]}`;

    // Update daily_usage table
    const result = await dbManager.query(`
      UPDATE daily_usage 
      SET 
        applications_remaining = 3,
        payment_status = 'completed',
        valid_until = NOW() + INTERVAL '24 hours',
        updated_at = NOW()
      WHERE payment_reference = $1
      RETURNING *
    `, [reference]);

    if (result.rows.length === 0) {
      // Create record if doesn't exist
      await dbManager.query(`
        INSERT INTO daily_usage (
          user_identifier, payment_reference, payment_status,
          applications_remaining, valid_until, updated_at
        ) VALUES ($1, $2, 'completed', 3, NOW() + INTERVAL '24 hours', NOW())
      `, [phone, reference]);
    }

    // Send WhatsApp confirmation
    await bot.handleQuickApplyPaymentSuccess(phone, reference);

    logger.info('Quick apply payment processed successfully', {
      phone: phone.substring(0, 6) + '***',
      reference
    });

  } catch (error) {
    logger.error('Quick apply payment handling failed', {
      reference,
      error: error.message
    });
    
    // Send error notification to admin
    await sendAdminNotification('Quick Apply Payment Failed', {
      reference,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
}

/**
 * Send admin notification for payment failures
 */
async function sendAdminNotification(subject, details) {
  try {
    const nodemailer = require('nodemailer');
    const config = require('../config');

    const transporter = nodemailer.createTransport({
      host: config.get('smtp.host'),
      port: config.get('smtp.port'),
      secure: false,
      auth: {
        user: config.get('smtp.user'),
        pass: config.get('smtp.pass')
      }
    });

    await transporter.sendMail({
      from: '"SmartCV System" <noreply@smartcvnaija.com.ng>',
      to: process.env.ADMIN_EMAIL || 'admin@smartcvnaija.com.ng',
      subject: `🚨 ${subject}`,
      html: `
        <h2>Payment Processing Error</h2>
        <pre>${JSON.stringify(details, null, 2)}</pre>
      `
    });

    logger.info('Admin notification sent', { subject });

  } catch (error) {
    logger.error('Failed to send admin notification', {
      error: error.message
    });
  }
}

/**
 * Test endpoint (development only)
 */
if (process.env.NODE_ENV === 'development') {
  router.post('/paystack/test', async (req, res) => {
    try {
      const { reference } = req.body;

      logger.info('Test webhook triggered', { reference });

      if (reference.startsWith('auto_')) {
        await handleAutoApplyPayment(reference, { 
          amount: 100000, 
          customer: { email: 'test@test.com' } 
        });
      } else if (reference.startsWith('quick_')) {
        await handleQuickApplyPayment(reference, { 
          amount: 30000, 
          customer: { email: 'test@test.com' } 
        });
      }

      res.json({ success: true, message: 'Test webhook processed' });

    } catch (error) {
      logger.error('Test webhook failed', { error: error.message });
      res.status(500).json({ success: false, error: error.message });
    }
  });
}

/**
 * Payment verification endpoint (for manual checks)
 */
router.get('/verify/:reference', async (req, res) => {
  try {
    const { reference } = req.params;
    
    // Verify with Paystack
    const paystackService = require('../services/paystack');
    const verification = await paystackService.verifyPayment(reference);

    if (!verification.success) {
      return res.status(400).json({ 
        success: false, 
        message: 'Payment not found or failed' 
      });
    }

    // Process based on type
    if (reference.startsWith('auto_')) {
      await handleAutoApplyPayment(reference, verification.data);
    } else if (reference.startsWith('quick_')) {
      await handleQuickApplyPayment(reference, verification.data);
    }

    res.json({ 
      success: true, 
      message: 'Payment verified and processed',
      data: verification.data
    });

  } catch (error) {
    logger.error('Payment verification failed', {
      reference: req.params.reference,
      error: error.message
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;