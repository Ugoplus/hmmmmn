// config/database.js - SCALED DATABASE FOR 1000+ USERS

const { Pool } = require('pg');
const config = require('./index');
const logger = require('../utils/logger');

class DatabaseManager {
  constructor() {
    this.pool = null;
    this.isConnected = false;
    this.connectionAttempts = 0;
    this.maxConnectionAttempts = 5;
    
    // Performance monitoring
    this.queryCount = 0;
    this.slowQueryCount = 0;
    this.errorCount = 0;
    this.totalQueryTime = 0;
  }

  async connect() {
    try {
      this.connectionAttempts++;
      
      // ? SCALED CONFIGURATION FOR 1000+ USERS
      this.pool = new Pool({
        host: config.get('database.host'),
        port: config.get('database.port'),
        database: config.get('database.name'),
        user: config.get('database.user'),
        password: config.get('database.password'),
        
        // ? INCREASED CONNECTION POOL
        max: 50,                    // Increased from 20 to 50
        min: 10,                    // Minimum connections always available
        
        // ? OPTIMIZED TIMEOUTS
        idleTimeoutMillis: 10000,   // Close idle connections after 10s
        connectionTimeoutMillis: 3000, // 3s connection timeout
        acquireTimeoutMillis: 30000,   // 30s to acquire connection
        
        // ? STATEMENT TIMEOUT
        statement_timeout: 30000,   // 30s statement timeout
        query_timeout: 30000,       // 30s query timeout
        
        // ? APPLICATION IDENTIFICATION
        application_name: 'smartcv_production',
        
        // ? SSL CONFIGURATION
        ssl: process.env.NODE_ENV === 'production' ? {
          rejectUnauthorized: false
        } : false,
        
        // ? CONNECTION VALIDATION
        keepAlive: true,
        keepAliveInitialDelayMillis: 10000,
        
        // ? ERROR HANDLING
        allowExitOnIdle: false
      });

      // ? EVENT LISTENERS FOR MONITORING
      this.setupEventListeners();

      // ? TEST CONNECTION WITH TIMEOUT
      const testClient = await this.pool.connect();
      const startTime = Date.now();
      await testClient.query('SELECT NOW() as server_time, version() as server_version');
      const responseTime = Date.now() - startTime;
      testClient.release();

      this.isConnected = true;
      this.connectionAttempts = 0;
      
      logger.info('Database connected successfully', {
        host: config.get('database.host'),
        database: config.get('database.name'),
        connectionResponse: responseTime + 'ms',
        maxConnections: 50,
        minConnections: 10
      });
      
      // ? START MONITORING
      this.startMonitoring();
      
      return this.pool;
      
    } catch (error) {
      logger.error('Database connection failed', { 
        error: error.message,
        attempt: this.connectionAttempts,
        maxAttempts: this.maxConnectionAttempts
      });
      
      if (this.connectionAttempts < this.maxConnectionAttempts) {
        logger.info('Retrying database connection in 5 seconds...');
        await new Promise(resolve => setTimeout(resolve, 5000));
        return this.connect();
      }
      
      throw error;
    }
  }

  setupEventListeners() {
    // Connection events
    this.pool.on('connect', (client) => {
      logger.info('New database client connected', {
        totalCount: this.pool.totalCount,
        idleCount: this.pool.idleCount,
        waitingCount: this.pool.waitingCount
      });
    });

    this.pool.on('acquire', (client) => {
      logger.debug('Database client acquired from pool');
    });

    this.pool.on('release', (client) => {
      logger.debug('Database client released back to pool');
    });

    this.pool.on('remove', (client) => {
      logger.warn('Database client removed from pool');
    });

    this.pool.on('error', (err, client) => {
      logger.error('Database pool error', { 
        error: err.message,
        totalCount: this.pool.totalCount,
        idleCount: this.pool.idleCount
      });
    });
  }

  // ? ENHANCED QUERY METHOD WITH MONITORING
  async query(text, params) {
    if (!this.isConnected || !this.pool) {
      throw new Error('Database not connected');
    }

    const startTime = Date.now();
    const queryId = `query_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      // Log slow queries for optimization
      if (text.length > 100) {
        logger.debug('Executing database query', {
          queryId,
          queryPreview: text.substring(0, 100) + '...',
          paramsCount: params ? params.length : 0
        });
      }

      const result = await this.pool.query(text, params);
      const executionTime = Date.now() - startTime;
      
      // ? PERFORMANCE TRACKING
      this.queryCount++;
      this.totalQueryTime += executionTime;
      
      // ? SLOW QUERY DETECTION
      if (executionTime > 1000) { // Queries taking more than 1 second
        this.slowQueryCount++;
        logger.warn('Slow database query detected', {
          queryId,
          executionTime: executionTime + 'ms',
          query: text.substring(0, 200),
          rowCount: result.rows ? result.rows.length : 0
        });
      }
      
      // Log successful queries in debug mode
      if (executionTime > 100) { // Log queries over 100ms
        logger.debug('Database query completed', {
          queryId,
          executionTime: executionTime + 'ms',
          rowCount: result.rows ? result.rows.length : 0
        });
      }
      
      return result;
      
    } catch (error) {
      const executionTime = Date.now() - startTime;
      this.errorCount++;
      
      logger.error('Database query failed', {
        queryId,
        error: error.message,
        executionTime: executionTime + 'ms',
        query: text.substring(0, 200),
        params: params ? params.length : 0
      });
      
      throw error;
    }
  }

  // ? ENHANCED HEALTH CHECK
  async healthCheck() {
    try {
      const startTime = Date.now();
      
      // Test basic connectivity
      const result = await this.pool.query('SELECT 1 as health_check, NOW() as current_time');
      const responseTime = Date.now() - startTime;
      
      // Check pool status
      const poolStats = {
        totalCount: this.pool.totalCount,
        idleCount: this.pool.idleCount,
        waitingCount: this.pool.waitingCount
      };
      
      // Validate response
      if (result.rows.length > 0 && result.rows[0].health_check === 1) {
        logger.debug('Database health check passed', {
          responseTime: responseTime + 'ms',
          poolStats
        });
        return true;
      }
      
      return false;
      
    } catch (error) {
      logger.error('Database health check failed', { error: error.message });
      return false;
    }
  }

  // ? CONNECTION POOL STATUS
  getPoolStatus() {
    if (!this.pool) {
      return {
        connected: false,
        error: 'Pool not initialized'
      };
    }

    return {
      connected: this.isConnected,
      totalConnections: this.pool.totalCount,
      idleConnections: this.pool.idleCount,
      waitingRequests: this.pool.waitingCount,
      maxConnections: 50,
      minConnections: 10,
      performance: {
        totalQueries: this.queryCount,
        slowQueries: this.slowQueryCount,
        errorQueries: this.errorCount,
        averageQueryTime: this.queryCount > 0 ? 
          Math.round(this.totalQueryTime / this.queryCount) : 0
      }
    };
  }

  // ? PERFORMANCE MONITORING
  startMonitoring() {
    // Log pool stats every 5 minutes
    setInterval(() => {
      const stats = this.getPoolStatus();
      
      if (stats.connected) {
        logger.info('Database pool status', {
          connections: {
            total: stats.totalConnections,
            idle: stats.idleConnections,
            waiting: stats.waitingRequests
          },
          performance: stats.performance
        });
        
        // Alert on high connection usage
        if (stats.totalConnections > 40) { // 80% of max connections
          logger.warn('High database connection usage', {
            usage: `${stats.totalConnections}/50`,
            percentage: Math.round((stats.totalConnections / 50) * 100) + '%'
          });
        }
        
        // Alert on slow queries
        if (stats.performance.slowQueries > 0) {
          logger.warn('Slow queries detected', {
            slowQueryCount: stats.performance.slowQueries,
            totalQueries: stats.performance.totalQueries,
            slowQueryPercentage: Math.round((stats.performance.slowQueries / stats.performance.totalQueries) * 100) + '%'
          });
        }
      }
    }, 300000); // Every 5 minutes

    // Reset performance counters every hour
    setInterval(() => {
      if (this.queryCount > 0) {
        logger.info('Resetting database performance counters', {
          queriesProcessed: this.queryCount,
          averageQueryTime: Math.round(this.totalQueryTime / this.queryCount) + 'ms',
          slowQueryRate: Math.round((this.slowQueryCount / this.queryCount) * 100) + '%'
        });
      }
      
      this.queryCount = 0;
      this.slowQueryCount = 0;
      this.errorCount = 0;
      this.totalQueryTime = 0;
    }, 3600000); // Every hour
  }

  // ? CONNECTION OPTIMIZATION
  async optimizeConnections() {
    try {
      // Execute optimization queries
      await this.query('VACUUM ANALYZE applications');
      await this.query('VACUUM ANALYZE jobs');
      await this.query('VACUUM ANALYZE daily_usage');
      
      logger.info('Database optimization completed');
      
    } catch (error) {
      logger.error('Database optimization failed', { error: error.message });
    }
  }

  // ? GRACEFUL SHUTDOWN
  async close() {
    if (this.pool) {
      try {
        await this.pool.end();
        this.isConnected = false;
        logger.info('Database connections closed gracefully');
      } catch (error) {
        logger.error('Error closing database connections', { error: error.message });
      }
    }
  }

  // ? TRANSACTION SUPPORT
  async transaction(callback) {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // ? BATCH OPERATIONS
  async batchQuery(queries) {
    const results = [];
    const client = await this.pool.connect();
    
    try {
      for (const { text, params } of queries) {
        const result = await client.query(text, params);
        results.push(result);
      }
      return results;
    } finally {
      client.release();
    }
  }
}

// ? CREATE SINGLETON INSTANCE
const dbManager = new DatabaseManager();

// ? RUN OPTIMIZATION EVERY 6 HOURS
setInterval(() => {
  dbManager.optimizeConnections();
}, 21600000);

module.exports = dbManager;