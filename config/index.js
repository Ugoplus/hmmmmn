// Clean config/index.js - No Telegram

const convict = require('convict');

const config = convict({
  env: { format: ['production', 'development'], default: 'development', env: 'NODE_ENV' },
  port: { format: 'port', default: 3000, env: 'PORT' },
  
  // Database configuration
  database: {
    host: { format: String, default: 'localhost', env: 'DB_HOST' },
    port: { format: 'port', default: 5432, env: 'DB_PORT' },
    name: { format: String, default: 'cv_job_matching', env: 'DB_NAME' },
    user: { format: String, default: 'postgres', env: 'DB_USER' },
    password: { format: String, default: '', env: 'DB_PASSWORD' },
    maxConnections: { format: Number, default: 100 },
    statementTimeout: { format: Number, default: 5000 }
  },
  
  // Redis configuration
  redis: {
    host: { format: String, default: 'localhost', env: 'REDIS_HOST' },
    port: { format: 'port', default: 6379, env: 'REDIS_PORT' },
    password: { format: String, default: '', env: 'REDIS_PASSWORD' }
  },

  // YCloud WhatsApp configuration
  ycloud: {
    apiKey: { format: String, default: '', env: 'YCLOUD_API_KEY' },
    baseUrl: { format: String, default: 'https://api.ycloud.com', env: 'YCLOUD_BASE_URL' },
    whatsappNumber: { format: String, default: '', env: 'YCLOUD_WHATSAPP_NUMBER' }
  },

  // AI configuration
  openai: { key: { format: String, default: '', env: 'OPENAI_API_KEY' } },
  
  // Payment configuration
  paystack: {
    secret: { format: String, default: '', env: 'PAYSTACK_SECRET_KEY' },
    public: { format: String, default: '', env: 'PAYSTACK_PUBLIC_KEY' },
    amount: { format: Number, default: 50000, env: 'PAYSTACK_AMOUNT' },
    webhookUrl: { format: String, default: 'http://localhost:3000/webhook/paystack', env: 'PAYSTACK_WEBHOOK_URL' }
  },
  
  // Server configuration
  baseUrl: { format: String, default: 'http://localhost:3000', env: 'BASE_URL' },
  
  // Email configuration
 smtp: {
    host: { format: String, default: 'smtp.zeptomail.com', env: 'SMTP_HOST' },
    port: { format: Number, default: 587, env: 'SMTP_PORT' },
    user: { format: String, default: 'emailapikey', env: 'SMTP_USER' },
    pass: { format: String, default: '', env: 'SMTP_PASS' }
  },
  
  // NEW: Separate confirmation email config
  confirmation: {
    smtp: {
      host: { format: String, default: 'smtp.zeptomail.com', env: 'CONFIRMATION_SMTP_HOST' },
      port: { format: Number, default: 587, env: 'CONFIRMATION_SMTP_PORT' },
      user: { format: String, default: 'emailapikey', env: 'CONFIRMATION_SMTP_USER' },
      pass: { format: String, default: '', env: 'CONFIRMATION_SMTP_PASS' }
    }
  }
});
config.validate({ allowed: 'strict' });
module.exports = config;