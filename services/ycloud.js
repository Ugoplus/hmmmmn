// services/ycloud.js - CORRECTED with actual YCloud document methods

const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

class YCloudService {
  constructor() {
    this.apiKey = config.get('ycloud.apiKey');
    this.baseUrl = config.get('ycloud.baseUrl');
    this.whatsappNumber = config.get('ycloud.whatsappNumber');
    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'X-API-Key': this.apiKey,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });
  }

  // Send text message - ACTUAL YCloud format
  async sendTextMessage(to, text) {
    try {
      const cleanTo = this.formatPhoneNumber(to);
      
      const payload = {
        from: this.whatsappNumber,
        to: cleanTo,
        type: 'text',
        text: {
          body: text
        }
      };

      logger.info('Sending YCloud message', { to: cleanTo, textLength: text.length });

      const response = await this.client.post('/v2/whatsapp/messages/sendDirectly', payload);
      
      if (response.status === 200) {
        logger.info('YCloud message sent successfully', { 
          to: cleanTo, 
          messageId: response.data.id 
        });
        return true;
      }
      
      return false;
      
    } catch (error) {
      logger.error('YCloud message failed', { 
        to, 
        error: error.message,
        status: error.response?.status,
        data: error.response?.data
      });
      return false;
    }
  }

  // CORRECTED: Download document with 2 actual YCloud methods
  async downloadDocument(document) {
    try {
      logger.info('Starting YCloud document download', {
        hasLink: !!document.link,
        hasId: !!document.id,
        filename: document.filename
      });

      let fileBuffer;
      let downloadMethod = 'none';

      // Method 1: Direct link with X-API-Key header (PRIMARY)
      if (document.link) {
        try {
          logger.info('Attempting direct link download', { link: document.link });
          
          const response = await axios.get(document.link, {
            headers: {
              'X-API-Key': this.apiKey  // CRITICAL: Required by YCloud
            },
            responseType: 'arraybuffer',
            timeout: 30000,
            maxContentLength: 5 * 1024 * 1024 // 5MB limit
          });

          fileBuffer = Buffer.from(response.data);
          downloadMethod = 'direct_link';
          
          logger.info('✅ Document downloaded via direct link', {
            size: fileBuffer.length,
            filename: document.filename
          });

          return {
            buffer: fileBuffer,
            filename: document.filename,
            mimeType: response.headers['content-type'] || document.mime_type,
            size: fileBuffer.length,
            method: downloadMethod
          };

        } catch (linkError) {
          logger.warn('Direct link download failed', { 
            error: linkError.message,
            status: linkError.response?.status
          });
          // Continue to Method 2
        }
      }

      // Method 2: Media ID API (FALLBACK)
      if (document.id) {
        try {
          logger.info('Attempting media ID download', { mediaId: document.id });
          
          // First get media info
          const mediaInfoResponse = await this.client.get(`/v2/whatsapp/media/${document.id}`);
          
          if (mediaInfoResponse.data && mediaInfoResponse.data.url) {
            const mediaUrl = mediaInfoResponse.data.url;
            
            const response = await axios.get(mediaUrl, {
              headers: {
                'X-API-Key': this.apiKey
              },
              responseType: 'arraybuffer',
              timeout: 30000,
              maxContentLength: 5 * 1024 * 1024
            });

            fileBuffer = Buffer.from(response.data);
            downloadMethod = 'media_api';
            
            logger.info('✅ Document downloaded via media API', {
              size: fileBuffer.length,
              filename: document.filename
            });

            return {
              buffer: fileBuffer,
              filename: document.filename,
              mimeType: response.headers['content-type'] || document.mime_type,
              size: fileBuffer.length,
              method: downloadMethod
            };
          }

        } catch (apiError) {
          logger.error('Media API download failed', { 
            error: apiError.message,
            status: apiError.response?.status
          });
        }
      }

      // Both methods failed
      throw new Error('All YCloud download methods failed');

    } catch (error) {
      logger.error('YCloud document download completely failed', {
        error: error.message,
        document: {
          hasLink: !!document.link,
          hasId: !!document.id,
          filename: document.filename
        }
      });
      throw error;
    }
  }

  // Validate file type and size
  validateDocument(document, buffer) {
    const allowedTypes = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword'
    ];

    const mimeType = document.mime_type;
    
    if (!allowedTypes.includes(mimeType)) {
      throw new Error(`Unsupported file type: ${mimeType}. Please send PDF or DOCX files only.`);
    }

    if (buffer.length > 5 * 1024 * 1024) {
      throw new Error(`File too large: ${Math.round(buffer.length / 1024 / 1024)}MB. Please send files smaller than 5MB.`);
    }

    if (buffer.length < 100) {
      throw new Error('File is too small to be a valid document.');
    }

    return true;
  }

  // Format phone number for YCloud
  formatPhoneNumber(phone) {
    let cleaned = phone.replace(/\D/g, '');
    
    if (cleaned.startsWith('0')) {
      cleaned = '234' + cleaned.substring(1);
    } else if (!cleaned.startsWith('234')) {
      cleaned = '234' + cleaned;
    }
    
    return cleaned;
  }

  // Set webhook URL (call once during setup)
  async setWebhook(webhookUrl) {
    try {
      const payload = {
        url: webhookUrl,
        events: ['whatsapp.inbound_message.received', 'whatsapp.message.updated']
      };

      const response = await this.client.post('/v2/webhooks', payload);
      logger.info('YCloud webhook set successfully', { webhookUrl });
      return response.data;
      
    } catch (error) {
      logger.error('Failed to set YCloud webhook', { webhookUrl, error: error.message });
      throw error;
    }
  }

  // Get account info (for debugging)
  async getAccountInfo() {
    try {
      const response = await this.client.get('/v2/whatsapp/businessAccounts');
      return response.data;
    } catch (error) {
      logger.error('Failed to get YCloud account info', { error: error.message });
      throw error;
    }
  }
}

module.exports = new YCloudService();