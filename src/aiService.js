import { GoogleGenerativeAI } from '@google/generative-ai';
import Groq from 'groq-sdk';
import { CONFIG, SYSTEM_INSTRUCTIONS } from './config.js';
import fs from 'fs';
import path from 'path';

// Optional dynamic modules for voice generation (won't crash if uninstalled)
let ffmpeg = null;
let ffmpegPath = null;
let MsEdgeTTS = null;
let OUTPUT_FORMAT = null;

try {
  const fModule = await import('fluent-ffmpeg');
  ffmpeg = fModule.default || fModule;
  const pModule = await import('@ffmpeg-installer/ffmpeg');
  ffmpegPath = pModule.default || pModule;
  if (ffmpeg && ffmpegPath?.path) ffmpeg.setFfmpegPath(ffmpegPath.path);
} catch (e) {}

try {
  const ttsModule = await import('msedge-tts');
  MsEdgeTTS = ttsModule.MsEdgeTTS;
  OUTPUT_FORMAT = ttsModule.OUTPUT_FORMAT;
} catch (e) {}

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

// ── VOICE TRANSCRIPTION PHONETIC NORMALIZER ──
export function normalizeVoiceTranscript(text) {
  if (!text) return '';
  return text
    .replace(/فلیڈر|فلیٹر|فلیٹڑ|فلیتر|فلیدر|fleeder|flider|fletter/gi, 'Flutter (فلٹر)')
    .replace(/پائی\s*تھان|پائی\s*تھن|پائتھان|paython|paitan/gi, 'Python (پائتھن)')
    .replace(/سی\s*پلس|سی\s*پلس\s*پلس|see\s*plus/gi, 'C++')
    .replace(/جاوا\s*سکرپٹ|جاواسکرپٹ/gi, 'JavaScript')
    .replace(/کوٹلن|کوٹ\s*لن|cotlin/gi, 'Kotlin')
    .replace(/ری\s*ایکٹ|ریایکٹ/gi, 'React')
    .replace(/چیٹ\s*باٹ|چٹ\s*باٹ|چٹباٹ|چیٹباٹ/gi, 'AI Chatbot')
    .replace(/ویب\s*سائٹ|ویبسائٹ|ویپ\s*سائٹ|vapsite/gi, 'Website')
    .trim();
}

// ── GROQ WHISPER VOICE TRANSCRIPTION (HIGH-ACCURACY NOISE & ACCENT ADAPTATION) ──
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
      language: 'ur',
      prompt: 'یہ پاکستانی اردو میں بات چیت ہے: فلٹر، پائتھن، جاوا، سی پلس پلس، ویب سائٹ، موبائل ایپ، اے آئی چیٹ باٹ، ارہم، قیمت، کورس، پروگرامنگ، سوفٹ ویئر، اینڈرائیڈ، ری ایکٹ۔',
      temperature: 0.1,
      response_format: 'json',
    });
    const rawText = transcription?.text ? transcription.text.trim() : null;
    return rawText ? normalizeVoiceTranscript(rawText) : null;
  } catch (err) {
    console.error('[Groq Whisper Error]:', err.message);
    try {
      const file = new File([audioBuffer], 'voice_note.ogg', { type: mimeType });
      const fallback = await groq.audio.transcriptions.create({
        file,
        model: 'whisper-large-v3-turbo',
        response_format: 'text',
      });
      const rawText = typeof fallback === 'string' ? fallback.trim() : fallback?.text?.trim();
      return rawText ? normalizeVoiceTranscript(rawText) : null;
    } catch (e) {
      return null;
    }
  }
}

function prepareSpeechTextForClarity(text) {
  if (!text) return '';
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/^#+\s+/gm, '')
    .replace(/[*_~#|]/g, ' ')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/C\+\+/gi, 'سی پلس پلس')
    .replace(/\bFlutter\b/gi, 'فلٹر')
    .replace(/\bPython\b/gi, 'پائتھن')
    .replace(/\bJavaScript\b/gi, 'جاوا اسکرپٹ')
    .replace(/\bJava\b/gi, 'جاوا')
    .replace(/\bKotlin\b/gi, 'کوٹلن')
    .replace(/\bReact\b/gi, 'ری ایکٹ')
    .replace(/\bWebsite\b/gi, 'ویب سائٹ')
    .replace(/\bWebsites\b/gi, 'ویب سائٹس')
    .replace(/\bApps?\b/gi, 'ایپ')
    .replace(/\bFrontend\b/gi, 'فرنٹ اینڈ')
    .replace(/\bBackend\b/gi, 'بیک اینڈ')
    .replace(/\bDatabase\b/gi, 'ڈیٹا بیس')
    .replace(/\bAI\b/g, 'اے آئی')
    .replace(/\bAPI\b/g, 'اے پی آئی')
    .replace(/\bUI\b/g, 'یو آئی')
    .replace(/\bUX\b/g, 'یو ایکس')
    .replace(/\bPKR\b/gi, 'روپے')
    .replace(/\b15,000\b/g, 'پندرہ ہزار')
    .replace(/\b20,000\b/g, 'بیس ہزار')
    .replace(/\b5,000\b/g, 'پانچ ہزار')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── VOICE NOTE GENERATION (SAFE & ROBUST) ──
export async function generateVoiceBuffer(text) {
  if (!text || !text.trim() || !MsEdgeTTS || !ffmpeg) return null;

  let speechText = prepareSpeechTextForClarity(text);
  if (speechText.length > 2500) speechText = speechText.substring(0, 2500);

  const tempMp3 = path.resolve(`temp_${Date.now()}_${Math.random().toString(36).substring(7)}.mp3`);
  const tempOgg = path.resolve(`temp_${Date.now()}_${Math.random().toString(36).substring(7)}.ogg`);

  try {
    const isEnglishOnly = /^[a-zA-Z0-9\s.,!?'"()_@#$%&*+-]+$/.test(speechText) && !/(hai|hain|kya|aap|main|hoon|karein|batao|shukriya|assalam|walaikum|urdu)/i.test(speechText);
    const voiceName = isEnglishOnly ? 'en-IN-NeerjaNeural' : 'ur-PK-UzmaNeural';

    const tts = new MsEdgeTTS();
    await tts.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const readable = tts.toStream(speechText);
    const stream = readable.audioStream || readable;
    const cBufs = [];
    for await (const c of stream) {
      cBufs.push(c);
    }
    const mp3Buf = Buffer.concat(cBufs);

    if (mp3Buf && mp3Buf.length > 500) {
      fs.writeFileSync(tempMp3, mp3Buf);
      await new Promise((resolve, reject) => {
        ffmpeg(tempMp3)
          .toFormat('ogg')
          .audioCodec('libopus')
          .audioChannels(1)
          .audioFrequency(48000)
          .outputOptions(['-c:a libopus', '-b:a 96k', '-vbr on', '-application voip'])
          .save(tempOgg)
          .on('end', resolve)
          .on('error', reject);
      });

      if (fs.existsSync(tempOgg)) {
        const oggBuffer = fs.readFileSync(tempOgg);
        try { fs.unlinkSync(tempMp3); fs.unlinkSync(tempOgg); } catch (e) {}
        return { buffer: oggBuffer, mimetype: 'audio/ogg; codecs=opus' };
      }
    }
  } catch (edgeErr) {
    console.warn('[Voice Gen Notice]:', edgeErr.message);
  } finally {
    try { if (fs.existsSync(tempMp3)) fs.unlinkSync(tempMp3); } catch (e) {}
    try { if (fs.existsSync(tempOgg)) fs.unlinkSync(tempOgg); } catch (e) {}
  }

  return null;
}

// ── RICH LOCAL FALLBACK ──
function generateSmartLocalReply(chatId, userMessageText) {
  const text = (userMessageText || '').toLowerCase().trim();

  if (text.includes('c++') || text.includes('سی پلس') || text.includes('cpp')) {
    return 'C++ aik boht hi powerful, fast aur high-performance programming language hai jise Bjarne Stroustrup ne 1979 mein develop kiya tha. Ye C language ka extended version hai jisme Object-Oriented Programming (OOP) ke features shamil hain.\n\n• Speed & Performance: C++ direct hardware ke qareeb kaam karti hai is liye ye boht fast hai.\n• Applications: Gaming Engines (Unreal Engine), Operating Systems (Windows, Mac kernels), Web Browsers, aur Financial Trading Systems mein use hoti hai.\n• Core Concepts: Classes, Objects, Inheritance, Polymorphism, Pointers aur Memory Management.\n\nAgar aap C++ par koi project banana chahte hain to hum aapki mukammal madad kar sakte hain!';
  }
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
  return 'Ji bilkul! Main Arham ka AI Assistant hoon. Main aapke har sawal ka mukammal aur detail mein jawab de sakta hoon aur hum Website, Mobile App aur AI Chatbots develop karte hain. Aapko kis bare mein mazeed janna hai? 🤝';
}

export function cleanWhatsAppText(text) {
  if (!text) return '';
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^#+\s+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/^[-]{3,}$/gm, '')
    .replace(/^[*\-]\s+/gm, '• ')
    .replace(/\*\*\*([^\n*]+?)\*\*\*/g, '*$1*')
    .replace(/\*\*([^\n*]+?)\*\*/g, '*$1*')
    .replace(/\*{2,}/g, '')
    .replace(/\b(namaste|namaskar|dhanyawad|dhanyavaad|kripya|kripaya|mitra|samasya|adhyayan|sangrakshan|prashn|uttar|swagat)\b/gi, '')
    .replace(/(نمستے|نمسکار|دھنیہ واد|دھنیواد|کرپیا|سمسیا|ادھیان|سواگت)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── MAIN AI RESPONSE GENERATION ──
export async function generateResponse(chatId, userMessageText, apiKeyOverride = null) {
  const session = getChatSession(chatId);

  const enrichedInstructions = SYSTEM_INSTRUCTIONS + '\n\nIMPORTANT CONVERSATIONAL & LANGUAGE RULES:\n- STRICT PURE PAKISTANI URDU ONLY: Speak and write in 100% natural, polite, everyday Pakistani Urdu (پاکستانی اردو یا آسان رومن اردو). NEVER use any Hindi words or Indian phrasing. Always use standard Pakistani polite words: Assalam o Alaikum, Khushamdeed, Shukriya, Janab, Maloomat, Tafseelat, Mukammal.\n- ACCURATE VOICE UNDERSTANDING: The user sends voice messages in Pakistani Urdu. If words like "Flutter" are mentioned, they mean Flutter cross-platform mobile framework. If "Python" is mentioned, they mean Python programming. Answer with deep, crystal-clear technical details.\n- CHATGPT-STYLE COMPLETE ANSWERS: Provide well-structured, comprehensive, point-by-point complete explanations.\n- NATIVE WHATSAPP BOLD: Use single asterisks like *Point Title:* (NEVER double asterisks **).\n- Use clean bullet points (•) and friendly emojis.\n- NEVER use "#", "|", or markdown tables in the reply.\n- Business Pricing: Website (15,000 PKR), Mobile App (20,000 PKR), AI Chatbot (5,000 PKR).';

  // 1. Try Groq AI (Ultra-fast GPT-OSS 120B / 20B / Qwen 27B)
  if (groq) {
    const groqModels = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.6-27b', 'groq/compound-mini'];
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
          max_tokens: 1500,
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
          generationConfig: { temperature: 0.7, maxOutputTokens: 1500 }
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
