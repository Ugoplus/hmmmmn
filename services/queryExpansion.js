// services/queryExpansion.js - REALISTIC VERSION based on actual Nigerian job data

const { Queue } = require('bullmq');
const { queueRedis, redis } = require('../config/redis');
const dbManager = require('../config/database');
const logger = require('../utils/logger');

const aiQueue = new Queue('openai-tasks', { 
  connection: queueRedis,
  prefix: 'queue:'
});

class RealWorldQueryExpansion {
  constructor() {
    // Based on analyzing your actual 746 jobs
    this.realWorldMappings = {
      // SOFTWARE DEVELOPMENT - Very specific to avoid Java/Python confusion
      'react': {
        must_include: ['react', 'frontend', 'javascript', 'web'],
        must_exclude: ['java developer', 'backend only', 'python only', 'php only'],
        related: ['typescript', 'next.js', 'vue', 'angular', 'node.js'],
        boost_terms: ['react', 'frontend developer', 'javascript developer']
      },
      'javascript': {
        must_include: ['javascript', 'frontend', 'web developer'],
        must_exclude: ['java developer', 'backend only'],
        related: ['react', 'vue', 'angular', 'node.js', 'typescript'],
        boost_terms: ['javascript', 'js', 'frontend']
      },
      'java': {
        must_include: ['java', 'backend', 'spring'],
        must_exclude: ['javascript', 'react', 'vue', 'frontend only'],
        related: ['spring boot', 'kotlin', 'maven', 'hibernate'],
        boost_terms: ['java developer', 'java engineer', 'backend java']
      },
      'python': {
        must_include: ['python', 'developer'],
        must_exclude: ['javascript', 'java only', 'php only'],
        related: ['django', 'flask', 'fastapi', 'data science'],
        boost_terms: ['python developer', 'python engineer']
      },
      'php': {
        must_include: ['php', 'web developer', 'backend'],
        must_exclude: ['javascript only', 'java only', 'python only'],
        related: ['laravel', 'wordpress', 'mysql', 'codeigniter'],
        boost_terms: ['php developer', 'laravel developer']
      },
      'developer': {
        must_include: ['developer', 'software', 'programming'],
        must_exclude: ['business developer', 'sales developer'],
        related: ['engineer', 'programmer', 'coding'],
        boost_terms: ['software developer', 'web developer', 'application developer']
      },

      // ACCOUNTING - Your data shows many accounting roles
      'accountant': {
        must_include: ['accountant', 'accounting', 'finance'],
        must_exclude: ['account manager', 'sales account'],
        related: ['bookkeeping', 'audit', 'financial reporting', 'quickbooks'],
        boost_terms: ['accountant', 'accounting officer', 'finance accountant']
      },
      'accounting': {
        must_include: ['accounting', 'accountant', 'finance'],
        must_exclude: ['account executive', 'account manager'],
        related: ['bookkeeping', 'audit', 'financial statements'],
        boost_terms: ['accounting', 'accounts', 'financial accounting']
      },

      // SALES & MARKETING - Distinct from account management
      'sales': {
        must_include: ['sales', 'business development', 'marketing'],
        must_exclude: ['accounting', 'technical sales engineer'],
        related: ['account manager', 'business development', 'client relations'],
        boost_terms: ['sales representative', 'sales executive', 'sales officer']
      },
      'marketing': {
        must_include: ['marketing', 'digital marketing', 'brand'],
        must_exclude: ['market research only'],
        related: ['social media', 'content', 'advertising', 'seo'],
        boost_terms: ['marketing manager', 'digital marketing', 'marketing executive']
      },

      // ENGINEERING - Physical engineering (from your data)
      'engineer': {
        must_include: ['engineer', 'engineering'],
        must_exclude: ['software engineer only'],
        related: ['mechanical', 'electrical', 'civil', 'project'],
        boost_terms: ['engineer', 'engineering', 'technical engineer']
      },
      'mechanical': {
        must_include: ['mechanical', 'engineer'],
        must_exclude: ['software', 'electrical only'],
        related: ['maintenance', 'industrial', 'production'],
        boost_terms: ['mechanical engineer', 'mechanical engineering']
      },

      // HEALTHCARE - Common in your data
      'nurse': {
        must_include: ['nurse', 'nursing', 'healthcare'],
        must_exclude: ['nursing assistant only'],
        related: ['registered nurse', 'clinical', 'patient care'],
        boost_terms: ['nurse', 'registered nurse', 'nursing']
      },
      'medical': {
        must_include: ['medical', 'healthcare', 'clinical'],
        must_exclude: ['medical sales only'],
        related: ['doctor', 'nurse', 'hospital', 'health'],
        boost_terms: ['medical officer', 'medical doctor', 'healthcare']
      },

      // MANAGEMENT
      'manager': {
        must_include: ['manager', 'management'],
        must_exclude: ['account manager only'],
        related: ['supervisor', 'team lead', 'director'],
        boost_terms: ['manager', 'management', 'managing']
      },

      // ADMINISTRATIVE
      'admin': {
        must_include: ['admin', 'administrative', 'office'],
        must_exclude: ['system admin', 'database admin'],
        related: ['secretary', 'receptionist', 'assistant'],
        boost_terms: ['admin officer', 'administrative', 'office admin']
      },

      // HR
      'hr': {
        must_include: ['human resources', 'hr', 'recruitment'],
        must_exclude: [],
        related: ['talent', 'payroll', 'employee relations'],
        boost_terms: ['hr officer', 'human resources', 'hr manager']
      },

      // CUSTOMER SERVICE
      'customer service': {
        must_include: ['customer service', 'support', 'client'],
        must_exclude: ['technical support only'],
        related: ['call center', 'help desk', 'customer care'],
        boost_terms: ['customer service', 'customer support', 'client service']
      },

      // LOGISTICS
      'logistics': {
        must_include: ['logistics', 'supply chain', 'warehouse'],
        must_exclude: [],
        related: ['procurement', 'inventory', 'distribution'],
        boost_terms: ['logistics officer', 'logistics manager', 'supply chain']
      },

      // DRIVER - Specific role in your data
      'driver': {
        must_include: ['driver', 'driving'],
        must_exclude: [],
        related: ['transport', 'delivery', 'logistics'],
        boost_terms: ['driver', 'company driver', 'delivery driver']
      }
    };
  }

  /**
   * Expand query with realistic mappings first, AI as fallback
   */
  async expandQuery(userQuery, jobCategory = null) {
    try {
      const queryLower = userQuery.toLowerCase().trim();

      // Try rule-based expansion first (instant, free)
      const ruleBasedExpansion = this.getRuleBasedExpansion(queryLower);
      
      if (ruleBasedExpansion && ruleBasedExpansion.confidence > 0.8) {
        logger.info('Using rule-based expansion', { 
          query: userQuery, 
          confidence: ruleBasedExpansion.confidence 
        });
        return ruleBasedExpansion;
      }

      // Check cache
      const cacheKey = this.getCacheKey(userQuery, jobCategory);
      const memCached = await redis.get(`query_exp:${cacheKey}`);
      if (memCached) {
        return JSON.parse(memCached);
      }

      const dbCached = await this.getFromDatabaseCache(userQuery, jobCategory);
      if (dbCached) {
        await redis.set(`query_exp:${cacheKey}`, JSON.stringify(dbCached), 'EX', 3600);
        return dbCached;
      }

      // Use AI for complex/ambiguous queries
      const aiExpansion = await this.generateWithAI(userQuery, jobCategory);
      
      // Cache results
      await redis.set(`query_exp:${cacheKey}`, JSON.stringify(aiExpansion), 'EX', 3600);
      await this.saveToDatabaseCache(userQuery, jobCategory, aiExpansion);

      return aiExpansion;

    } catch (error) {
      logger.error('Query expansion failed', { error: error.message });
      return this.getFallbackExpansion(userQuery);
    }
  }

  /**
   * Rule-based expansion using real-world mappings
   */
  getRuleBasedExpansion(queryLower) {
    // Find best matching keyword
    let bestMatch = null;
    let bestMatchLength = 0;

    for (const [keyword, mapping] of Object.entries(this.realWorldMappings)) {
      if (queryLower.includes(keyword) && keyword.length > bestMatchLength) {
        bestMatch = { keyword, ...mapping };
        bestMatchLength = keyword.length;
      }
    }

    if (!bestMatch) {
      return null;
    }

    return {
      must_include: bestMatch.must_include,
      must_exclude: bestMatch.must_exclude,
      related_terms: bestMatch.related,
      boost_terms: bestMatch.boost_terms,
      confidence: 0.9,
      source: 'rule-based',
      matched_keyword: bestMatch.keyword
    };
  }

  /**
   * AI-powered expansion for complex queries
   */
  async generateWithAI(userQuery, jobCategory) {
    try {
      const job = await aiQueue.add(
        'expand-query',
        { userQuery, jobCategory, timestamp: Date.now() },
        { jobId: `query-expand-${Date.now()}`, attempts: 2, timeout: 10000 }
      );

      const result = await job.waitUntilFinished(aiQueue.events, 12000);

      if (result && result.must_include) {
        return { ...result, confidence: 0.85, source: 'ai' };
      }

      throw new Error('Invalid AI result');

    } catch (error) {
      logger.warn('AI expansion failed', { error: error.message });
      return this.getFallbackExpansion(userQuery);
    }
  }

  /**
   * Fallback expansion
   */
  getFallbackExpansion(userQuery) {
    const words = userQuery.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    return {
      must_include: words,
      must_exclude: [],
      related_terms: [],
      boost_terms: words,
      confidence: 0.5,
      source: 'fallback'
    };
  }

  /**
   * Build PostgreSQL search query with boosting
   */
  buildSearchQuery(expansion, location = null) {
    const conditions = [];
    const params = [];
    let paramIndex = 1;

    // MUST INCLUDE (at least 2 of these terms)
    if (expansion.must_include && expansion.must_include.length > 0) {
      const orConditions = expansion.must_include.map(term => {
        const condition = `(
          title ILIKE $${paramIndex} OR 
          description ILIKE $${paramIndex} OR 
          requirements ILIKE $${paramIndex} OR
          category ILIKE $${paramIndex} OR
          experience ILIKE $${paramIndex}
        )`;
        params.push(`%${term}%`);
        paramIndex++;
        return condition;
      });
      
      // At least 2 matches required for relevance
      const minMatches = Math.min(2, expansion.must_include.length);
      conditions.push(`(
        (${orConditions.join(' + ')}) >= ${minMatches}
      )`);
    }

    // MUST EXCLUDE (strict)
    if (expansion.must_exclude && expansion.must_exclude.length > 0) {
      expansion.must_exclude.forEach(term => {
        conditions.push(`NOT (
          title ILIKE $${paramIndex} OR 
          description ILIKE $${paramIndex} OR 
          requirements ILIKE $${paramIndex}
        )`);
        params.push(`%${term}%`);
        paramIndex++;
      });
    }

    // Location
    if (location && location.toLowerCase() !== 'remote') {
      conditions.push(`(location ILIKE $${paramIndex} OR state ILIKE $${paramIndex})`);
      params.push(`%${location}%`);
      paramIndex++;
    } else if (location && location.toLowerCase() === 'remote') {
      conditions.push('is_remote = true');
    }

    // Active jobs only
    conditions.push('(expires_at IS NULL OR expires_at > NOW())');

    const whereClause = conditions.length > 0 
      ? `WHERE ${conditions.join(' AND ')}`
      : 'WHERE (expires_at IS NULL OR expires_at > NOW())';

    // Relevance-based ordering with boost terms
    let orderClause = '';
    if (expansion.boost_terms && expansion.boost_terms.length > 0) {
      const boostConditions = expansion.boost_terms.map((term, idx) => {
        return `WHEN title ILIKE '%${term}%' THEN ${expansion.boost_terms.length - idx}`;
      }).join(' ');

      orderClause = `
        ORDER BY 
          CASE 
            ${boostConditions}
            ELSE 0
          END DESC,
          COALESCE(last_updated, scraped_at, NOW()) DESC
      `;
    } else {
      orderClause = 'ORDER BY COALESCE(last_updated, scraped_at, NOW()) DESC';
    }

    return { whereClause, orderClause, params };
  }

  /**
   * Search jobs with expanded query
   */
  async searchJobs(userQuery, jobCategory, location, limit = 50) {
    try {
      const expansion = await this.expandQuery(userQuery, jobCategory);

      logger.info('Executing expanded search', {
        userQuery,
        mustInclude: expansion.must_include,
        mustExclude: expansion.must_exclude,
        source: expansion.source,
        confidence: expansion.confidence
      });

      const { whereClause, orderClause, params } = this.buildSearchQuery(expansion, location);

      const query = `SELECT * FROM jobs ${whereClause} ${orderClause} LIMIT ${limit}`;

      const result = await dbManager.query(query, params);

      logger.info('Search complete', {
        userQuery,
        resultsFound: result.rows.length,
        source: expansion.source
      });

      return {
        jobs: result.rows,
        expansion,
        searchQuery: userQuery,
        confidence: expansion.confidence
      };

    } catch (error) {
      logger.error('Search failed', { userQuery, error: error.message });
      return { jobs: [], expansion: null, searchQuery: userQuery };
    }
  }

  /**
   * Post-filter for auto-apply (stricter matching)
   */
  async filterForAutoApply(jobs, userQuery, expansionData) {
    const filtered = jobs.filter(job => {
      const titleLower = (job.title || '').toLowerCase();
      const descLower = (job.description || '').toLowerCase();
      const combined = `${titleLower} ${descLower}`;

      // Must have at least 2 must_include terms
      const mustMatches = expansionData.must_include.filter(term => 
        combined.includes(term.toLowerCase())
      );

      if (mustMatches.length < 2) {
        return false;
      }

      // Must NOT have any must_exclude terms
      const hasExcluded = expansionData.must_exclude.some(term =>
        combined.includes(term.toLowerCase())
      );

      return !hasExcluded;
    });

    logger.info('Auto-apply filter applied', {
      originalCount: jobs.length,
      filteredCount: filtered.length,
      removedCount: jobs.length - filtered.length
    });

    return filtered;
  }

  // Cache methods (same as before)
  getCacheKey(userQuery, jobCategory) {
    const key = `${userQuery.toLowerCase()}-${jobCategory || 'any'}`;
    return require('crypto').createHash('md5').update(key).digest('hex');
  }

  async getFromDatabaseCache(userQuery, jobCategory) {
    try {
      const result = await dbManager.query(`
        UPDATE query_expansion_cache
        SET hit_count = hit_count + 1, last_used_at = NOW()
        WHERE search_query = $1 
          AND (job_category = $2 OR ($2 IS NULL AND job_category IS NULL))
          AND expires_at > NOW()
        RETURNING expanded_data
      `, [userQuery.toLowerCase(), jobCategory]);

      return result.rows.length > 0 ? result.rows[0].expanded_data : null;
    } catch (error) {
      logger.error('Cache read failed', { error: error.message });
      return null;
    }
  }

  async saveToDatabaseCache(userQuery, jobCategory, expandedData) {
    try {
      await dbManager.query(`
        INSERT INTO query_expansion_cache (
          search_query, job_category, expanded_data, expires_at
        ) VALUES ($1, $2, $3, NOW() + INTERVAL '7 days')
        ON CONFLICT (search_query, job_category) 
        DO UPDATE SET 
          expanded_data = $3,
          expires_at = NOW() + INTERVAL '7 days',
          last_used_at = NOW()
      `, [userQuery.toLowerCase(), jobCategory, JSON.stringify(expandedData)]);
    } catch (error) {
      logger.error('Cache write failed', { error: error.message });
    }
  }

  async cleanExpiredCache() {
    try {
      const result = await dbManager.query(`
        DELETE FROM query_expansion_cache WHERE expires_at < NOW() RETURNING id
      `);
      return result.rows.length;
    } catch (error) {
      logger.error('Cache cleanup failed', { error: error.message });
      return 0;
    }
  }
}

module.exports = new RealWorldQueryExpansion();