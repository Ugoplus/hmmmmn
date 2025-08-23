// services/ycloud.js - Enhanced with typing indicators

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

  // 🎯 NEW: Show typing indicator and mark as read
  async showTypingIndicator(inboundMessageId) {
    try {
      logger.info('Showing typing indicator', { messageId: inboundMessageId });

      const response = await this.client.post(
        `/v2/whatsapp/inboundMessages/${inboundMessageId}/typingIndicator`
      );
      
      if (response.status === 200) {
        logger.info('Typing indicator sent successfully', { messageId: inboundMessageId });
        return true;
      }
      
      return false;
      
    } catch (error) {
      logger.error('Failed to show typing indicator', { 
        messageId: inboundMessageId,
        error: error.message,
        status: error.response?.status,
        data: error.response?.data
      });
      return false;
    }
  }

  // Enhanced send text message with optional delay for natural feel
  async sendTextMessage(to, text, options = {}) {
    try {
      const cleanTo = this.formatPhoneNumber(to);
      
      // Add natural delay if requested (simulates human typing speed)
      if (options.typingDelay) {
        const delay = Math.min(options.typingDelay, 25000); // Max 25 seconds per YCloud docs
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      
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

  // 🎯 NEW: Send message with automatic typing indicator
  async sendMessageWithTyping(to, text, inboundMessageId = null, typingDuration = null) {
    try {
      // Show typing indicator if we have the inbound message ID
      if (inboundMessageId) {
        await this.showTypingIndicator(inboundMessageId);
      }

      // Calculate natural typing delay based on message length
      let delay = 0;
      if (typingDuration === null && text) {
        // Simulate human typing: ~40 WPM = 200 chars/minute = 3.3 chars/second
        const typingSpeed = 3.3; // characters per second
        delay = Math.min(Math.max((text.length / typingSpeed) * 1000, 1000), 25000); // 1-25 seconds
      } else if (typingDuration) {
        delay = Math.min(typingDuration, 25000);
      }

      // Wait for natural typing delay
      if (delay > 0) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      // Send the actual message
      return await this.sendTextMessage(to, text);
      
    } catch (error) {
      logger.error('Send message with typing failed', { 
        to, 
        error: error.message 
      });
      return false;
    }
  }

  // 🎯 NEW: Smart typing for different message types
  async sendSmartMessage(to, text, context = {}) {
    const { inboundMessageId, messageType = 'response', urgency = 'normal' } = context;
    
    let typingDuration;
    
    // Different typing durations based on message context
    switch (messageType) {
      case 'search_results':
        typingDuration = 3000; // 3 seconds for search
        break;
      case 'processing':
        typingDuration = 5000; // 5 seconds for processing
        break;
      case 'payment_info':
        typingDuration = 2000; // 2 seconds for payment info
        break;
      case 'instant_response':
        typingDuration = 500; // 0.5 seconds for quick replies
        break;
      default:
        typingDuration = null; // Auto-calculate based on text length
    }
    
    // Adjust for urgency
    if (urgency === 'high') {
      typingDuration = typingDuration ? typingDuration * 0.5 : 1000;
    } else if (urgency === 'low') {
      typingDuration = typingDuration ? typingDuration * 1.5 : null;
    }
    
    return await this.sendMessageWithTyping(to, text, inboundMessageId, typingDuration);
  }

  // Download document (unchanged)
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
              'X-API-Key': this.apiKey
            },
            responseType: 'arraybuffer',
            timeout: 30000,
            maxContentLength: 5 * 1024 * 1024
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
        }
      }

      // Method 2: Media ID API (FALLBACK)
      if (document.id) {
        try {
          logger.info('Attempting media ID download', { mediaId: document.id });
          
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

  // Validate file type and size (unchanged)
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

  // Format phone number (unchanged)
  formatPhoneNumber(phone) {
    let cleaned = phone.replace(/\D/g, '');
    
    if (cleaned.startsWith('0')) {
      cleaned = '234' + cleaned.substring(1);
    } else if (!cleaned.startsWith('234')) {
      cleaned = '234' + cleaned;
    }
    
    return cleaned;
  }

  // Set webhook URL (unchanged)
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

  // Get account info (unchanged)
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