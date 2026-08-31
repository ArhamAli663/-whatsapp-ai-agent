import dotenv from 'dotenv';
import { generateResponse, clearChatHistory } from './aiService.js';
dotenv.config();

async function runTests() {
  console.log('=== Closing & Farewell Test ===\n');

  const chatId = 'test-closing-flow';
  clearChatHistory(chatId);
  const msgs = [
    'Assalam o Alaikum',
    'Website banwani ha price batai',
    'Mera name Ali ha',
    'Restaurant website banwani ha',
    'Okay',
    'Nahi koi sawal nahi', // ← The problem phrase
  ];

  for (const m of msgs) {
    const r = await generateResponse(chatId, m);
    console.log(`👤 "${m}"\n🤖 "${r}"\n${'─'.repeat(50)}`);
  }
}

runTests();
