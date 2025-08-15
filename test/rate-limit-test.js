const axios = require('axios');

async function testRateLimit() {
  console.log('🧪 Testing rate limiting...\n');
  
  const testPhone = '2348123456789';
  const baseUrl = 'http://localhost:3000';
  
  // Send 12 rapid messages (should block after 10)
  for (let i = 1; i <= 12; i++) {
    try {
      await axios.post(`${baseUrl}/webhook/ycloud`, {
        type: 'whatsapp.inbound_message.received',
        whatsappInboundMessage: {
          from: testPhone,
          type: 'text',
          text: { body: `Test message ${i}` }
        }
      });
      
      console.log(`✅ Message ${i}: Processed`);
      
    } catch (error) {
      console.log(`❌ Message ${i}: Failed`);
    }
    
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  
  // Check rate limit status
  try {
    const response = await axios.get(`${baseUrl}/admin/rate-limits/${testPhone}`);
    console.log('\n📊 Rate limit stats:', response.data);
  } catch (error) {
    console.log('Error getting stats:', error.message);
  }
}

testRateLimit().catch(console.error);