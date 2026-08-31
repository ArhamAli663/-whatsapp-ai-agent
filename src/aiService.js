import { GoogleGenerativeAI } from '@google/generative-ai';
import Groq from 'groq-sdk';
import { CONFIG, SYSTEM_INSTRUCTIONS } from './config.js';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from '@ffmpeg-installer/ffmpeg';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
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
      language: 'ur', // Strictly Urdu / Pakistani Accent
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
        model: 'whisper-large-v3',
        language: 'ur',
        temperature: 0.0,
      });
      const rawText = fallback?.text ? fallback.text.trim() : null;
      return rawText ? normalizeVoiceTranscript(rawText) : null;
    } catch (e) {
      return null;
    }
  }
}

try {
  ffmpeg.setFfmpegPath(ffmpegPath.path);
} catch(e) {}

// ── ULTRA-REALISTIC STUDIO HD FEMALE VOICE NOTE (UR-PK-UZMANEURAL) ──
export async function generateVoiceBuffer(text) {
  if (!text || !text.trim()) return null;

  // Clean text specifically for natural, human-like voice synthesis
  let speechText = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/^#+\s+/gm, '')
    .replace(/[*_~#|]/g, ' ')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Cap to ~5 minutes of speech (approx 3,500 characters)
  if (speechText.length > 3500) speechText = speechText.substring(0, 3500);

  const tempMp3 = path.resolve(`temp_${Date.now()}_${Math.random().toString(36).substring(7)}.mp3`);
  const tempOgg = path.resolve(`temp_${Date.now()}_${Math.random().toString(36).substring(7)}.ogg`);

  // 1. PRIMARY: MsEdgeTTS Studio HD Female Voice (ur-PK-UzmaNeural)
  try {
    const isEnglishOnly = /^[a-zA-Z0-9\s.,!?'"()_@#$%&*+-]+$/.test(speechText) && !/(hai|hain|kya|aap|main|hoon|karein|batao|shukriya|assalam|walaikum|urdu)/i.test(speechText);
    const voiceName = isEnglishOnly ? 'en-IN-NeerjaNeural' : 'ur-PK-UzmaNeural';

    // Split speechText into ~400 character natural sentence chunks
    const rawParts = speechText.split(/(?<=[.!?،\n])/g);
    const textChunks = [];
    let cur = '';
    for (const p of rawParts) {
      if ((cur + ' ' + p).length < 400) {
        cur = cur ? (cur + ' ' + p) : p;
      } else {
        if (cur) textChunks.push(cur.trim());
        cur = p;
      }
    }
    if (cur.trim()) textChunks.push(cur.trim());

    const tts = new MsEdgeTTS();
    await tts.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

    const mp3Chunks = [];
    for (const chunk of textChunks.slice(0, 15)) {
      try {
        const readable = tts.toStream(chunk, { rate: '+0%', pitch: '+0Hz' });
        const stream = readable.audioStream || readable;
        const cBufs = [];
        for await (const c of stream) {
          cBufs.push(c);
        }
        mp3Chunks.push(Buffer.concat(cBufs));
      } catch (chunkErr) {
        console.warn('[EdgeTTS chunk error]:', chunkErr.message);
      }
    }
    const mp3Buf = Buffer.concat(mp3Chunks);

    if (mp3Buf && mp3Buf.length > 500) {
      fs.writeFileSync(tempMp3, mp3Buf);
      await new Promise((resolve, reject) => {
        ffmpeg(tempMp3)
          .toFormat('ogg')
          .audioCodec('libopus')
          .audioChannels(1)
          .audioFrequency(48000)
          .outputOptions(['-c:a libopus', '-b:a 96k', '-vbr on', '-application voip', '-af volume=1.2,highpass=f=75,lowpass=f=8500,equalizer=f=1400:t=q:w=1.2:g=2.5'])
          .save(tempOgg)
          .on('end', resolve)
          .on('error', reject);
      });

      if (fs.existsSync(tempOgg)) {
        const oggBuffer = fs.readFileSync(tempOgg);
        try { fs.unlinkSync(tempMp3); fs.unlinkSync(tempOgg); } catch(e){}
        return { buffer: oggBuffer, mimetype: 'audio/ogg; codecs=opus' };
      }
    }
  } catch (edgeErr) {
    console.warn('[MsEdgeTTS Notice, trying fallback]:', edgeErr.message);
    try { if (fs.existsSync(tempMp3)) fs.unlinkSync(tempMp3); if (fs.existsSync(tempOgg)) fs.unlinkSync(tempOgg); } catch(e){}
  }

  // 2. FALLBACK: Parallel Google TTS Chunk Streamer
  try {
    const sentences = speechText.match(/[^.!?،\n]+[.!?،\n]*/g) || [speechText];
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

    const isUrdu = /[\u0600-\u06FF]/.test(speechText) || /(hai|hain|kya|aap|main|hoon|karein|batao|shukriya|assalam|walaikum|urdu|website|kaise|python|zaban)/i.test(speechText);
    const lang = isUrdu ? 'ur' : 'en';

    const chunkPromises = chunks.slice(0, 15).map(async (chunk) => {
      try {
        const encoded = encodeURIComponent(chunk);
        const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=${lang}&client=tw-ob`;
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (res.ok) {
          const ab = await res.arrayBuffer();
          return Buffer.from(ab);
        }
      } catch (e) {}
      return null;
    });

    const results = await Promise.all(chunkPromises);
    const audioBuffers = results.filter(Boolean);
    if (audioBuffers.length > 0) {
      const combinedMp3 = Buffer.concat(audioBuffers);
      fs.writeFileSync(tempMp3, combinedMp3);
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
        try { fs.unlinkSync(tempMp3); fs.unlinkSync(tempOgg); } catch(e){}
        return { buffer: oggBuffer, mimetype: 'audio/ogg; codecs=opus' };
      }
    }
  } catch (err) {
    console.warn('[TTS Fallback Error]:', err.message);
    try { if (fs.existsSync(tempMp3)) fs.unlinkSync(tempMp3); if (fs.existsSync(tempOgg)) fs.unlinkSync(tempOgg); } catch(e){}
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
    .replace(/^#+\s+/gm, '') // Remove ###, ##, # headings
    .replace(/\|/g, ' ') // Remove table pipes
    .replace(/^[-]{3,}$/gm, '') // Remove --- dividers
    .replace(/^[*\-]\s+/gm, '• ') // Replace list asterisks/hyphens with clean bullets
    .replace(/\*\*\*([^\n*]+?)\*\*\*/g, '*$1*') // Convert ***text*** -> *text*
    .replace(/\*\*([^\n*]+?)\*\*/g, '*$1*') // Convert **text** -> *text* (Native WhatsApp Bold)
    .replace(/\*{2,}/g, '') // Remove any accidental double asterisks
    .replace(/\b(namaste|namaskar|dhanyawad|dhanyavaad|kripya|kripaya|mitra|samasya|adhyayan|sangrakshan|prashn|uttar|swagat)\b/gi, '')
    .replace(/(نمستے|نمسکار|دھنیہ واد|دھنیواد|کرپیا|سمسیا|ادھیان|سواگت)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── MAIN AI RESPONSE GENERATION ──
export async function generateResponse(chatId, userMessageText, apiKeyOverride = null) {
  const session = getChatSession(chatId);

  const enrichedInstructions = SYSTEM_INSTRUCTIONS + '\n\nIMPORTANT CONVERSATIONAL & LANGUAGE RULES:\n- STRICT PURE PAKISTANI URDU ONLY: Speak and write in 100% natural, polite, everyday Pakistani Urdu (پاکستانی اردو یا آسان رومن اردو). NEVER use any Hindi words or Indian phrasing (strictly NO namaste, dhanyawad, kripya, mitra, samasya, adhyayan, etc.). Always use standard Pakistani polite words: Assalam o Alaikum, Khushamdeed, Shukriya, Janab, Maloomat, Tafseelat, Mukammal.\n- ACCURATE VOICE UNDERSTANDING: The user sends voice messages in Pakistani Urdu. If words like "Flutter / فلیڈر / فلٹر" are mentioned, they mean Flutter cross-platform mobile framework. If "Python / پائتھن" is mentioned, they mean Python programming. Answer with deep, crystal-clear 5-minute technical details.\n- CHATGPT-STYLE COMPLETE ANSWERS: Provide well-structured, comprehensive, point-by-point complete explanations.\n- NATIVE WHATSAPP BOLD: Use single asterisks like *Point Title:* (NEVER double asterisks **).\n- Use clean bullet points (•) and friendly emojis.\n- NEVER use "#", "|", or markdown tables in the reply.\n- NEVER cut off mid-sentence; provide complete, well-organized explanations from start to finish.\n- Business Pricing: Website (15,000 PKR), Mobile App (20,000 PKR), AI Chatbot (5,000 PKR).';

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
          max_tokens: 2500, // Full detailed up to 5-minute explanation
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
          generationConfig: { temperature: 0.7, maxOutputTokens: 2500 }
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
