// scripts/emergency-fix-categories.js
const { Pool } = require('pg');
require('dotenv').config();

async function fixMiscategorizedJobs() {
  const pool = new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });

  console.log('🚨 EMERGENCY FIX: Fixing miscategorized jobs\n');
  console.log('=' .repeat(50));

  try {
    await pool.query('BEGIN');
    
    // Fix Business Development Manager being marked as healthcare
    let result = await pool.query(`
      UPDATE jobs 
      SET category = 'marketing_sales' 
      WHERE LOWER(title) LIKE '%business development%'
      AND category = 'healthcare_medical'
      RETURNING id, title, company
    `);
    
    console.log(`✅ Fixed ${result.rowCount} Business Development jobs miscategorized as healthcare`);
    result.rows.forEach(job => {
      console.log(`   - ${job.title} at ${job.company}`);
    });

    // Fix other common miscategorizations
    const fixes = [
      {
        condition: "LOWER(title) LIKE '%manager%' AND NOT LOWER(title) LIKE '%clinical%' AND NOT LOWER(title) LIKE '%medical%' AND NOT LOWER(title) LIKE '%health%'",
        from: 'healthcare_medical',
        to: 'management_executive',
        desc: 'general managers'
      },
      {
        condition: "LOWER(title) LIKE '%sales%' OR LOWER(title) LIKE '%marketing%'",
        from: 'healthcare_medical',
        to: 'marketing_sales',
        desc: 'sales/marketing'
      },
      {
        condition: "LOWER(title) LIKE '%admin%' OR LOWER(title) LIKE '%secretary%' OR LOWER(title) LIKE '%receptionist%'",
        from: 'healthcare_medical',
        to: 'admin_office',
        desc: 'administrative'
      },
      {
        condition: "LOWER(title) LIKE '%driver%'",
        from: 'healthcare_medical',
        to: 'transport_driving',
        desc: 'driver'
      },
      {
        condition: "LOWER(title) LIKE '%accountant%' OR LOWER(title) LIKE '%finance%'",
        from: 'healthcare_medical',
        to: 'accounting_finance',
        desc: 'finance'
      }
    ];

    for (const fix of fixes) {
      const result = await pool.query(`
        UPDATE jobs 
        SET category = $1 
        WHERE ${fix.condition}
        AND category = $2
        RETURNING id, title
      `, [fix.to, fix.from]);
      
      if (result.rowCount > 0) {
        console.log(`✅ Fixed ${result.rowCount} ${fix.desc} jobs miscategorized as healthcare`);
      }
    }

    // Now ensure ONLY actual healthcare jobs are in healthcare_medical
    console.log('\n🏥 Verifying healthcare category only has medical jobs...');
    
    const healthcareKeywords = [
      'doctor', 'nurse', 'physician', 'surgeon', 'medical officer',
      'pharmacist', 'dentist', 'therapist', 'clinical', 'medical',
      'healthcare', 'hospital', 'clinic', 'laboratory technician',
      'radiologist', 'anesthesiologist', 'pediatrician', 'psychiatrist',
      'medical laboratory', 'health worker', 'midwife', 'optometrist'
    ];
    
    // Build the SQL condition for actual healthcare jobs
    const healthcareConditions = healthcareKeywords.map(keyword => 
      `LOWER(title) LIKE '%${keyword}%'`
    ).join(' OR ');
    
    // Find jobs marked as healthcare that don't match any healthcare keywords
    const suspectJobs = await pool.query(`
      SELECT id, title, company, category
      FROM jobs
      WHERE category = 'healthcare_medical'
      AND NOT (${healthcareConditions})
      LIMIT 20
    `);
    
    if (suspectJobs.rows.length > 0) {
      console.log('\n⚠️ Found non-medical jobs still in healthcare category:');
      for (const job of suspectJobs.rows) {
        console.log(`   ❌ "${job.title}" at ${job.company}`);
        
        // Recategorize based on title
        let newCategory = 'other_general';
        const titleLower = job.title.toLowerCase();
        
        if (titleLower.includes('manager') || titleLower.includes('director')) {
          newCategory = 'management_executive';
        } else if (titleLower.includes('sales') || titleLower.includes('marketing')) {
          newCategory = 'marketing_sales';
        } else if (titleLower.includes('admin') || titleLower.includes('secretary')) {
          newCategory = 'admin_office';
        } else if (titleLower.includes('engineer')) {
          newCategory = 'engineering_technical';
        } else if (titleLower.includes('developer') || titleLower.includes('programmer')) {
          newCategory = 'it_software';
        }
        
        await pool.query(
          'UPDATE jobs SET category = $1 WHERE id = $2',
          [newCategory, job.id]
        );
        console.log(`      → Moved to ${newCategory}`);
      }
    }

    // Check what's actually in healthcare category now
    const healthcareCheck = await pool.query(`
      SELECT COUNT(*) as total,
             COUNT(CASE WHEN ${healthcareConditions} THEN 1 END) as actual_medical
      FROM jobs
      WHERE category = 'healthcare_medical'
    `);
    
    console.log(`\n📊 Healthcare category after fixes:`);
    console.log(`   Total: ${healthcareCheck.rows[0].total} jobs`);
    console.log(`   Actual medical: ${healthcareCheck.rows[0].actual_medical} jobs`);
    
    // Show sample of corrected healthcare jobs
    console.log('\n✅ Sample of correctly categorized healthcare jobs:');
    const correctHealthcare = await pool.query(`
      SELECT title, company, location
      FROM jobs
      WHERE category = 'healthcare_medical'
      AND (${healthcareConditions})
      LIMIT 5
    `);
    
    correctHealthcare.rows.forEach((job, idx) => {
      console.log(`   ${idx + 1}. ${job.title} at ${job.company} (${job.location})`);
    });

    // Commit all changes
    await pool.query('COMMIT');
    console.log('\n✅ All fixes committed successfully!');
    
    // Final summary
    const categorySummary = await pool.query(`
      SELECT category, COUNT(*) as count
      FROM jobs
      GROUP BY category
      ORDER BY count DESC
    `);
    
    console.log('\n📊 Final category distribution:');
    categorySummary.rows.forEach(row => {
      console.log(`   ${row.category}: ${row.count} jobs`);
    });

  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('❌ Error occurred:', error.message);
  } finally {
    await pool.end();
  }
}

// Run the fix
fixMiscategorizedJobs().then(() => {
  console.log('\n✅ Emergency fix complete!');
  process.exit(0);
}).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});