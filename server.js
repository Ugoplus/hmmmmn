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
const RateLimiter = require('./utils/rateLimiter');
const rateLimit = require('express-rate-limit');
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

// Webhook rate limiting
const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,  // 1 minute
  max: 2000,                // High limit for YCloud webhooks
  message: {
    error: 'Webhook rate limit exceeded',
    retryAfter: '1 minute'
  },
  keyGenerator: (req) => req.ip
});

app.use('/webhook/', webhookLimiter);



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
    
// Add these endpoints to your server.js (before error handlers)

// ================================
// INSTANT RESPONSE MONITORING ENDPOINTS
// ================================

// Queue statistics
app.get('/api/queue/stats', async (req, res) => {
  try {
    const { Queue } = require('bullmq');
    const { queueRedis } = require('./config/redis');
    
    const cvQueue = new Queue('cv-processing', { connection: queueRedis });
    const applicationQueue = new Queue('job-applications', { connection: queueRedis });
    
    const [cvWaiting, cvActive, cvCompleted, cvFailed] = await Promise.all([
      cvQueue.getWaiting(),
      cvQueue.getActive(),
      cvQueue.getCompleted(),
      cvQueue.getFailed()
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
        waiting: cvWaiting.length,
        active: cvActive.length,
        completed: cvCompleted.length,
        failed: cvFailed.length,
        activeJobs: cvActive.map(job => ({
          id: job.id,
          progress: job.progress || 0,
          user: job.data?.identifier ? job.data.identifier.substring(0, 6) + '***' : 'unknown',
          jobCount: job.data?.jobs?.length || 0
        }))
      },
      applications: {
        waiting: appWaiting.length,
        active: appActive.length,
        completed: appCompleted.length,
        failed: appFailed.length,
        activeJobs: appActive.map(job => ({
          id: job.id,
          progress: job.progress || 0,
          user: job.data?.identifier ? job.data.identifier.substring(0, 6) + '***' : 'unknown',
          jobTitle: job.data?.job?.title || 'Unknown Job',
          company: job.data?.job?.company || 'Unknown Company'
        }))
      }
    });

  } catch (error) {
    req.logger.error('Queue stats failed', { error: error.message });
    res.status(500).json({ error: 'Failed to get queue statistics' });
  }
});

// User application status
app.get('/api/user/:phone/status', async (req, res) => {
  try {
    const phone = req.params.phone;
    
    // Get user's daily usage
    const usage = await bot.checkDailyUsage(phone);
    
    // Check if user has selected jobs
    const selectedJobs = await redis.get(`selected_jobs:${phone}`);
    let selectedJobsData = null;
    if (selectedJobs) {
      try {
        selectedJobsData = JSON.parse(selectedJobs);
      } catch (e) {
        // Ignore parse errors
      }
    }
    
    // Check recent applications
    const recentApps = await dbManager.query(`
      SELECT a.*, j.title, j.company 
      FROM applications a 
      JOIN jobs j ON a.job_id = j.id 
      WHERE a.user_identifier = $1 
      ORDER BY a.applied_at DESC 
      LIMIT 5
    `, [phone]);

    res.json({
      phone: phone.substring(0, 6) + '***',
      usage: {
        remaining: usage.remaining,
        totalToday: usage.totalToday,
        needsPayment: usage.needsPayment,
        paymentStatus: usage.paymentStatus
      },
      selectedJobs: selectedJobsData ? {
        count: selectedJobsData.length,
        jobs: selectedJobsData.slice(0, 3).map(job => ({
          title: job.title,
          company: job.company,
          location: job.location
        }))
      } : null,
      recentApplications: recentApps.rows.map(app => ({
        id: app.id,
        jobTitle: app.title,
        company: app.company,
        status: app.status,
        appliedAt: app.applied_at,
        cvScore: app.cv_score
      })),
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    req.logger.error('User status check failed', { error: error.message });
    res.status(500).json({ error: 'Failed to get user status' });
  }
});

// Today's statistics endpoint
app.get('/api/stats/today', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    // Get today's applications
    const applicationsResult = await dbManager.query(`
      SELECT COUNT(*) as total, 
             COUNT(CASE WHEN status = 'applied' THEN 1 END) as successful,
             COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed
      FROM applications 
      WHERE DATE(applied_at) = $1
    `, [today]);
    
    // Get new users today (users who applied for first time)
    const newUsersResult = await dbManager.query(`
      SELECT COUNT(DISTINCT user_identifier) as count
      FROM applications 
      WHERE DATE(applied_at) = $1 
      AND user_identifier NOT IN (
        SELECT DISTINCT user_identifier 
        FROM applications 
        WHERE DATE(applied_at) < $1
      )
    `, [today]);
    
    // Get CV processing stats
    const cvProcessingResult = await dbManager.query(`
      SELECT COUNT(*) as total,
             AVG(cv_score) as avg_score
      FROM applications 
      WHERE DATE(applied_at) = $1 
      AND cv_score IS NOT NULL
    `, [today]);

    const applications = applicationsResult.rows[0];
    const successRate = applications.total > 0 ? 
      Math.round((applications.successful / applications.total) * 100) : 0;

    res.json({
      date: today,
      applications: {
        total: parseInt(applications.total),
        successful: parseInt(applications.successful),
        failed: parseInt(applications.failed),
        successRate: successRate
      },
      newUsers: parseInt(newUsersResult.rows[0].count),
      cvProcessing: {
        total: parseInt(cvProcessingResult.rows[0].total),
        averageScore: cvProcessingResult.rows[0].avg_score ? 
          Math.round(cvProcessingResult.rows[0].avg_score * 100) / 100 : 0
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    req.logger.error('Today stats failed', { error: error.message });
    res.status(500).json({ error: 'Failed to get today statistics' });
  }
});

// System performance metrics
app.get('/api/system/performance', async (req, res) => {
  try {
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    
    // Test database
    let dbHealthy = false;
    let dbResponseTime = 0;
    try {
      const start = Date.now();
      await dbManager.healthCheck();
      dbResponseTime = Date.now() - start;
      dbHealthy = true;
    } catch (dbError) {
      req.logger.error('DB health check failed', { error: dbError.message });
    }
    
    // Test Redis
    let redisHealthy = false;
    let redisResponseTime = 0;
    try {
      const start = Date.now();
      await redis.ping();
      redisResponseTime = Date.now() - start;
      redisHealthy = true;
    } catch (redisError) {
      req.logger.error('Redis health check failed', { error: redisError.message });
    }
    
    // Get active users (approximate)
    const activeUsers = await redis.keys('selected_jobs:*');
    
    res.json({
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
      memory: {
        usage_percent: Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100),
        heap_used_mb: Math.round(memUsage.heapUsed / 1024 / 1024),
        heap_total_mb: Math.round(memUsage.heapTotal / 1024 / 1024),
        rss_mb: Math.round(memUsage.rss / 1024 / 1024)
      },
      services: {
        database: {
          healthy: dbHealthy,
          response_time_ms: dbResponseTime
        },
        redis: {
          healthy: redisHealthy,
          response_time_ms: redisResponseTime
        }
      },
      activity: {
        active_users: activeUsers.length,
        concurrent_cv_processing: 12, // Your concurrency setting
        estimated_capacity: '720 CVs/hour'
      }
    });

  } catch (error) {
    req.logger.error('Performance metrics failed', { error: error.message });
    res.status(500).json({ error: 'Failed to get performance metrics' });
  }
});

// Admin dashboard
app.get('/admin/dashboard', (req, res) => {
  const authToken = req.query.token;
  const expectedToken = process.env.ADMIN_TOKEN || 'admin123';
  
  if (authToken !== expectedToken) {
    return res.status(401).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Admin Access Required</title>
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
          .form { max-width: 400px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; }
          input { width: 100%; padding: 12px; margin: 10px 0; border: 1px solid #ddd; border-radius: 5px; }
          button { width: 100%; padding: 12px; background: #3498db; color: white; border: none; border-radius: 5px; cursor: pointer; }
          button:hover { background: #2980b9; }
        </style>
      </head>
      <body>
        <div class="form">
          <h2>🔐 SmartCV Admin Access</h2>
          <form method="GET">
            <input type="password" name="token" placeholder="Enter admin token" required>
            <button type="submit">Access Dashboard</button>
          </form>
        </div>
      </body>
      </html>
    `);
  }

  // Serve admin dashboard
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>SmartCV Admin Dashboard</title>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh; padding: 20px; color: #333;
        }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { text-align: center; color: white; margin-bottom: 30px; }
        .header h1 { font-size: 2.5rem; margin-bottom: 10px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-bottom: 30px; }
        .card { 
          background: white; border-radius: 15px; padding: 25px; 
          box-shadow: 0 10px 30px rgba(0,0,0,0.1); transition: transform 0.3s ease;
        }
        .card:hover { transform: translateY(-5px); }
        .card h3 { margin-bottom: 15px; color: #2c3e50; border-bottom: 2px solid #ecf0f1; padding-bottom: 10px; }
        .metric { display: flex; justify-content: space-between; margin: 10px 0; }
        .metric-value { font-weight: bold; color: #3498db; }
        .status-good { color: #27ae60; }
        .status-warning { color: #f39c12; }
        .status-error { color: #e74c3c; }
        .refresh-btn { 
          background: #3498db; color: white; border: none; padding: 10px 20px; 
          border-radius: 8px; cursor: pointer; margin: 20px 0;
        }
        .refresh-btn:hover { background: #2980b9; }
        .auto-refresh { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; }
        .timestamp { color: #95a5a6; font-size: 0.9em; }
        .active-job { 
          background: #f8f9fa; padding: 10px; margin: 5px 0; border-radius: 5px;
          border-left: 4px solid #3498db;
        }
        .progress-bar {
          width: 100%; height: 6px; background: #ecf0f1; border-radius: 3px; overflow: hidden;
        }
        .progress-fill {
          height: 100%; background: #3498db; transition: width 0.3s ease;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>🚀 SmartCV Admin Dashboard</h1>
          <p>Instant Response System Monitor</p>
        </div>

        <div class="auto-refresh">
          <label><input type="checkbox" id="autoRefresh" checked> Auto-refresh (10s)</label>
          <button class="refresh-btn" onclick="refreshData()">🔄 Refresh Now</button>
          <span class="timestamp" id="lastUpdate">Loading...</span>
        </div>

        <div class="grid">
          <div class="card">
            <h3>📊 Queue Statistics</h3>
            <div id="queueStats">Loading...</div>
          </div>
          
          <div class="card">
            <h3>🖥️ System Performance</h3>
            <div id="systemPerf">Loading...</div>
          </div>
          
          <div class="card">
            <h3>👥 User Activity</h3>
            <div id="userActivity">Loading...</div>
          </div>
          
          <div class="card">
            <h3>📈 Today's Statistics</h3>
            <div id="todayStats">Loading...</div>
          </div>
        </div>

        <div class="card">
          <h3>🔄 Active Processing</h3>
          <div id="activeProcessing">Loading...</div>
        </div>
      </div>

      <script>
        let autoRefreshInterval;

        document.addEventListener('DOMContentLoaded', function() {
          refreshData();
          setupAutoRefresh();
        });

        function setupAutoRefresh() {
          const checkbox = document.getElementById('autoRefresh');
          
          function toggleAutoRefresh() {
            if (checkbox.checked) {
              autoRefreshInterval = setInterval(refreshData, 10000);
            } else {
              clearInterval(autoRefreshInterval);
            }
          }
          
          checkbox.addEventListener('change', toggleAutoRefresh);
          toggleAutoRefresh();
        }

        async function refreshData() {
          document.getElementById('lastUpdate').textContent = 
            \`Last updated: \${new Date().toLocaleTimeString()}\`;

          try {
            // Fetch queue stats
            const queueResponse = await fetch('/api/queue/stats');
            const queueData = await queueResponse.json();
            updateQueueStats(queueData);
            updateActiveProcessing(queueData);

            // Fetch system performance
            const perfResponse = await fetch('/api/system/performance');
            const perfData = await perfResponse.json();
            updateSystemPerf(perfData);
            updateUserActivity(perfData);

            // Fetch today's stats
            const todayResponse = await fetch('/api/stats/today');
            const todayData = await todayResponse.json();
            updateTodayStats(todayData);

          } catch (error) {
            console.error('Failed to refresh data:', error);
            document.getElementById('lastUpdate').textContent = 
              \`Error: \${error.message}\`;
          }
        }

        function updateQueueStats(data) {
          const container = document.getElementById('queueStats');
          container.innerHTML = \`
            <div class="metric">
              <span>CV Processing:</span>
              <span class="metric-value">\${data.cvProcessing.active}/12 active, \${data.cvProcessing.waiting} waiting</span>
            </div>
            <div class="metric">
              <span>Applications:</span>
              <span class="metric-value">\${data.applications.active} active, \${data.applications.waiting} waiting</span>
            </div>
            <div class="metric">
              <span>CV Completed:</span>
              <span class="metric-value status-good">\${data.cvProcessing.completed}</span>
            </div>
            <div class="metric">
              <span>CV Failed:</span>
              <span class="metric-value \${data.cvProcessing.failed > 0 ? 'status-error' : 'status-good'}">\${data.cvProcessing.failed}</span>
            </div>
            <div class="metric">
              <span>App Completed:</span>
              <span class="metric-value status-good">\${data.applications.completed}</span>
            </div>
            <div class="metric">
              <span>App Failed:</span>
              <span class="metric-value \${data.applications.failed > 0 ? 'status-error' : 'status-good'}">\${data.applications.failed}</span>
            </div>
          \`;
        }

        function updateSystemPerf(data) {
          const container = document.getElementById('systemPerf');
          const memoryStatus = data.memory.usage_percent > 80 ? 'status-error' : 
                              data.memory.usage_percent > 60 ? 'status-warning' : 'status-good';
          
          container.innerHTML = \`
            <div class="metric">
              <span>Memory Usage:</span>
              <span class="metric-value \${memoryStatus}">\${data.memory.usage_percent}% (\${data.memory.heap_used_mb}MB)</span>
            </div>
            <div class="metric">
              <span>Uptime:</span>
              <span class="metric-value">\${Math.floor(data.uptime / 3600)}h \${Math.floor((data.uptime % 3600) / 60)}m</span>
            </div>
            <div class="metric">
              <span>Database:</span>
              <span class="metric-value \${data.services.database.healthy ? 'status-good' : 'status-error'}">
                \${data.services.database.healthy ? '✅ Healthy' : '❌ Error'} (\${data.services.database.response_time_ms}ms)
              </span>
            </div>
            <div class="metric">
              <span>Redis:</span>
              <span class="metric-value \${data.services.redis.healthy ? 'status-good' : 'status-error'}">
                \${data.services.redis.healthy ? '✅ Healthy' : '❌ Error'} (\${data.services.redis.response_time_ms}ms)
              </span>
            </div>
          \`;
        }

        function updateUserActivity(data) {
          const container = document.getElementById('userActivity');
          container.innerHTML = \`
            <div class="metric">
              <span>Active Users:</span>
              <span class="metric-value">\${data.activity.active_users}</span>
            </div>
            <div class="metric">
              <span>CV Capacity:</span>
              <span class="metric-value">\${data.activity.estimated_capacity}</span>
            </div>
            <div class="metric">
              <span>Processing Slots:</span>
              <span class="metric-value">\${data.activity.concurrent_cv_processing} concurrent</span>
            </div>
          \`;
        }

        function updateTodayStats(data) {
          const container = document.getElementById('todayStats');
          container.innerHTML = \`
            <div class="metric">
              <span>Applications Today:</span>
              <span class="metric-value">\${data.applications.total}</span>
            </div>
            <div class="metric">
              <span>Success Rate:</span>
              <span class="metric-value \${data.applications.successRate > 80 ? 'status-good' : data.applications.successRate > 60 ? 'status-warning' : 'status-error'}">\${data.applications.successRate}%</span>
            </div>
            <div class="metric">
              <span>New Users:</span>
              <span class="metric-value">\${data.newUsers}</span>
            </div>
            <div class="metric">
              <span>Avg CV Score:</span>
              <span class="metric-value">\${data.cvProcessing.averageScore}/100</span>
            </div>
          \`;
        }

        function updateActiveProcessing(data) {
          const container = document.getElementById('activeProcessing');
          const allActiveJobs = [
            ...(data.cvProcessing.activeJobs || []).map(job => ({...job, type: 'CV Processing'})),
            ...(data.applications.activeJobs || []).map(job => ({...job, type: 'Job Application'}))
          ];

          if (allActiveJobs.length === 0) {
            container.innerHTML = '<p style="color: #95a5a6; text-align: center;">No active processing jobs</p>';
            return;
          }

          container.innerHTML = allActiveJobs.map(job => \`
            <div class="active-job">
              <div style="display: flex; justify-content: space-between; margin-bottom: 5px;">
                <span><strong>\${job.type}</strong> - User: \${job.user}</span>
                <span>\${job.progress}% complete</span>
              </div>
              \${job.jobTitle ? \`<div style="font-size: 0.9em; color: #666;">\${job.jobTitle} at \${job.company}</div>\` : ''}
              \${job.jobCount ? \`<div style="font-size: 0.9em; color: #666;">Processing \${job.jobCount} jobs</div>\` : ''}
              <div class="progress-bar">
                <div class="progress-fill" style="width: \${job.progress}%"></div>
              </div>
            </div>
          \`).join('');
        }
      </script>
    </body>
    </html>
  `);
});

// Health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    // Quick health checks
    const checks = {
      server: true,
      timestamp: new Date().toISOString()
    };

    // Test database connection
    try {
      await dbManager.query('SELECT 1');
      checks.database = true;
    } catch (err) {
      checks.database = false;
      checks.databaseError = err.message;
    }

    // Test Redis connection
    try {
      await redis.ping();
      checks.redis = true;
    } catch (err) {
      checks.redis = false;
      checks.redisError = err.message;
    }

    const isHealthy = checks.database && checks.redis;
    res.status(isHealthy ? 200 : 503).json({
      status: isHealthy ? 'healthy' : 'unhealthy',
      checks
    });

  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
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

    const userPhone = whatsappInboundMessage.from;
    
    // NEW: Check user message rate limit
    const messageLimit = await RateLimiter.checkLimit(userPhone, 'message');
    
    if (!messageLimit.allowed) {
      logger.warn('User message rate limited', { 
        phone: RateLimiter.maskIdentifier(userPhone),
        remaining: messageLimit.remaining
      });
      
      await ycloud.sendTextMessage(userPhone, messageLimit.message);
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


app.get('/admin/rate-limits/:phone', async (req, res) => {
  try {
    const phone = req.params.phone;
    const stats = {};
    
    for (const action of ['message', 'job_search', 'cv_upload', 'application']) {
      const key = `rate:${action}:${phone}`;
      const current = await redis.get(key);
      const ttl = await redis.ttl(key);

      stats[action] = {
        used: parseInt(current) || 0,
        resetIn: ttl > 0 ? ttl : 0
      };
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
    const keys = await redis.keys(`rate:*:${phone}`);
    
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    
    res.json({
      message: 'Rate limits cleared',
      phone: phone.substring(0, 6) + '***',
      cleared_keys: keys.length,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    req.logger.error('Error clearing rate limits', { error: error.message });
    res.status(500).json({ error: 'Failed to clear rate limits' });
  }
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