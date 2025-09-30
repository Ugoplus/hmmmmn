// Enhanced ycloud.js with Interactive Buttons and Improved Response Handling

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

  // 🎯 TYPING INDICATOR
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
        error: error.message
      });
      return false;
    }
  }

  // 🎯 INTERACTIVE BUTTON MESSAGE (NEW)
  async sendInteractiveButtonMessage(to, header, body, buttons, options = {}) {
    try {
      const cleanTo = this.formatPhoneNumber(to);
      
      // WhatsApp allows maximum 3 buttons
      const limitedButtons = buttons.slice(0, 3).map(button => ({
        type: 'reply',
        reply: {
          id: button.id.substring(0, 256), // YCloud limit
          title: button.title.substring(0, 20) // WhatsApp limit for button text
        }
      }));

      const payload = {
        from: this.whatsappNumber,
        to: cleanTo,
        type: 'interactive',
        interactive: {
          type: 'button',
          header: header ? {
            type: 'text',
            text: header.substring(0, 60) // YCloud limit
          } : undefined,
          body: {
            text: body.substring(0, 1024) // YCloud limit
          },
          action: {
            buttons: limitedButtons
          }
        }
      };

      // Remove header if not provided
      if (!header) {
        delete payload.interactive.header;
      }

      logger.info('Sending YCloud interactive button message', { 
        to: cleanTo, 
        header: header || 'No header',
        buttonCount: limitedButtons.length 
      });

      const response = await this.client.post('/v2/whatsapp/messages/sendDirectly', payload);
      
      if (response.status === 200) {
        logger.info('YCloud interactive buttons sent successfully', { 
          to: cleanTo, 
          messageId: response.data.id 
        });
        return response.data.id;
      }
      
      throw new Error(`Unexpected response status: ${response.status}`);
      
    } catch (error) {
      logger.error('YCloud interactive buttons failed', { 
        to, 
        error: error.message,
        status: error.response?.status,
        data: error.response?.data
      });
      
      // Fallback to text message
      const fallbackText = `${header ? header + '\n\n' : ''}${body}\n\n${buttons.map((btn, i) => `${i + 1}. ${btn.title}`).join('\n')}`;
      return await this.sendTextMessage(to, fallbackText);
    }
  }

  // 🎯 INTERACTIVE LIST MESSAGE (ENHANCED)
  async sendInteractiveListMessage(to, header, body, sections, buttonText, options = {}) {
    try {
      const cleanTo = this.formatPhoneNumber(to);
      
      // Validate sections and rows count (WhatsApp limits)
      const validSections = sections.slice(0, 10).map(section => {
        const validRows = section.rows.slice(0, 10).map(row => ({
          id: row.id.substring(0, 200),
          title: row.title.substring(0, 24),
          description: row.description ? row.description.substring(0, 72) : undefined
        }));

        return {
          title: section.title ? section.title.substring(0, 24) : undefined,
          rows: validRows
        };
      });

      // Count total rows
      const totalRows = validSections.reduce((sum, section) => sum + section.rows.length, 0);
      
      if (totalRows === 0) {
        throw new Error('No valid rows provided');
      }

      // WhatsApp allows maximum 10 rows total
      if (totalRows > 10) {
        logger.warn('Too many rows, truncating', { totalRows, limit: 10 });
        let remainingRows = 10;
        validSections.forEach(section => {
          const rowsToTake = Math.min(section.rows.length, remainingRows);
          section.rows = section.rows.slice(0, rowsToTake);
          remainingRows -= rowsToTake;
        });
      }

      const payload = {
        from: this.whatsappNumber,
        to: cleanTo,
        type: 'interactive',
        interactive: {
          type: 'list',
          header: {
            type: 'text',
            text: header.substring(0, 60) // YCloud limit
          },
          body: {
            text: body.substring(0, 1024) // YCloud limit
          },
          action: {
            button: buttonText.substring(0, 20),
            sections: validSections
          }
        }
      };

      logger.info('Sending YCloud interactive list message', { 
        to: cleanTo, 
        header,
        sections: validSections.length,
        rows: validSections.reduce((sum, s) => sum + s.rows.length, 0)
      });

      const response = await this.client.post('/v2/whatsapp/messages/sendDirectly', payload);
      
      if (response.status === 200) {
        logger.info('YCloud interactive list sent successfully', { 
          to: cleanTo, 
          messageId: response.data.id 
        });
        return response.data.id;
      }
      
      throw new Error(`Unexpected response status: ${response.status}`);
      
    } catch (error) {
      logger.error('YCloud interactive list failed', { 
        to,
        error: error.message,
        status: error.response?.status,
        data: error.response?.data
      });
      
      // Fallback to text message
      let fallbackText = `${header}\n\n${body}\n\n`;
      sections.forEach((section, sIndex) => {
        if (section.title) {
          fallbackText += `${section.title}:\n`;
        }
        section.rows.forEach((row, rIndex) => {
          fallbackText += `${sIndex + 1}.${rIndex + 1} ${row.title}\n`;
          if (row.description) {
            fallbackText += `   ${row.description}\n`;
          }
        });
        fallbackText += '\n';
      });
      
      return await this.sendTextMessage(to, fallbackText);
    }
  }

  // 🎯 ENHANCED INTERACTIVE RESPONSE PARSER
// 🎯 ENHANCED INTERACTIVE RESPONSE PARSER
parseInteractiveResponse(message) {
  try {
    logger.debug('Parsing interactive response - full structure', {
      rawMessage: JSON.stringify(message, null, 2).substring(0, 500)
    });

    // Handle different possible structures
    let interactive = message.interactive;
    
    // YCloud webhook structure
    if (!interactive && message.type === 'interactive') {
      interactive = message;
    }
    
    // Nested structure
    if (!interactive && message.message && message.message.interactive) {
      interactive = message.message.interactive;
    }

    if (!interactive) {
      logger.debug('No interactive data found in message');
      return null;
    }

    logger.info('Interactive data found', { 
      type: interactive.type,
      hasButtonReply: !!interactive.button_reply,
      hasListReply: !!interactive.list_reply,
      keys: Object.keys(interactive)
    });

    if (interactive.type === 'button_reply' && interactive.button_reply) {
      const result = {
        type: 'button_reply',
        id: interactive.button_reply.id,
        title: interactive.button_reply.title
      };
      logger.info('Button reply parsed successfully', result);
      return result;
    }

    if (interactive.type === 'list_reply' && interactive.list_reply) {
      const result = {
        type: 'list_reply',
        id: interactive.list_reply.id,
        title: interactive.list_reply.title,
        description: interactive.list_reply.description
      };
      logger.info('List reply parsed successfully', result);
      return result;
    }

    logger.warn('Unknown interactive type or structure', { 
      type: interactive.type,
      interactive: interactive
    });
    return null;

  } catch (err) {
    logger.error('Failed to parse interactive response', {
      error: err.message,
      rawMessage: JSON.stringify(message).substring(0, 300)
    });
    return null;
  }
}

// 🎯 SMART JOB NAVIGATION BUTTONS
async sendJobNavigationButtons(to, currentPage, totalPages, hasSelection = false) {
  try {
    const buttons = [];

      // Previous page button
      if (currentPage > 1) {
        buttons.push({
          id: 'nav_prev',
          title: '⬅️ Previous'
        });
      }
      
      // Next page button  
      if (currentPage < totalPages) {
        buttons.push({
          id: 'nav_next',
          title: '➡️ Next'
        });
      }
      
      // Apply button if user has selections
      if (hasSelection) {
        buttons.push({
          id: 'apply_selected',
          title: '📤 Apply Now'
        });
      }
      
      if (buttons.length === 0) {
        return null; // No buttons needed
      }
      
      const header = `Page ${currentPage} of ${totalPages}`;
      const body = hasSelection ? 
        'Navigate pages or apply to your selected jobs:' : 
        'Navigate through job pages:';
      
      return await this.sendInteractiveButtonMessage(to, header, body, buttons);
      
    } catch (error) {
      logger.error('Job navigation buttons failed', { to, error: error.message });
      return null;
    }
  }

  // 🎯 JOB SELECTION CONFIRMATION BUTTONS
  async sendJobSelectionButtons(to, jobCount, selectedCount) {
    try {
      const buttons = [
        {
          id: 'apply_selected',
          title: `📤 Apply (${selectedCount})`
        },
        {
          id: 'select_more',
          title: '➕ Select More'
        }
      ];
      
      if (selectedCount > 0) {
        buttons.push({
          id: 'clear_selection',
          title: '🗑️ Clear'
        });
      }
      
      const header = 'Job Selection';
      const body = `You have ${selectedCount} job(s) selected out of ${jobCount} available.`;
      
      return await this.sendInteractiveButtonMessage(to, header, body, buttons);
      
    } catch (error) {
      logger.error('Job selection buttons failed', { to, error: error.message });
      return null;
    }
  }

  // 🎯 PAYMENT ACTION BUTTONS
  async sendPaymentActionButtons(to, paymentUrl, jobCount = 0) {
    try {
      const buttons = [
        {
          id: 'pay_now',
          title: '💳 Pay ₦300'
        },
        {
          id: 'show_free_preview',
          title: '👀 Free Preview'
        }
      ];
      
      if (jobCount > 0) {
        buttons.push({
          id: 'search_more',
          title: '🔍 Search More'
        });
      }
      
      const header = 'Payment Required';
      const body = jobCount > 0 ? 
        `Found ${jobCount} jobs! Pay ₦300 to see full details and apply with AI cover letters.` :
        'Pay ₦300 for premium job search with AI-powered applications.';
      
      return await this.sendInteractiveButtonMessage(to, header, body, buttons);
      
    } catch (error) {
      logger.error('Payment action buttons failed', { to, error: error.message });
      // Send text with payment link as fallback
      return await this.sendTextMessage(to, `${body}\n\nPay here: ${paymentUrl}`);
    }
  }

  // 🎯 SMART MESSAGING WITH TYPING
  async sendSmartMessage(to, text, context = {}) {
    const { inboundMessageId, messageType = 'response', urgency = 'normal' } = context;

    let typingDuration;
      
    switch (messageType) {
      case 'search_results':
        typingDuration = 3000;
        break;
      case 'processing':
        typingDuration = 5000;
        break;
      case 'payment_info':
        typingDuration = 2000;
        break;
      case 'instant_response':
        typingDuration = 500;
        break;
      default:
        typingDuration = null;
    }
    
    if (urgency === 'high') {
      typingDuration = typingDuration ? typingDuration * 0.5 : 1000;
    } else if (urgency === 'low') {
      typingDuration = typingDuration ? typingDuration * 1.5 : null;
    }
    
    return await this.sendMessageWithTyping(to, text, inboundMessageId, typingDuration);
  }

  async sendMessageWithTyping(to, text, inboundMessageId = null, typingDuration = null) {
    try {
      if (inboundMessageId) {
        await this.showTypingIndicator(inboundMessageId);
      }

      let delay = 0;
      if (typingDuration === null && text) {
        const typingSpeed = 3.3;
        delay = Math.min(Math.max((text.length / typingSpeed) * 1000, 1000), 25000);
      } else if (typingDuration) {
        delay = Math.min(typingDuration, 25000);
      }

      if (delay > 0) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      return await this.sendTextMessage(to, text);
      
    } catch (error) {
      logger.error('Send message with typing failed', { to, error: error.message });
      return false;
    }
  }

  // 🎯 TEXT MESSAGE (FALLBACK)
  async sendTextMessage(to, text, options = {}) {
    try {
      const cleanTo = this.formatPhoneNumber(to);
      
      if (options.typingDelay) {
        const delay = Math.min(options.typingDelay, 25000);
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

      logger.info('Sending YCloud text message', { to: cleanTo, textLength: text.length });

      const response = await this.client.post('/v2/whatsapp/messages/sendDirectly', payload);
      
      if (response.status === 200) {
        logger.info('YCloud message sent successfully', { to: cleanTo, messageId: response.data.id });
        return true;
      }
      
      return false;
      
    } catch (error) {
      logger.error('YCloud message failed', { to, error: error.message });
      return false;
    }
  }

  // 🎯 DOCUMENT DOWNLOAD (UNCHANGED)
  async downloadDocument(document) {
    try {
      logger.info('Starting YCloud document download', {
        hasLink: !!document.link,
        hasId: !!document.id,
        filename: document.filename
      });

      let fileBuffer;
      let downloadMethod = 'none';

      if (document.link) {
        try {
          const response = await axios.get(document.link, {
            headers: { 'X-API-Key': this.apiKey },
            responseType: 'arraybuffer',
            timeout: 30000,
            maxContentLength: 5 * 1024 * 1024
          });

          fileBuffer = Buffer.from(response.data);
          downloadMethod = 'direct_link';
          
          logger.info('Document downloaded via direct link', {
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
          logger.warn('Direct link download failed', { error: linkError.message });
        }
      }

      if (document.id) {
        try {
          const mediaInfoResponse = await this.client.get(`/v2/whatsapp/media/${document.id}`);
          
          if (mediaInfoResponse.data && mediaInfoResponse.data.url) {
            const response = await axios.get(mediaInfoResponse.data.url, {
              headers: { 'X-API-Key': this.apiKey },
              responseType: 'arraybuffer',
              timeout: 30000,
              maxContentLength: 5 * 1024 * 1024
            });

            fileBuffer = Buffer.from(response.data);
            downloadMethod = 'media_api';
            
            logger.info('Document downloaded via media API', {
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
          logger.error('Media API download failed', { error: apiError.message });
        }
      }

      throw new Error('All YCloud download methods failed');

    } catch (error) {
      logger.error('YCloud document download completely failed', { error: error.message });
      throw error;
    }
  }

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

  formatPhoneNumber(phone) {
    let cleaned = phone.replace(/\D/g, '');
    
    if (cleaned.startsWith('0')) {
      cleaned = '234' + cleaned.substring(1);
    } else if (!cleaned.startsWith('234')) {
      cleaned = '234' + cleaned;
    }
    
    return cleaned;
  }

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