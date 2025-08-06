const convict = require('convict');

const config = convict({
  env: { format: ['production', 'development'], default: 'development', env: 'NODE_ENV' },
  port: { format: 'port', default: 3000, env: 'PORT' },
  database: {
    host: { format: String, default: 'localhost', env: 'DB_HOST' },
    port: { format: 'port', default: 5432, env: 'DB_PORT' },
    name: { format: String, default: 'cv_job_matching', env: 'DB_NAME' },
    user: { format: String, default: 'postgres', env: 'DB_USER' },
    password: { format: String, default: '', env: 'DB_PASSWORD' },
    maxConnections: { format: Number, default: 100 },
    statementTimeout: { format: Number, default: 5000 }
  },
  redis: {
    host: { format: String, default: 'localhost', env: 'REDIS_HOST' },
    port: { format: 'port', default: 6379, env: 'REDIS_PORT' },
    password: { format: String, default: '', env: 'REDIS_PASSWORD' }
  },
  openai: { key: { format: String, default: '', env: 'OPENAI_API_KEY' } },
  whatsapp: { token: { format: String, default: '', env: 'WHAPI_TOKEN' } },
  telegram: { token: { format: String, default: '', env: 'TELEGRAM_TOKEN' } },
  paystack: {
    secret: { format: String, default: '', env: 'PAYSTACK_SECRET_KEY' },
    public: { format: String, default: '', env: 'PAYSTACK_PUBLIC_KEY' },
    amount: { format: Number, default: 50000, env: 'PAYSTACK_AMOUNT' },
    webhookUrl: { format: String, default: 'http://localhost:3000/webhook/paystack', env: 'PAYSTACK_WEBHOOK_URL' }
  },
  baseUrl: { format: String, default: 'http://localhost:3000', env: 'BASE_URL' },
  SMTP_HOST: { format: String, default: 'smtp.gmail.com', env: 'SMTP_HOST' },
  SMTP_PORT: { format: Number, default: 587, env: 'SMTP_PORT' },
  SMTP_USER: { format: String, default: '', env: 'SMTP_USER' },
  SMTP_PASS: { format: String, default: '', env: 'SMTP_PASS' }
});

config.validate({ allowed: 'strict' });
module.exports = config;