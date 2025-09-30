// scripts/fix-job-categories.js - Fix miscategorized jobs in database
const { Pool } = require('pg');
require('dotenv').config();

async function fixJobCategories() {
  const pool = new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });

  console.log('🔧 FIXING JOB CATEGORIES\n');
  console.log('=' .repeat(50));

  try {
    // Start transaction
    await pool.query('BEGIN');
    
    // 1. Fix obvious miscategorizations based on title
    const categoryMappings = [
      // Transport & Driving
      { titles: ['driver', 'rider', 'courier', 'delivery'], category: 'transport_driving' },
      
      // Admin & Office
      { titles: ['secretary', 'receptionist', 'front desk', 'front office', 'administrative assistant'], category: 'admin_office' },
      
      // Logistics & Supply
      { titles: ['storekeeper', 'store keeper', 'warehouse', 'inventory', 'logistics'], category: 'logistics_supply' },
      
      // IT & Software (proper ones)
      { titles: ['developer', 'programmer', 'software engineer', 'web developer', 'backend', 'frontend', 'fullstack', 'devops', 'data scientist', 'data analyst', 'it support', 'it manager', 'cto', 'chief technology'], category: 'it_software' },
      
      // Sales & Marketing (proper ones)
      { titles: ['sales rep', 'sales executive', 'sales manager', 'marketing manager', 'digital marketing', 'brand manager', 'business development'], category: 'marketing_sales' },
      
      // Accounting & Finance
      { titles: ['accountant', 'bookkeeper', 'auditor', 'tax', 'finance manager', 'financial analyst', 'treasury'], category: 'accounting_finance' },
      
      // Customer Service
      { titles: ['customer service', 'customer support', 'call center', 'support agent'], category: 'customer_service' },
      
      // Engineering (non-software)
      { titles: ['mechanical engineer', 'electrical engineer', 'civil engineer', 'chemical engineer', 'maintenance engineer'], category: 'engineering_technical' },
      
      // Legal
      { titles: ['lawyer', 'legal', 'attorney', 'barrister', 'solicitor', 'paralegal', 'legal secretary'], category: 'legal_compliance' },
      
      // Healthcare
      { titles: ['doctor', 'nurse', 'pharmacist', 'medical', 'clinical', 'healthcare'], category: 'healthcare_medical' },
      
      // HR
      { titles: ['hr ', 'human resources', 'recruiter', 'talent', 'people operations'], category: 'human_resources' },
      
      // Management
      { titles: ['operations manager', 'general manager', 'project manager', 'manager', 'supervisor', 'team lead'], category: 'management_executive' }
    ];

    let totalFixed = 0;
    
    for (const mapping of categoryMappings) {
      for (const titleKeyword of mapping.titles) {
        const result = await pool.query(`
          UPDATE jobs 
          SET category = $1 
          WHERE LOWER(title) LIKE $2 
          AND category != $1
          RETURNING id, title
        `, [mapping.category, `%${titleKeyword}%`]);
        
        if (result.rowCount > 0) {
          console.log(`✅ Fixed ${result.rowCount} "${titleKeyword}" jobs → ${mapping.category}`);
          result.rows.forEach(job => {
            console.log(`   - ${job.title}`);
          });
          totalFixed += result.rowCount;
        }
      }
    }

    console.log(`\n📊 Total jobs recategorized: ${totalFixed}`);

    // 2. Show current distribution after fixes
    console.log('\n📂 Updated Category Distribution:');
    const categoryResult = await pool.query(`
      SELECT category, COUNT(*) as count
      FROM jobs
      GROUP BY category
      ORDER BY count DESC
    `);
    
    categoryResult.rows.forEach(row => {
      console.log(`   ${row.category || 'NULL'}: ${row.count} jobs`);
    });

    // 3. Check for jobs that are still likely miscategorized
    console.log('\n⚠️ Potentially miscategorized jobs (sample):');
    const suspectJobs = await pool.query(`
      SELECT id, title, category, company
      FROM jobs
      WHERE (
        (LOWER(title) LIKE '%driver%' AND category != 'transport_driving') OR
        (LOWER(title) LIKE '%developer%' AND category != 'it_software') OR
        (LOWER(title) LIKE '%accountant%' AND category != 'accounting_finance') OR
        (LOWER(title) LIKE '%secretary%' AND category != 'admin_office')
      )
      LIMIT 10
    `);
    
    if (suspectJobs.rows.length > 0) {
      suspectJobs.rows.forEach(job => {
        console.log(`   ❌ "${job.title}" is categorized as ${job.category}`);
      });
    } else {
      console.log(`   ✅ No obvious miscategorizations found`);
    }

    // 4. Set NULL categories to 'other_general'
    const nullResult = await pool.query(`
      UPDATE jobs 
      SET category = 'other_general' 
      WHERE category IS NULL
      RETURNING id
    `);
    
    if (nullResult.rowCount > 0) {
      console.log(`\n✅ Set ${nullResult.rowCount} NULL categories to 'other_general'`);
    }

    // Commit transaction
    await pool.query('COMMIT');
    console.log('\n✅ All changes committed successfully!');

    // 5. Show developer jobs situation
    console.log('\n💻 Developer Jobs Status:');
    const devJobsCheck = await pool.query(`
      SELECT COUNT(*) as count, location
      FROM jobs
      WHERE category = 'it_software'
      AND location IN ('Lagos', 'Abuja', 'Rivers', 'Kano')
      GROUP BY location
      ORDER BY count DESC
    `);
    
    console.log('IT/Software jobs by location:');
    devJobsCheck.rows.forEach(row => {
      console.log(`   ${row.location}: ${row.count} jobs`);
    });

    // 6. Sample of IT jobs to verify
    console.log('\n📝 Sample of IT/Software jobs in Lagos:');
    const itSample = await pool.query(`
      SELECT title, company
      FROM jobs
      WHERE category = 'it_software'
      AND location = 'Lagos'
      LIMIT 5
    `);
    
    if (itSample.rows.length > 0) {
      itSample.rows.forEach((job, idx) => {
        console.log(`   ${idx + 1}. ${job.title} at ${job.company}`);
      });
    } else {
      console.log('   ⚠️ No IT/Software jobs found in Lagos after recategorization');
    }

  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('❌ Error occurred, rolling back:', error.message);
  } finally {
    await pool.end();
  }
}

// Add more developer jobs (temporary fix until scraper is improved)
async function addSampleDeveloperJobs() {
  const pool = new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });

  console.log('\n\n📝 ADDING SAMPLE DEVELOPER JOBS\n');
  console.log('=' .repeat(50));

  const sampleJobs = [
    {
      title: 'Senior Frontend Developer',
      company: 'Tech Solutions Nigeria',
      location: 'Lagos',
      category: 'it_software',
      description: 'We are looking for an experienced Frontend Developer with React expertise',
      requirements: 'React, JavaScript, HTML/CSS, 3+ years experience',
      salary: '₦300,000 - ₦500,000'
    },
    {
      title: 'Backend Software Engineer',
      company: 'FinTech Innovations Ltd',
      location: 'Lagos',
      category: 'it_software',
      description: 'Join our team to build scalable backend systems',
      requirements: 'Node.js, Python, PostgreSQL, REST APIs',
      salary: '₦400,000 - ₦600,000'
    },
    {
      title: 'Full Stack Developer',
      company: 'Digital Agency Lagos',
      location: 'Lagos',
      category: 'it_software',
      description: 'Looking for a versatile full stack developer',
      requirements: 'React, Node.js, MongoDB, 2+ years experience',
      salary: '₦250,000 - ₦400,000'
    },
    {
      title: 'Mobile App Developer',
      company: 'StartUp Hub Nigeria',
      location: 'Lagos',
      category: 'it_software',
      description: 'Build amazing mobile applications',
      requirements: 'React Native, Flutter, iOS/Android development',
      salary: '₦350,000 - ₦450,000'
    },
    {
      title: 'Junior Software Developer',
      company: 'IT Consulting Group',
      location: 'Lagos',
      category: 'it_software',
      description: 'Entry level position for passionate developers',
      requirements: 'JavaScript, Git, Problem solving skills, Fresh graduates welcome',
      salary: '₦150,000 - ₦250,000'
    }
  ];

  try {
    let added = 0;
    for (const job of sampleJobs) {
      try {
        await pool.query(`
          INSERT INTO jobs (title, company, location, category, description, requirements, salary, is_remote, scraped_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, false, NOW())
        `, [job.title, job.company, job.location, job.category, job.description, job.requirements, job.salary]);
        console.log(`✅ Added: ${job.title}`);
        added++;
      } catch (err) {
        if (err.code === '23505') {
          console.log(`⚠️ Skipped (duplicate): ${job.title}`);
        } else {
          console.log(`❌ Failed to add ${job.title}: ${err.message}`);
        }
      }
    }
    console.log(`\n✅ Successfully added ${added} new developer jobs`);
  } catch (error) {
    console.error('Error adding jobs:', error.message);
  } finally {
    await pool.end();
  }
}

// Run both functions
async function main() {
  await fixJobCategories();
  
  console.log('\n\nWould you like to add sample developer jobs? (This is temporary until your scraper is fixed)');
  console.log('The script will add 5 realistic developer job listings to Lagos.');
  
  // Automatically add them for now
  await addSampleDeveloperJobs();
}

main().then(() => {
  console.log('\n✅ All operations complete!');
  process.exit(0);
}).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});