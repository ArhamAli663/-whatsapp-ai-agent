import { GoogleGenerativeAI } from '@google/generative-ai';
import Groq from 'groq-sdk';
import { CONFIG, SYSTEM_INSTRUCTIONS } from './config.js';

// Conversation memory
const chatSessions = new Map();

function getChatSession(chatId) {
  if (!chatSessions.has(chatId)) {
    chatSessions.set(chatId, {
      history: [],
      customerName: null,
      selectedService: null,
      lang: 'ur',
    });
  }
  return chatSessions.get(chatId);
}

const groqApiKey = process.env.GROQ_KEY || process.env.GROQ_API_KEY || CONFIG.groqApiKey || '';
const groq = groqApiKey ? new Groq({ apiKey: groqApiKey }) : null;

function getGenAIClient(apiKeyOverride) {
  const apiKey = apiKeyOverride || CONFIG.geminiApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim() === '' || apiKey.includes('your_gemini_api_key')) return null;
  return new GoogleGenerativeAI(apiKey.trim());
}

function updateChatHistory(chatId, role, text) {
  const session = getChatSession(chatId);
  session.history.push({ role: role === 'user' ? 'user' : 'model', parts: [{ text }] });
  if (session.history.length > 20) {
    session.history = session.history.slice(session.history.length - 20);
  }
}

// ── GROQ WHISPER VOICE TRANSCRIPTION ──
export async function transcribeVoice(audioBuffer, mimeType = 'audio/ogg') {
  if (!groq) {
    console.warn('[Voice] Groq API key missing for Whisper transcription.');
    return null;
  }
  try {
    const file = new File([audioBuffer], 'voice_note.ogg', { type: mimeType });
    const transcription = await groq.audio.transcriptions.create({
      file,
      model: 'whisper-large-v3',
      language: 'ur', // Supports Urdu, Roman Urdu & English auto-mix
      temperature: 0.0,
    });
    return transcription?.text ? transcription.text.trim() : null;
  } catch (err) {
    console.error('[Groq Whisper Error]:', err.message);
    return null;
  }
}

// ── SMART LOCAL FALLBACK ──
function generateSmartLocalReply(chatId, userMessageText) {
  const text = (userMessageText || '').toLowerCase().trim();

  if (text.includes('salam') || text.includes('assalam') || text.includes('hello') || text.includes('hi')) {
    return `Walaikum Assalam! 👋 Main Arham ka AI Assistant hoon. Hum Website Development (15,000 PKR), Mobile App (20,000 PKR), aur AI Chatbot (5,000 PKR) banate hain. Aapko kya chahiye?`;
  }
  if (text.includes('website') || text.includes('web')) {
    return `Zabardast! 🌐 Website Development 15,000 PKR se start hoti hai (Complete Modern Responsive Design + SEO). Aapki requirements kya hain?`;
  }
  if (text.includes('app') || text.includes('mobile')) {
    return `Behtareen! 📱 Mobile App Development (Android & iOS) 20,000 PKR se start hoti hai. Aapko kis type ki application chahiye?`;
  }
  if (text.includes('bot') || text.includes('chatbot') || text.includes('ai')) {
    return `Superb! 🤖 WhatsApp & Web AI Chatbot 5,000 PKR mein banate hain jo 24/7 clients ko auto-reply deta hai. Aapke business ka naam kya hai?`;
  }
  if (text.includes('price') || text.includes('rate') || text.includes('cost') || text.includes('kitne')) {
    return `Hamari services aur rates yeh hain:\n- 🌐 Website Development: 15,000 PKR\n- 📱 Mobile App Development: 20,000 PKR\n- 🤖 AI Chatbot: 5,000 PKR\nAap konsi service mein interested hain?`;
  }
  return `Ji bilkul! Main Arham ka AI Assistant hoon. Hum Website, Mobile App aur AI Chatbots develop karte hain. Aapko kis project ke liye help chahiye? 🤝`;
}

// ── MAIN AI RESPONSE GENERATION ──
export async function generateResponse(chatId, userMessageText, apiKeyOverride = null) {
  const session = getChatSession(chatId);

  // 1. Try Groq AI (Ultra-fast Llama 3.3 70B & Llama 3.1)
  if (groq) {
    try {
      const messages = [
        { role: 'system', content: SYSTEM_INSTRUCTIONS },
        ...session.history.map(h => ({
          role: h.role === 'model' ? 'assistant' : 'user',
          content: h.parts[0]?.text || ''
        })),
        { role: 'user', content: userMessageText }
      ];

      const completion = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages,
        temperature: 0.7,
        max_tokens: 300,
      });

      const reply = completion.choices[0]?.message?.content?.trim();
      if (reply) {
        updateChatHistory(chatId, 'user', userMessageText);
        updateChatHistory(chatId, 'model', reply);
        return reply;
      }
    } catch (groqErr) {
      console.warn('[Groq Notice]:', groqErr.message);
    }
  }

  // 2. Try Google Gemini
  const genAI = getGenAIClient(apiKeyOverride);
  if (genAI) {
    const modelsToTry = ['gemini-1.5-flash', 'gemini-2.0-flash'];
    for (const modelName of modelsToTry) {
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          systemInstruction: SYSTEM_INSTRUCTIONS,
          generationConfig: { temperature: 0.7, maxOutputTokens: 300 }
        });
        const chat = model.startChat({ history: session.history });
        const result = await chat.sendMessage(userMessageText);
        const response = await result.response;
        const botReply = response.text() ? response.text().trim() : null;
        if (botReply) {
          updateChatHistory(chatId, 'user', userMessageText);
          updateChatHistory(chatId, 'model', botReply);
          return botReply;
        }
      } catch (error) {
        console.warn(`[Gemini Notice]: ${modelName}: ${error.message.substring(0, 80)}`);
      }
    }
  }

  // 3. Fallback to smart local logic
  const localReply = generateSmartLocalReply(chatId, userMessageText);
  updateChatHistory(chatId, 'user', userMessageText);
  updateChatHistory(chatId, 'model', localReply);
  return localReply;
}

export async function testAiPrompt(promptText) {
  return generateSmartLocalReply('test-preview', promptText);
}

export function clearChatHistory(chatId) {
  chatSessions.delete(chatId);
}
