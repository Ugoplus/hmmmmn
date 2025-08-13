const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const logger = require('../utils/logger');
const redis = require('../config/redis');

class CVCleanupService {
  constructor() {
    this.uploadsDir = path.join(__dirname, '../Uploads');
    this.maxFileAge = 7;
    this.maxDirSize = 500;
    
    if (!fs.existsSync(this.uploadsDir)) {
      fs.mkdirSync(this.uploadsDir, { recursive: true });
      logger.info('Created Uploads directory');
    }
  }

  getStorageStatus() {
    try {
      if (!fs.existsSync(this.uploadsDir)) {
        return {
          exists: false,
          files: 0,
          totalSize: 0,
          totalSizeMB: 0,
          oldestFile: null,
          newestFile: null
        };
      }

      const files = fs.readdirSync(this.uploadsDir);
      let totalSize = 0;
      let oldestFile = null;
      let newestFile = null;
      let oldestTime = Infinity;
      let newestTime = 0;

      const fileDetails = files.map(file => {
        const filePath = path.join(this.uploadsDir, file);
        const stats = fs.statSync(filePath);
        totalSize += stats.size;

        if (stats.birthtime.getTime() < oldestTime) {
          oldestTime = stats.birthtime.getTime();
          oldestFile = { name: file, date: stats.birthtime };
        }

        if (stats.birthtime.getTime() > newestTime) {
          newestTime = stats.birthtime.getTime();
          newestFile = { name: file, date: stats.birthtime };
        }

        return {
          name: file,
          size: stats.size,
          sizeKB: Math.round(stats.size / 1024),
          created: stats.birthtime,
          modified: stats.mtime,
          ageInDays: Math.floor((Date.now() - stats.birthtime.getTime()) / (1000 * 60 * 60 * 24))
        };
      });

      return {
        exists: true,
        files: files.length,
        totalSize: totalSize,
        totalSizeMB: Math.round(totalSize / 1024 / 1024 * 100) / 100,
        oldestFile,
        newestFile,
        fileDetails: fileDetails.sort((a, b) => b.created - a.created),
        needsCleanup: this.needsCleanup(totalSize, fileDetails)
      };

    } catch (error) {
      logger.error('Error getting storage status', { error: error.message });
      return { error: error.message };
    }
  }

  needsCleanup(totalSize, fileDetails) {
    const totalSizeMB = totalSize / 1024 / 1024;
    const hasOldFiles = fileDetails.some(file => file.ageInDays > this.maxFileAge);
    const oversized = totalSizeMB > this.maxDirSize;

    return {
      needed: hasOldFiles || oversized,
      reasons: {
        hasOldFiles,
        oversized,
        oldFileCount: fileDetails.filter(f => f.ageInDays > this.maxFileAge).length,
        currentSizeMB: Math.round(totalSizeMB * 100) / 100,
        maxSizeMB: this.maxDirSize
      }
    };
  }

  async cleanupOldFiles(dryRun = false) {
    const status = this.getStorageStatus();
    
    if (!status.exists) {
      return { deleted: 0, saved: 0, errors: [] };
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.maxFileAge);

    const filesToDelete = status.fileDetails.filter(file => 
      file.created < cutoffDate
    );

    const results = {
      deleted: 0,
      savedSpace: 0,
      errors: [],
      deletedFiles: []
    };

    for (const file of filesToDelete) {
      try {
        const filePath = path.join(this.uploadsDir, file.name);
        
        if (dryRun) {
          logger.info(`[DRY RUN] Would delete: ${file.name} (${file.sizeKB}KB, ${file.ageInDays} days old)`);
        } else {
          fs.unlinkSync(filePath);
          results.deleted++;
          results.savedSpace += file.size;
          results.deletedFiles.push({
            name: file.name,
            size: file.sizeKB,
            age: file.ageInDays
          });
          
          logger.info(`Deleted old CV: ${file.name}`, {
            size: file.sizeKB,
            ageInDays: file.ageInDays
          });
        }
      } catch (error) {
        results.errors.push(`Failed to delete ${file.name}: ${error.message}`);
        logger.error(`Failed to delete CV file: ${file.name}`, { error: error.message });
      }
    }

    return results;
  }

  getUserFiles(phone) {
    const status = this.getStorageStatus();
    
    if (!status.exists) return [];

    return status.fileDetails.filter(file => 
      file.name.startsWith(phone.toString())
    );
  }

  async getRedisStatus() {
    try {
      const keys = await redis.keys('cv:*');
      const results = [];

      for (const key of keys) {
        const phone = key.replace('cv:', '');
        const cvText = await redis.get(key);
        const ttl = await redis.ttl(key);
        
        results.push({
          phone,
          hasText: !!cvText,
          textLength: cvText ? cvText.length : 0,
          expiresIn: ttl > 0 ? `${Math.round(ttl / 3600)}h ${Math.round((ttl % 3600) / 60)}m` : 'No expiry'
        });
      }

      return {
        totalUsers: results.length,
        users: results.sort((a, b) => b.textLength - a.textLength)
      };
    } catch (error) {
      logger.error('Error getting Redis status', { error: error.message });
      return { error: error.message };
    }
  }

  scheduleCleanup() {
    cron.schedule('0 3 * * *', async () => {
      logger.info('Starting scheduled CV cleanup');
      
      try {
        const results = await this.cleanupOldFiles();
        
        if (results.deleted > 0) {
          logger.info('Scheduled cleanup completed', {
            deleted: results.deleted,
            savedSpaceMB: Math.round(results.savedSpace / 1024 / 1024 * 100) / 100,
            errors: results.errors.length
          });
        }

      } catch (error) {
        logger.error('Scheduled cleanup failed', { error: error.message });
      }
    });

    logger.info('CV cleanup scheduled for 3:00 AM daily');
  }
}

module.exports = new CVCleanupService();
