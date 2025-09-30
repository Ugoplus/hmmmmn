// scripts/debug-jobs.js - Run this to see what's actually in your database
const { Pool } = require('pg');
require('dotenv').config();

async function debugJobs() {
  const pool = new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });

  console.log('🔍 DEBUGGING JOB DATABASE\n');
  console.log('=' .repeat(50));

  try {
    // 1. Check total jobs
    const totalResult = await pool.query('SELECT COUNT(*) as total FROM jobs');
    console.log(`\n📊 Total jobs in database: ${totalResult.rows[0].total}`);

    // 2. Check jobs by location
    console.log('\n📍 Jobs by Location:');
    const locationResult = await pool.query(`
      SELECT location, COUNT(*) as count 
      FROM jobs 
      GROUP BY location 
      ORDER BY count DESC 
      LIMIT 10
    `);
    locationResult.rows.forEach(row => {
      console.log(`   ${row.location}: ${row.count} jobs`);
    });

    // 3. Check if ANY developer jobs exist
    console.log('\n💻 Developer Jobs Search:');
    const devSearches = [
      'developer',
      'software',
      'programmer',
      'engineer',
      'frontend',
      'backend',
      'web developer',
      'software engineer'
    ];

    for (const term of devSearches) {
      const result = await pool.query(`
        SELECT COUNT(*) as count
        FROM jobs
        WHERE (
          title ILIKE $1 OR 
          description ILIKE $1 OR
          requirements ILIKE $1
        )
        AND location ILIKE '%Lagos%'
      `, [`%${term}%`]);
      
      console.log(`   "${term}" in Lagos: ${result.rows[0].count} jobs found`);
    }

    // 4. Show sample of what's actually being returned
    console.log('\n🔍 Sample of jobs with "developer" in title (Lagos):');
    const devJobsResult = await pool.query(`
      SELECT id, title, company, location
      FROM jobs
      WHERE title ILIKE '%developer%'
      AND location ILIKE '%Lagos%'
      LIMIT 5
    `);
    
    if (devJobsResult.rows.length > 0) {
      devJobsResult.rows.forEach(job => {
        console.log(`   [${job.id}] ${job.title} at ${job.company} (${job.location})`);
      });
    } else {
      console.log('   ❌ No jobs with "developer" in title found in Lagos');
    }

    // 5. Show what IS being returned for the search
    console.log('\n❓ Jobs that ARE being returned (using your actual query):');
    const actualQueryResult = await pool.query(`
      SELECT id, title, company, location
      FROM jobs
      WHERE (
        title ILIKE $1 OR title ILIKE $2 OR title ILIKE $3 OR
        description ILIKE $1 OR description ILIKE $2 OR description ILIKE $3 OR
        requirements ILIKE $1 OR requirements ILIKE $2 OR requirements ILIKE $3
      )
      AND (location ILIKE $4 OR state ILIKE $4)
      AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY 
        CASE 
          WHEN title ILIKE $1 THEN 1
          WHEN description ILIKE $1 THEN 2
          ELSE 3
        END,
        COALESCE(last_updated, scraped_at, NOW()) DESC
      LIMIT 10
    `, ['%developer%', '%software%', '%programmer%', '%Lagos%']);

    console.log(`   Found ${actualQueryResult.rows.length} results:`);
    actualQueryResult.rows.forEach((job, idx) => {
      console.log(`   ${idx + 1}. [${job.id}] ${job.title} at ${job.company}`);
    });

    // 6. Check what categories exist
    console.log('\n📂 Job Categories in Database:');
    const categoryResult = await pool.query(`
      SELECT category, COUNT(*) as count
      FROM jobs
      WHERE category IS NOT NULL
      GROUP BY category
      ORDER BY count DESC
      LIMIT 10
    `);
    
    if (categoryResult.rows.length > 0) {
      categoryResult.rows.forEach(row => {
        console.log(`   ${row.category}: ${row.count} jobs`);
      });
    } else {
      console.log('   ⚠️ No categories found in database');
    }

    // 7. Sample of ALL jobs in Lagos (to see what's actually there)
    console.log('\n📋 Random sample of ALL Lagos jobs:');
    const allLagosJobs = await pool.query(`
      SELECT id, title, company, category
      FROM jobs
      WHERE location ILIKE '%Lagos%'
      ORDER BY RANDOM()
      LIMIT 10
    `);
    
    allLagosJobs.rows.forEach((job, idx) => {
      console.log(`   ${idx + 1}. ${job.title} at ${job.company} [${job.category || 'no category'}]`);
    });

    // 8. Check if it's a case sensitivity issue
    console.log('\n🔤 Case Sensitivity Check:');
    const caseCheck = await pool.query(`
      SELECT 
        COUNT(CASE WHEN title LIKE '%Developer%' THEN 1 END) as exact_case,
        COUNT(CASE WHEN title ILIKE '%developer%' THEN 1 END) as case_insensitive
      FROM jobs
      WHERE location ILIKE '%Lagos%'
    `);
    console.log(`   Exact case "Developer": ${caseCheck.rows[0].exact_case}`);
    console.log(`   Case insensitive "developer": ${caseCheck.rows[0].case_insensitive}`);

    // 9. Check the actual content of a few jobs
    console.log('\n📝 Full details of first job that SHOULD match:');
    const detailCheck = await pool.query(`
      SELECT id, title, company, location, category, 
             LEFT(description, 200) as description_preview,
             LEFT(requirements, 200) as requirements_preview
      FROM jobs
      WHERE location ILIKE '%Lagos%'
      AND (
        title ILIKE '%developer%' OR
        title ILIKE '%software%' OR
        title ILIKE '%programmer%' OR
        description ILIKE '%developer%' OR
        description ILIKE '%software%'
      )
      LIMIT 1
    `);
    
    if (detailCheck.rows.length > 0) {
      const job = detailCheck.rows[0];
      console.log(`   ID: ${job.id}`);
      console.log(`   Title: ${job.title}`);
      console.log(`   Company: ${job.company}`);
      console.log(`   Location: ${job.location}`);
      console.log(`   Category: ${job.category || 'NULL'}`);
      console.log(`   Description preview: ${job.description_preview || 'NULL'}`);
      console.log(`   Requirements preview: ${job.requirements_preview || 'NULL'}`);
    } else {
      console.log('   ❌ No matching jobs found at all!');
    }

  } catch (error) {
    console.error('Error:', error.message);
    console.error('Full error:', error);
  } finally {
    await pool.end();
  }
}

debugJobs().then(() => {
  console.log('\n✅ Debug complete!');
  process.exit(0);
}).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});