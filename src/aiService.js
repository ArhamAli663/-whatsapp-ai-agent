import { GoogleGenerativeAI } from '@google/generative-ai';
import Groq from 'groq-sdk';
import { CONFIG, SYSTEM_INSTRUCTIONS } from './config.js';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from '@ffmpeg-installer/ffmpeg';
import fs from 'fs';
import path from 'path';

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

try {
  ffmpeg.setFfmpegPath(ffmpegPath.path);
} catch(e) {}

// ── NATURAL VOICE NOTE AUDIO GENERATOR (CONVERTS TO GENUINE WHATSAPP OPUS) ──
export async function generateVoiceBuffer(text) {
  if (!text || !text.trim()) return null;

  const clean = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^#+\s+/gm, '')
    .replace(/[*_~#|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const sentences = clean.match(/[^.!?،\n]+[.!?،\n]*/g) || [clean];
  const chunks = [];
  let currentChunk = '';

  for (const s of sentences) {
    if ((currentChunk + ' ' + s).length < 180) {
      currentChunk = currentChunk ? (currentChunk + ' ' + s) : s;
    } else {
      if (currentChunk) chunks.push(currentChunk.trim());
      currentChunk = s;
    }
  }
  if (currentChunk.trim()) chunks.push(currentChunk.trim());

  const isUrdu = /[\u0600-\u06FF]/.test(clean) || /(hai|hain|kya|aap|main|hoon|karein|batao|shukriya|assalam|walaikum|urdu|website|kaise|python|zaban)/i.test(clean);
  const lang = isUrdu ? 'ur' : 'en';

  // Fetch all TTS chunks in parallel for maximum speed (<1.5s)
  const chunkPromises = chunks.slice(0, 12).map(async (chunk) => {
    try {
      const encoded = encodeURIComponent(chunk);
      const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=${lang}&client=tw-ob`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      if (res.ok) {
        const ab = await res.arrayBuffer();
        return Buffer.from(ab);
      }
    } catch (e) {
      console.warn('[TTS Chunk Error]:', e.message);
    }
    return null;
  });

  const results = await Promise.all(chunkPromises);
  const audioBuffers = results.filter(Boolean);

  if (audioBuffers.length === 0) return null;
  const combinedMp3 = Buffer.concat(audioBuffers);

  // Convert MP3 to WhatsApp native OGG Opus audio
  const tempMp3 = path.resolve(`temp_${Date.now()}_${Math.random().toString(36).substring(7)}.mp3`);
  const tempOgg = path.resolve(`temp_${Date.now()}_${Math.random().toString(36).substring(7)}.ogg`);

  try {
    fs.writeFileSync(tempMp3, combinedMp3);
    await new Promise((resolve, reject) => {
      ffmpeg(tempMp3)
        .toFormat('ogg')
        .audioCodec('libopus')
        .audioChannels(1)
        .audioFrequency(48000)
        .outputOptions(['-c:a libopus', '-b:a 64k', '-vbr on', '-application voip'])
        .save(tempOgg)
        .on('end', resolve)
        .on('error', reject);
    });

    if (fs.existsSync(tempOgg)) {
      const oggBuffer = fs.readFileSync(tempOgg);
      try { fs.unlinkSync(tempMp3); fs.unlinkSync(tempOgg); } catch(e){}
      return { buffer: oggBuffer, mimetype: 'audio/ogg; codecs=opus' };
    }
  } catch (err) {
    console.warn('[FFmpeg Opus Error, fallback to mp3]:', err.message);
    try { if (fs.existsSync(tempMp3)) fs.unlinkSync(tempMp3); if (fs.existsSync(tempOgg)) fs.unlinkSync(tempOgg); } catch(e){}
  }

  return { buffer: combinedMp3, mimetype: 'audio/mp4' };
}

// ── RICH LOCAL FALLBACK ──
function generateSmartLocalReply(chatId, userMessageText) {
  const text = (userMessageText || '').toLowerCase().trim();

  if (text.includes('python') || text.includes('پائیتھن') || text.includes('coding') || text.includes('programming')) {
    return 'Python aik boht hi popular, powerful aur aasan programming language hai. Is ko seekhna boht easy hai kyun ke iska syntax English jesa hota hai. Python Web Development (Django/Flask), Artificial Intelligence, Machine Learning, Data Science, aur Automation bots banane mein sab se zyada use hoti hai. Agar aap Python seekhna chahte hain ya koi custom Python AI Project / Bot banwana chahte hain to hum aap ki mukammal madad kar sakte hain!';
  }
  if (text.includes('salam') || text.includes('assalam') || text.includes('hello') || text.includes('hi')) {
    return 'Walaikum Assalam! 👋 Main Arham ka AI Assistant hoon. Hum Website Development (15,000 PKR), Mobile App (20,000 PKR), aur AI Chatbot (5,000 PKR) banate hain. Aapko kis cheez ke bare mein janna hai ya kya project banwana hai?';
  }
  if (text.includes('website') || text.includes('web')) {
    return 'Zabardast! 🌐 Website Development 15,000 PKR se start hoti hai (Complete Modern Responsive Design + SEO). Aapki website ki kya requirements hain?';
  }
  if (text.includes('app') || text.includes('mobile')) {
    return 'Behtareen! 📱 Mobile App Development (Android & iOS) 20,000 PKR se start hoti hai. Aapko kis type ki application chahiye?';
  }
  if (text.includes('bot') || text.includes('chatbot') || text.includes('ai')) {
    return 'Superb! 🤖 WhatsApp & Web AI Chatbot 5,000 PKR mein banate hain jo 24/7 clients ko auto-reply deta hai. Aapke business ka naam kya hai?';
  }
  if (text.includes('price') || text.includes('rate') || text.includes('cost') || text.includes('kitne')) {
    return 'Hamari services aur rates yeh hain:\n- 🌐 Website Development: 15,000 PKR\n- 📱 Mobile App Development: 20,000 PKR\n- 🤖 AI Chatbot: 5,000 PKR\nAap konsi service mein interested hain?';
  }
  return 'Ji bilkul! Main Arham ka AI Assistant hoon. Main aapke har sawal ka mukammal jawab de sakta hoon aur hum Website, Mobile App aur AI Chatbots develop karte hain. Aapko kis bare mein mazeed janna hai? 🤝';
}

export function cleanWhatsAppText(text) {
  if (!text) return '';
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^#+\s+/gm, '') // Remove ###, ##, # headings
    .replace(/\|/g, ' ') // Remove table pipes
    .replace(/^[-]{3,}$/gm, '') // Remove --- dividers
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── MAIN AI RESPONSE GENERATION ──
export async function generateResponse(chatId, userMessageText, apiKeyOverride = null) {
  const session = getChatSession(chatId);

  const enrichedInstructions = SYSTEM_INSTRUCTIONS + '\n\nIMPORTANT CONVERSATIONAL RULES:\n- Answer ANY topic (e.g. Python, coding, AI, tech, general knowledge) in thorough, natural Roman Urdu or Urdu.\n- Do NOT use "#", "|", or markdown tables in the reply — use clean natural text with emojis and bullet points.\n- If asked for voice or audio, speak naturally and clearly.\n- Business Pricing: Website (15,000 PKR), Mobile App (20,000 PKR), AI Chatbot (5,000 PKR).';

  // 1. Try Groq AI (Ultra-fast GPT-OSS 120B / 20B / Qwen 27B)
  if (groq) {
    const groqModels = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'];
    for (const modelName of groqModels) {
      try {
        const messages = [
          { role: 'system', content: enrichedInstructions },
          ...session.history.map(h => ({
            role: h.role === 'model' ? 'assistant' : 'user',
            content: h.parts[0]?.text || ''
          })),
          { role: 'user', content: userMessageText }
        ];

        const completion = await groq.chat.completions.create({
          model: modelName,
          messages,
          temperature: 0.7,
          max_tokens: 600,
        });

        let reply = completion.choices[0]?.message?.content?.trim();
        if (reply) {
          reply = cleanWhatsAppText(reply);
          updateChatHistory(chatId, 'user', userMessageText);
          updateChatHistory(chatId, 'model', reply);
          return reply;
        }
      } catch (groqErr) {
        console.warn(`[Groq Notice] ${modelName}:`, groqErr.message);
      }
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
          systemInstruction: enrichedInstructions,
          generationConfig: { temperature: 0.7, maxOutputTokens: 600 }
        });
        const chat = model.startChat({ history: session.history });
        const result = await chat.sendMessage(userMessageText);
        const response = await result.response;
        let botReply = response.text() ? response.text().trim() : null;
        if (botReply) {
          botReply = cleanWhatsAppText(botReply);
          updateChatHistory(chatId, 'user', userMessageText);
          updateChatHistory(chatId, 'model', botReply);
          return botReply;
        }
      } catch (error) {
        console.warn(`[Gemini Notice]: ${modelName}: ${error.message.substring(0, 80)}`);
      }
    }
  }

  // 3. Fallback to rich local logic
  const localReply = cleanWhatsAppText(generateSmartLocalReply(chatId, userMessageText));
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
