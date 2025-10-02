// services/recruiterDigest.js - Daily digest emails to recruiters

const nodemailer = require('nodemailer');
const dbManager = require('../config/database');
const logger = require('../utils/logger');
const config = require('../config');

class RecruiterDigestService {
  constructor() {
    this.transporter = nodemailer.createTransport({
      host: config.get('smtp.host'),
      port: config.get('smtp.port'),
      secure: false,
      auth: {
        user: config.get('smtp.user'),
        pass: config.get('smtp.pass')
      },
      tls: {
        rejectUnauthorized: false
      }
    });

    // When to send digest (default: 6 PM daily)
    this.digestHour = 18;
  }

  /**
   * Track application for digest (called when email would have been sent)
   */
  async trackForDigest(recruiterEmail, jobId, applicationId, applicantData) {
    try {
      const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

      // Get or create digest record for today
      const result = await dbManager.query(`
        INSERT INTO recruiter_digests (
          recruiter_email, job_id, digest_date, application_ids, applicant_count
        ) VALUES ($1, $2, $3, ARRAY[$4], 1)
        ON CONFLICT (recruiter_email, job_id, digest_date)
        DO UPDATE SET
          application_ids = array_append(recruiter_digests.application_ids, $4),
          applicant_count = recruiter_digests.applicant_count + 1,
          updated_at = NOW()
        RETURNING id
      `, [recruiterEmail, jobId, today, applicationId]);

      // Mark application as included in digest
      await dbManager.query(`
        UPDATE applications
        SET included_in_digest = true, digest_id = $1
        WHERE id = $2
      `, [result.rows[0].id, applicationId]);

      logger.info('Application tracked for digest', {
        recruiterEmail,
        jobId,
        applicationId,
        digestId: result.rows[0].id
      });

      return result.rows[0].id;

    } catch (error) {
      logger.error('Failed to track application for digest', {
        recruiterEmail,
        jobId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Send all pending digests (run daily at scheduled time)
   */
  async sendPendingDigests() {
    try {
      const today = new Date().toISOString().split('T')[0];

      // Get all pending digests for today
      const result = await dbManager.query(`
        SELECT 
          rd.id, rd.recruiter_email, rd.job_id, rd.application_ids, rd.applicant_count,
          j.title as job_title, j.company, j.location
        FROM recruiter_digests rd
        JOIN jobs j ON rd.job_id = j.id
        WHERE rd.digest_date = $1 
          AND rd.email_sent = false
        ORDER BY rd.recruiter_email, j.company
      `, [today]);

      if (result.rows.length === 0) {
        logger.info('No pending digests to send');
        return { sent: 0, failed: 0 };
      }

      logger.info(`Sending ${result.rows.length} recruiter digests`);

      let sent = 0;
      let failed = 0;

      // Process digests
      for (const digest of result.rows) {
        try {
          await this.sendDigestEmail(digest);
          sent++;
        } catch (error) {
          logger.error('Failed to send digest', {
            digestId: digest.id,
            recruiterEmail: digest.recruiter_email,
            error: error.message
          });
          failed++;
        }
      }

      logger.info('Digest sending complete', { sent, failed });

      return { sent, failed };

    } catch (error) {
      logger.error('Failed to send pending digests', {
        error: error.message
      });
      return { sent: 0, failed: 0 };
    }
  }

  /**
   * Send individual digest email
   */
  async sendDigestEmail(digest) {
    try {
      // Get applicant details
      const applicantsResult = await dbManager.query(`
        SELECT 
          a.id, a.applicant_name, a.applicant_email, a.applicant_phone,
          a.cv_text, a.applied_at
        FROM applications a
        WHERE a.id = ANY($1)
        ORDER BY a.applied_at DESC
      `, [digest.application_ids]);

      const applicants = applicantsResult.rows;

      if (applicants.length === 0) {
        logger.warn('No applicants found for digest', { digestId: digest.id });
        return;
      }

      // Get CV files for attachments
      const cvAttachments = await this.prepareAttachments(applicants);

      const emailOptions = {
        from: '"SmartCV Naija Recruitment" <recruit@smartcvnaija.com.ng>',
        to: digest.recruiter_email,
        subject: `Daily Application Summary - ${digest.job_title} (${applicants.length} Applicants)`,
        html: this.generateDigestHTML(digest, applicants),
        text: this.generateDigestText(digest, applicants),
        attachments: cvAttachments
      };

      await this.transporter.sendMail(emailOptions);

      // Mark as sent
      await dbManager.query(`
        UPDATE recruiter_digests
        SET 
          email_sent = true,
          email_sent_at = NOW(),
          email_status = 'sent',
          updated_at = NOW()
        WHERE id = $1
      `, [digest.id]);

      logger.info('Digest email sent successfully', {
        digestId: digest.id,
        recruiterEmail: digest.recruiter_email,
        applicantCount: applicants.length
      });

    } catch (error) {
      // Mark as failed
      await dbManager.query(`
        UPDATE recruiter_digests
        SET email_status = 'failed', updated_at = NOW()
        WHERE id = $1
      `, [digest.id]);

      throw error;
    }
  }

  /**
   * Prepare CV attachments
   */
  async prepareAttachments(applicants) {
    const attachments = [];
    const fs = require('fs');
    const path = require('path');

    for (const applicant of applicants) {
      try {
        // Try to find saved PDF
        const uploadsDir = path.join(__dirname, '../uploads');
        const files = fs.readdirSync(uploadsDir);
        
        // Look for CV file matching applicant
        const cvFile = files.find(f => 
          f.includes(applicant.applicant_phone.replace(/\+/g, '').replace(/\s/g, '_')) ||
          f.includes(applicant.applicant_email.split('@')[0])
        );

        if (cvFile) {
          const filepath = path.join(uploadsDir, cvFile);
          
          attachments.push({
            filename: `${applicant.applicant_name.replace(/\s+/g, '_')}_CV.pdf`,
            path: filepath,
            contentType: 'application/pdf'
          });
        }

      } catch (error) {
        logger.warn('Failed to attach CV', {
          applicantName: applicant.applicant_name,
          error: error.message
        });
      }
    }

    return attachments;
  }

  /**
   * Generate digest HTML email
   */
  generateDigestHTML(digest, applicants) {
    const applicantRows = applicants.map((applicant, index) => `
      <tr style="border-bottom: 1px solid #eee;">
        <td style="padding: 12px; font-weight: bold;">${index + 1}</td>
        <td style="padding: 12px;">
          <strong>${applicant.applicant_name}</strong><br>
          <small style="color: #666;">${applicant.applicant_email}</small><br>
          <small style="color: #666;">${applicant.applicant_phone}</small>
        </td>
        <td style="padding: 12px;">
          <small>${new Date(applicant.applied_at).toLocaleString('en-NG', {
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit'
          })}</small>
        </td>
        <td style="padding: 12px;">
          <a href="#cv-${applicant.id}" style="color: #3498db; text-decoration: none;">View Details</a>
        </td>
      </tr>
    `).join('');

    const applicantDetails = applicants.map((applicant, index) => `
      <div id="cv-${applicant.id}" style="margin: 30px 0; padding: 20px; border: 1px solid #ddd; border-radius: 8px; background: #fafafa;">
        <h3 style="margin-top: 0; color: #2c3e50;">Applicant ${index + 1}: ${applicant.applicant_name}</h3>
        
        <div style="margin: 15px 0;">
          <p style="margin: 5px 0;"><strong>Email:</strong> ${applicant.applicant_email}</p>
          <p style="margin: 5px 0;"><strong>Phone:</strong> ${applicant.applicant_phone}</p>
          <p style="margin: 5px 0;"><strong>Applied:</strong> ${new Date(applicant.applied_at).toLocaleString('en-NG')}</p>
        </div>

        <div style="margin: 20px 0;">
          <h4 style="color: #2c3e50;">CV Summary (First 500 characters):</h4>
          <p style="white-space: pre-wrap; line-height: 1.6; color: #555;">
            ${applicant.cv_text ? applicant.cv_text.substring(0, 500) + '...' : 'CV text not available'}
          </p>
          <p style="font-style: italic; color: #999;">
            📎 Full CV attached as PDF file
          </p>
        </div>
      </div>
    `).join('');

    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Daily Application Summary</title>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 900px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f9f9f9;
        }
        .container {
            background: white;
            border-radius: 8px;
            padding: 30px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 25px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin: 20px 0;
        }
        th {
            background: #f8f9fa;
            padding: 12px;
            text-align: left;
            border-bottom: 2px solid #dee2e6;
            font-weight: 600;
        }
        .footer {
            border-top: 1px solid #eee;
            padding-top: 20px;
            margin-top: 30px;
            color: #666;
            font-size: 0.9em;
            text-align: center;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1 style="margin: 0;">Daily Application Summary</h1>
            <p style="margin: 10px 0 0 0;">
                ${new Date().toLocaleDateString('en-NG', { 
                  weekday: 'long', 
                  year: 'numeric', 
                  month: 'long', 
                  day: 'numeric' 
                })}
            </p>
        </div>

        <div style="background: #e3f2fd; padding: 15px; border-radius: 5px; margin-bottom: 20px;">
            <h2 style="margin: 0 0 10px 0; color: #1976d2;">Position: ${digest.job_title}</h2>
            <p style="margin: 0;"><strong>Company:</strong> ${digest.company}</p>
            <p style="margin: 5px 0 0 0;"><strong>Location:</strong> ${digest.location}</p>
        </div>

        <h3 style="color: #2c3e50;">Total Applications Today: ${applicants.length}</h3>

        <table>
            <thead>
                <tr>
                    <th style="width: 50px;">#</th>
                    <th>Applicant Details</th>
                    <th style="width: 150px;">Applied At</th>
                    <th style="width: 100px;">Action</th>
                </tr>
            </thead>
            <tbody>
                ${applicantRows}
            </tbody>
        </table>

        <h3 style="margin-top: 40px; color: #2c3e50;">Full Applicant Details</h3>
        ${applicantDetails}

        <div class="footer">
            <p><strong>SmartCV Naija</strong> - Professional Recruitment Platform</p>
            <p style="font-size: 0.8em; color: #999;">
                All CVs attached as PDF files. For questions, contact support@smartcvnaija.com.ng
            </p>
        </div>
    </div>
</body>
</html>`;
  }

  /**
   * Generate digest text email
   */
  generateDigestText(digest, applicants) {
    const applicantList = applicants.map((applicant, index) => `
${index + 1}. ${applicant.applicant_name}
   Email: ${applicant.applicant_email}
   Phone: ${applicant.applicant_phone}
   Applied: ${new Date(applicant.applied_at).toLocaleString('en-NG')}
`).join('\n');

    return `
DAILY APPLICATION SUMMARY
${new Date().toLocaleDateString('en-NG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}

Position: ${digest.job_title}
Company: ${digest.company}
Location: ${digest.location}

TOTAL APPLICATIONS TODAY: ${applicants.length}

APPLICANT LIST:
${applicantList}

All CVs are attached as PDF files.

---
SmartCV Naija - Professional Recruitment Platform
For questions: support@smartcvnaija.com.ng
`;
  }

  /**
   * Get digest statistics
   */
  async getDigestStats(dateFrom, dateTo) {
    try {
      const result = await dbManager.query(`
        SELECT 
          COUNT(*) as total_digests,
          SUM(applicant_count) as total_applicants,
          COUNT(CASE WHEN email_sent = true THEN 1 END) as sent_count,
          COUNT(CASE WHEN email_sent = false THEN 1 END) as pending_count
        FROM recruiter_digests
        WHERE digest_date BETWEEN $1 AND $2
      `, [dateFrom, dateTo]);

      return result.rows[0];

    } catch (error) {
      logger.error('Failed to get digest stats', {
        error: error.message
      });
      return null;
    }
  }

  /**
   * Manually trigger digest for testing
   */
  async sendTestDigest(recruiterEmail, jobId) {
    try {
      const today = new Date().toISOString().split('T')[0];

      const result = await dbManager.query(`
        SELECT 
          rd.id, rd.recruiter_email, rd.job_id, rd.application_ids, rd.applicant_count,
          j.title as job_title, j.company, j.location
        FROM recruiter_digests rd
        JOIN jobs j ON rd.job_id = j.id
        WHERE rd.recruiter_email = $1 
          AND rd.job_id = $2
          AND rd.digest_date = $3
      `, [recruiterEmail, jobId, today]);

      if (result.rows.length === 0) {
        throw new Error('No digest found for today');
      }

      await this.sendDigestEmail(result.rows[0]);

      return { success: true };

    } catch (error) {
      logger.error('Failed to send test digest', {
        recruiterEmail,
        jobId,
        error: error.message
      });
      throw error;
    }
  }
}

module.exports = new RecruiterDigestService();