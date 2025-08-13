const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

class PaystackService {

async initializePayment(identifier, reference, email) {
  try {
    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email,
        amount: config.get('paystack.amount'),
        reference,
        // ✅ CHANGED: Point to success page, not webhook
        callback_url: `${config.get('baseUrl')}/payment/success?ref=${reference}`
      },
      {
        headers: {
          Authorization: `Bearer ${config.get('paystack.secret')}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return response.data.data.authorization_url;
  } catch (error) {
    logger.error('Paystack initialization error', { error });
    throw error;
  }
}


  async verifyPayment(reference) {
    try {
      const response = await axios.get(
        `https://api.paystack.co/transaction/verify/${reference}`,
        {
          headers: {
            Authorization: `Bearer ${config.get('paystack.secret')}`,
            'Content-Type': 'application/json'
          }
        }
      );
      return response.data.data.status === 'success';
    } catch (error) {
      logger.error('Paystack verification error', { error });
      return false;
    }
  }
}

module.exports = new PaystackService();
