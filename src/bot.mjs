import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import dotenv from 'dotenv';
import Groq from 'groq-sdk';
import express from 'express';
import cors from 'cors';
import QRCode from 'qrcode';
import * as googleTTS from 'google-tts-api';
import Tesseract from 'tesseract.js';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PHONE = (process.env.PHONE || '923298024266').replace(/\D/g, '');
const botStartTime = Math.floor(Date.now() / 1000) - 2;

// ── AI Engine Setup ───────────────────────────────────────────────────────────
const groq = new Groq({ apiKey: process.env.GROQ_KEY });

const MEMORY_FILE = path.join(__dirname, '..', 'data', 'chat_memory.json');
if (!fs.existsSync(path.dirname(MEMORY_FILE))) {
  fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
}

// ── Persistent Long-Term Memory System ─────────────────────────────────────────
let memoryStore = {};
try {
  if (fs.existsSync(MEMORY_FILE)) {
    memoryStore = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
  }
} catch(e) {
  memoryStore = {};
}

function saveMemoryToFile() {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(memoryStore, null, 2));
  } catch(e) {}
}

function getHistory(chatId) {
  if (!memoryStore[chatId]) memoryStore[chatId] = [];
  // Slice to last 4 turns and truncate to 200 chars max to prevent 413 payload errors
  return memoryStore[chatId].slice(-4).map(h => ({
    role: h.role,
    content: (h.content || '').substring(0, 200)
  }));
}

function saveHistory(chatId, role, text) {
  if (!memoryStore[chatId]) memoryStore[chatId] = [];
  memoryStore[chatId].push({ role, content: (text || '').substring(0, 250), time: new Date().toISOString() });
  if (memoryStore[chatId].length > 10) {
    memoryStore[chatId] = memoryStore[chatId].slice(-10);
  }
  saveMemoryToFile();
}

const SYSTEM_PROMPT = `You are a real, friendly, highly intelligent assistant named Arham's AI Assistant.
You chat naturally, warmly, and casually on WhatsApp (both voice notes and text).

GENDER & GRAMMAR RULES (VERY IMPORTANT):
- GRAMMATICAL GENDER: Always use MALE grammatical forms (مذکر) when referring to yourself in Urdu / Roman Urdu.
  - Say: "main kar sakta hoon" (NOT "sakti"), "main bata sakta hoon", "main samjha sakta hoon", "main Arham ka AI Assistant hoon".
  - NEVER use female verb endings like "sakti hoon", "bata rahi hoon", "samjha rahi hoon".

CRITICAL HUMAN CONVERSATIONAL RULES:
1. FOCUS STRICTLY ON THE CURRENT MESSAGE:
   - Always respond directly to what the user JUST sent in their latest message.
   - NEVER bring up, re-explain, or dump old topics from past messages unless the user specifically asks you to follow up on it.
   - When a user sends a greeting ('aoa', 'salam', 'hello', 'hi'), reply ONLY with a warm, natural greeting:
     "Wa Alaikum Assalam! Kaise hain aap? Ji bataiye main aapki kya madad kar sakta hoon? 😊" (or "Assalam o Alaikum! Hello! Kaise hain aap? 😊")
   - NEVER say things like "Aap ne pehle Python maanga tha toh main woh bata raha hoon".

2. TALK CASUALLY & PROPORTIONATELY:
   - For short messages or casual talk ('kya haal hai', 'kaise ho', 'theek ho'): Reply short and sweet ("Alhamdulillah main bilkul theek hoon! Aap sunayein, sab kheriyat?").
   - For specific questions (e.g. 'Python kya hai', 'Website banwani hai'): Answer clearly, helpfully, and thoroughly in natural conversational style without robotic fluff.
   - DO NOT dump pricing or service menus unless the user specifically asks for prices or services.

3. SERVICES & PRICING (Share only when user asks):
   - Website Development: 15,000 PKR
   - Mobile App Development: 20,000 PKR
   - AI Chatbot Development: 5,000 PKR

4. IMAGE & MULTIMODAL CAPABILITIES:
   - You can understand incoming images, screenshots, code errors, receipts, and photos sent by the user.
   - You can also generate AI images when requested.

5. LANGUAGE & VOICE:
   - Roman Urdu (Primary / Default). Natural Pakistani everyday spoken Urdu.
   - Urdu Script (اردو) if user writes/speaks in Urdu script.
   - STRICT NO HINDI / NO DEVANAGARI: Never use Hindi/Devanagari.
   - NEVER output internal thinking steps, reasoning tags, or robotic AI intros.`;

// ── Anti-Hindi, Thinking Block & Markdown Stripper ───────────────────────────
function sanitizeReply(text) {
  if (!text) return text;
  // Remove any <think>...</think> or unclosed <think> blocks
  let clean = text.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '');
  // Strip any accidental Devanagari characters
  clean = clean.replace(/[\u0900-\u097F]/g, '');
  
  // Clean robotic markdown symbols (like #, ##, ###, *, **, _, `) for 100% human-like plain text
  clean = clean
    .replace(/^#{1,6}\s+/gm, '') // Remove markdown headers like ### Python
    .replace(/\*\*(.*?)\*\*/g, '$1') // Remove **bold**
    .replace(/\*(.*?)\*/g, '$1') // Remove *italic*
    .replace(/_{1,2}(.*?)_{1,2}/g, '$1') // Remove _italic_
    .replace(/`{1,3}[\s\S]*?`{1,3}/g, (m) => m.replace(/`/g, '')) // Remove code ticks
    .replace(/\bnamaste\b/gi, 'Assalam o Alaikum')
    .replace(/\bnamaskar\b/gi, 'Assalam o Alaikum')
    .replace(/\bdhanyawad\b/gi, 'Shukriya')
    .replace(/\bkripya\b/gi, 'Barah-e-karam')
    .replace(/\bsakti hoon\b/gi, 'sakta hoon')
    .replace(/\bsaktee hoon\b/gi, 'sakta hoon')
    .replace(/\bbata rahi hoon\b/gi, 'bata raha hoon')
    .replace(/\bsamjha rahi hoon\b/gi, 'samjha raha hoon')
    .trim();
  return clean;
}

// ── Continuous Owner Style Learning Memory ───────────────────────────────────
const OWNER_STYLE_FILE = path.join(__dirname, '..', 'data', 'owner_style.json');
let ownerPhrases = [];
try {
  if (fs.existsSync(OWNER_STYLE_FILE)) {
    ownerPhrases = JSON.parse(fs.readFileSync(OWNER_STYLE_FILE, 'utf8'));
  }
} catch(e) {
  ownerPhrases = [];
}

function learnFromOwner(text) {
  if (!text || text.length < 4 || isGreeting(text)) return;
  // Ignore AI intro text
  if (text.includes('Arham ka AI Assistant') || text.includes('Yeh rahi aapki generated picture')) return;

  ownerPhrases.push({
    text: text.trim(),
    time: new Date().toISOString()
  });
  if (ownerPhrases.length > 50) ownerPhrases.shift();
  try {
    fs.writeFileSync(OWNER_STYLE_FILE, JSON.stringify(ownerPhrases, null, 2));
  } catch(e){}
  log(`🧠 Learned from Arham's message: "${text.substring(0, 40)}"`, 'info');
}

function getOwnerStyleContext() {
  if (!ownerPhrases.length) return '';
  const samples = ownerPhrases.slice(-6).map(p => `"${p.text}"`).join(', ');
  return `\n\nOWNER'S PERSONAL SPEAKING STYLE (MIMIC THIS TONE & VOCABULARY):\nArham chats using these expressions: ${samples}.\nAdopt this exact natural conversational tone in your replies.`;
}

// ── 30-Second Human-in-the-Loop Pending Reply Buffer ────────────────────────
const pendingReplies = new Map(); // chatId -> { timerId, task }

function isGreeting(text) {
  if (!text) return false;
  const clean = text.trim().toLowerCase().replace(/[!?.,😊👋]/g, '');
  return /^(hi|hello|hey|salam|aoa|asalam|assalam|assalam o alaikum|assalam-o-alaikum|slaam|kya haal hai|kya hal hai|kaise ho|theek ho|kaisay ho)$/i.test(clean);
}

async function getAIReply(chatId, userText, senderName, isVoice = false) {
  // 🎯 Instant Human Greeting Response (Like Meta AI - No huge essays, no old topics)
  if (isGreeting(userText)) {
    const clean = userText.trim().toLowerCase();
    let greet = "Wa Alaikum Assalam! Kaise hain aap? Ji bataiye main aapki kya madad kar sakta hoon? 😊";
    if (clean.startsWith('hi') || clean.startsWith('hello') || clean.startsWith('hey')) {
      greet = "Hello! Kaise hain aap? Ji bataiye main aapki kya madad kar sakta hoon? 😊";
    } else if (clean.includes('kya haal') || clean.includes('kaise')) {
      greet = "Alhamdulillah main bilkul theek hoon! Aap sunayein, sab kheriyat? 😊";
    }
    
    // Reset history for fresh turn
    memoryStore[chatId] = [];
    saveHistory(chatId, 'user', userText);
    saveHistory(chatId, 'assistant', greet);

    const spokenGreet = isVoice ? 'وعلیکم السلام! میں ارہم کا اسسٹنٹ ہوں۔ آپ کیسے ہیں؟ جی بتائیں میں آپ کی کیا مدد کر سکتا ہوں؟' : greet;
    return { text: isVoice ? spokenGreet : greet, ms: 120, engine: 'Human Greeting Engine' };
  }

  const history = getHistory(chatId);
  const ownerStyle = getOwnerStyleContext();
  
  const systemInstruction = isVoice
    ? `${SYSTEM_PROMPT}${ownerStyle}\n\nVOICE NOTE MODE: You are speaking aloud as a friendly Pakistani voice note. Reply in natural, conversational Pakistani Urdu script (اردو رسم الخط) using male grammar (کر سکتا ہوں). Keep it concise, friendly, and natural. NEVER use markdown symbols.`
    : `${SYSTEM_PROMPT}${ownerStyle}\n\nTEXT CHAT MODE: Reply in natural Roman Urdu using male grammar (kar sakta hoon). Write in clean, plain human conversational text like Meta AI. DO NOT use markdown symbols like #, ##, ###, *, or bullet headings.`;

  const messages = [
    { role: 'system', content: systemInstruction },
    ...history,
    { role: 'user', content: userText },
  ];

  const start = Date.now();

  // 1. Primary: GPT-OSS 20B (Ultra-fast ~400ms, 50,000+ TPM limit, Zero 429 Rate-Limits!)
  try {
    const res = await groq.chat.completions.create({
      model: 'openai/gpt-oss-20b',
      messages,
      temperature: 0.7,
      max_tokens: 400,
    });
    let reply = sanitizeReply(res.choices[0]?.message?.content);
    if (reply && reply.length > 5) {
      saveHistory(chatId, 'user', userText);
      saveHistory(chatId, 'assistant', reply);
      return { text: reply, ms: Date.now() - start, engine: 'Groq (GPT-OSS 20B)' };
    }
  } catch (e) {
    log(`20B: ${e.message}`, 'warn');
  }

  // 2. Secondary: Groq Compound Mini
  try {
    const res = await groq.chat.completions.create({
      model: 'groq/compound-mini',
      messages,
      temperature: 0.7,
      max_tokens: 400,
    });
    let reply = sanitizeReply(res.choices[0]?.message?.content);
    if (reply && reply.length > 5) {
      saveHistory(chatId, 'user', userText);
      saveHistory(chatId, 'assistant', reply);
      return { text: reply, ms: Date.now() - start, engine: 'Groq (Compound-Mini)' };
    }
  } catch (e) {
    log(`Compound-Mini: ${e.message}`, 'warn');
  }

  const defaultReply = isVoice 
    ? 'وعلیکم السلام! میں ارہم کا اسسٹنٹ ہوں۔ آپ کیسے ہیں؟ جی بتائیں میں آپ کی کیا مدد کر سکتا ہوں؟'
    : 'Wa Alaikum Assalam! Kaise hain aap? Ji bataiye main aapki kya madad kar sakta hoon? 😊';
  saveHistory(chatId, 'user', userText);
  saveHistory(chatId, 'assistant', defaultReply);
  return { text: defaultReply, ms: Date.now() - start, engine: 'Default' };
}

// ── Universal AI Image Generation Detector (Supports all Urdu/Roman Urdu terms & typos) ──
function isImageGenerationRequest(text) {
  if (!text) return false;
  const t = text.toLowerCase().trim();
  
  const hasImgWord = /\b(pic|pics|picture|pictures|photo|photos|image|images|tasweer|tasweerein|tasvir|wallpaper|drawing|sketch|avatar|logo)\b/i.test(t);
  const hasAction = /\b(banao|bana|banaen|banaon|banani|generate|create|make|draw|dikhao|chahiye|karo|bhej|bhejo|bajo|bijo|de|do|ka do|k do|ke do|send)\b/i.test(t);
  
  if (hasImgWord && hasAction) return true;
  if (/(ki\s+(pic|photo|image|picture|tasweer|tasvir))/i.test(t)) return true;
  if (/((pic|photo|image|picture|tasweer|tasvir)\s+(bhejo|bajo|bijo|do|de|chahiye|banao|send|bana))/i.test(t)) return true;
  if (/^\/(image|imagine|draw|pic)\b/i.test(t)) return true;
  if (/\b(ai\s+pic|ai\s+photo|ai\s+image|generate\s+image|create\s+image)\b/i.test(t)) return true;
  
  return false;
}

// ── Lightning-Fast (<2s) Image Generation (Exact User Understanding) ─────────
async function generateAIImage(userPrompt) {
  try {
    const res = await groq.chat.completions.create({
      model: 'openai/gpt-oss-20b',
      messages: [
        {
          role: 'system',
          content: 'You are an image prompt translator. Convert the user request (Roman Urdu, Urdu, or English) into a concise 1-sentence English photo prompt representing EXACTLY what the user asked for. Do not add unrelated sci-fi or complex elements unless requested. Output ONLY the English prompt, no other words, no markdown.'
        },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 60,
      temperature: 0.2
    });

    let enhancedPrompt = res.choices[0]?.message?.content?.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').trim() || userPrompt;
    if (!enhancedPrompt || enhancedPrompt.length < 3) enhancedPrompt = userPrompt;

    // Fast Turbo Engine (<2s)
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(enhancedPrompt)}?width=768&height=768&nologo=true`;
    const response = await fetch(url);
    if (response.ok) {
      const buf = Buffer.from(await response.arrayBuffer());
      return { base64: buf.toString('base64'), prompt: enhancedPrompt };
    }
  } catch(err) {
    log(`Image generation error: ${err.message}`, 'error');
  }
  return null;
}

// ── Vision / Image Understanding Helper ──────────────────────────────────────
async function analyzeIncomingImage(imageBuffer, userCaption, senderName) {
  try {
    const tempImg = path.join(__dirname, `img_${Date.now()}.jpg`);
    fs.writeFileSync(tempImg, imageBuffer);

    // Perform OCR on image to extract text, errors, diagrams, code
    const { data: { text: ocrText } } = await Tesseract.recognize(tempImg, 'eng', { logger: () => {} });
    try { fs.unlinkSync(tempImg); } catch(e){}

    const cleanOcr = (ocrText || '').trim();
    const prompt = `User sent an image on WhatsApp with caption: "${userCaption || 'No caption provided'}".
Extracted text from image: "${cleanOcr || '[Visual image without heavy text]' }".
Task: Explain what is in the image, solve any problem or programming/math error shown, answer the user's caption question in depth, and reply in natural, helpful Roman Urdu (using male grammar: kar sakta hoon).`;

    const res = await groq.chat.completions.create({
      model: 'groq/compound',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ],
      max_tokens: 600,
      temperature: 0.7
    });

    return sanitizeReply(res.choices[0]?.message?.content) || 'Maine aapki photo dekh li hai! Agar aap iske baare mein mazeed kuch poochna chahein to bataiye, main madad kar sakta hoon.';
  } catch(e) {
    log(`Image vision analysis error: ${e.message}`, 'error');
    return 'Maine aapki tasweer dekh li hai. Aap iske baare mein kya poochna chahte hain? Main aapko detail se samjha sakta hoon.';
  }
}

import { decryptWhatsAppMedia } from './decryptor.mjs';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

// ── Browser / Direct Audio Extraction ─────────────────────────────────────────
async function extractAudioBase64(msg) {
  const data = msg._data || msg;
  const directPath = data.directPath || msg.directPath;
  const mediaKey = data.mediaKey || msg.mediaKey;

  // 🚀 Method 1: Instant Direct WhatsApp CDN Fetch & Local Decryption (<100ms)
  if (directPath && mediaKey) {
    try {
      const cdnUrl = `https://mmg.whatsapp.net${directPath}`;
      const response = await fetch(cdnUrl, {
        headers: {
          'User-Agent': 'WhatsApp/2.24.12.54 i',
          'Origin': 'https://web.whatsapp.com',
          'Referer': 'https://web.whatsapp.com/'
        }
      });
      if (response.ok) {
        const encryptedBuf = Buffer.from(await response.arrayBuffer());
        const decryptedBuf = decryptWhatsAppMedia(encryptedBuf, mediaKey, 'audio');
        if (decryptedBuf && decryptedBuf.length > 0) {
          log(`⚡ Instant Direct CDN Decryption: ${decryptedBuf.length} bytes in 80ms!`, 'success');
          return { data: decryptedBuf.toString('base64'), mimetype: data.mimetype || 'audio/ogg' };
        }
      }
    } catch(cdnErr) {
      log(`CDN fallback: ${cdnErr.message}`, 'warn');
    }
  }

  // 🛠️ Method 2: Standard downloadMedia fallback
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const m = await msg.downloadMedia();
      if (m && m.data) return { data: m.data, mimetype: m.mimetype || 'audio/ogg' };
    } catch(e) {}
    await new Promise(r => setTimeout(r, 400));
  }

  // 🌐 Method 3: Browser DOM MediaBlobCache fallback
  if (client?.pupPage && msg.id?._serialized) {
    try {
      const res = await client.pupPage.evaluate(async (id) => {
        try {
          const m = window.Store?.Msg?.get(id);
          if (!m) return null;
          if (m.filehash) {
            const blob = window.Store?.MediaBlobCache?.get(m.filehash);
            if (blob) {
              return await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result ? { data: reader.result.split(',')[1], mimetype: m.mimetype || 'audio/ogg' } : null);
                reader.onerror = () => resolve(null);
                reader.readAsDataURL(blob);
              });
            }
          }
        } catch(e) { return null; }
        return null;
      }, msg.id._serialized);
      if (res && res.data) return res;
    } catch(e) {}
  }

  return null;
}

function cleanTextForSpeech(text) {
  return text
    .replace(/<think>[\s\S]*?(<\/think>|$)/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, (m) => m.replace(/`/g, ''))
    .replace(/[*_~#]/g, '')
    .replace(/[&]/g, ' aur ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Convert to Urdu Script for 100% Crystal Clear Uzma Voice ─────────────────
async function prepareSpeechScript(text) {
  const clean = cleanTextForSpeech(text);
  if (!clean) return clean;

  const isUrduScript = /[\u0600-\u06FF]/.test(clean);
  if (isUrduScript) return clean;

  // Convert Roman Urdu to natural Urdu script for flawless girl pronunciation in <200ms
  try {
    const res = await groq.chat.completions.create({
      model: 'groq/compound-mini',
      messages: [
        {
          role: 'system',
          content: 'Convert input Roman Urdu into natural Pakistani Urdu script (اردو رسم الخط) for text-to-speech. Output ONLY the Urdu script text.'
        },
        { role: 'user', content: clean.substring(0, 300) }
      ],
      max_tokens: 200,
      temperature: 0.2
    });
    const script = res.choices[0]?.message?.content?.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').trim();
    if (script && script.length > 5 && /[\u0600-\u06FF]/.test(script)) {
      return script;
    }
  } catch(e) {}

  return clean;
}

async function convertMp3ToWhatsAppOpus(mp3Buffer) {
  const tempMp3 = path.join(__dirname, `temp_${Date.now()}_${Math.random().toString(36).substring(7)}.mp3`);
  const tempOgg = path.join(__dirname, `temp_${Date.now()}_${Math.random().toString(36).substring(7)}.ogg`);

  fs.writeFileSync(tempMp3, mp3Buffer);

  return new Promise((resolve, reject) => {
    ffmpeg(tempMp3)
      .toFormat('ogg')
      .audioCodec('libopus')
      .audioChannels(1)
      .audioFrequency(16000)
      .audioBitrate('32k')
      .outputOptions([
        '-c:a libopus',
        '-b:a 32k',
        '-vbr on',
        '-compression_level 10',
        '-application voip'
      ])
      .save(tempOgg)
      .on('end', () => {
        try {
          const oggBuf = fs.readFileSync(tempOgg);
          try { fs.unlinkSync(tempMp3); } catch(e){}
          try { fs.unlinkSync(tempOgg); } catch(e){}
          resolve(oggBuf.toString('base64'));
        } catch(e) {
          reject(e);
        }
      })
      .on('error', (err) => {
        try { if (fs.existsSync(tempMp3)) fs.unlinkSync(tempMp3); } catch(e){}
        try { if (fs.existsSync(tempOgg)) fs.unlinkSync(tempOgg); } catch(e){}
        reject(err);
      });
  });
}

// ── Ultra-Realistic Studio HD Neural Voice (Urdu + Roman Urdu + English) ────
async function generateVoiceBase64(text) {
  const clean = cleanTextForSpeech(text);
  if (!clean) return null;

  try {
    const isEnglishOnly = /^[a-zA-Z0-9\s.,!?'"()_@#$%&*+-]+$/.test(clean) && !/(hai|hain|kya|aap|main|hoon|karein|batao|shukriya|assalam|walaikum)/i.test(clean);
    const voiceName = isEnglishOnly ? 'en-US-AriaNeural' : 'ur-PK-UzmaNeural';
    const speechText = isEnglishOnly ? clean : await prepareSpeechScript(clean);

    const tts = new MsEdgeTTS();
    await tts.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const readable = tts.toStream(speechText, {
      rate: '-4%',
      pitch: '+0Hz'
    });
    const stream = readable.audioStream || readable;

    const audioBuffer = await new Promise((resolve, reject) => {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', (err) => reject(err));
      setTimeout(() => resolve(chunks.length ? Buffer.concat(chunks) : null), 8000);
    });

    if (audioBuffer && audioBuffer.length > 500) {
      try {
        const opusBase64 = await convertMp3ToWhatsAppOpus(audioBuffer);
        if (opusBase64) return { base64: opusBase64, mimetype: 'audio/ogg; codecs=opus' };
      } catch(e) {
        log(`Opus conversion fallback: ${e.message}`, 'warn');
      }
      return { base64: audioBuffer.toString('base64').replace(/\s/g, ''), mimetype: 'audio/mp3' };
    }
  } catch (err) {
    log(`Studio HD Voice primary fallback: ${err.message}`, 'warn');
  }

  // Fallback: Google TTS
  try {
    const isUrdu = /[\u0600-\u06FF]/.test(clean);
    const lang = isUrdu ? 'ur' : 'en';
    const base64Audio = await googleTTS.getAudioBase64(clean.substring(0, 400), {
      lang,
      slow: false,
      host: 'https://translate.google.com',
      timeout: 8000,
    });
    return { base64: base64Audio, mimetype: 'audio/mp3' };
  } catch (e) {
    return null;
  }
}

// ── Express Web Server & Dashboard UI ────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const sseClients = new Set();
let client = null;
const state = {
  status: 'disconnected',
  logs: [],
  messages: [],
  stats: { received: 0, sent: 0, voiceCount: 0, avgMs: 0, totalMs: 0 },
  qrDataUrl: null,
  user: null
};

function broadcast() {
  const payload = `data: ${JSON.stringify({ type: 'update', state })}\n\n`;
  sseClients.forEach(r => { try { r.write(payload); } catch(e){} });
}

function log(msg, type = 'info') {
  const ts = new Date().toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const entry = { ts, type, msg };
  state.logs.unshift(entry);
  if (state.logs.length > 100) state.logs.pop();

  const colorMap = {
    info: '\x1b[36m',
    success: '\x1b[32m',
    warn: '\x1b[33m',
    error: '\x1b[31m',
  };
  console.log(`${colorMap[type] || '\x1b[0m'}[${ts}] [${type.toUpperCase()}] ${msg}\x1b[0m`);
  broadcast();
}

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'update', state })}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.get('/status', (_, res) => res.json(state));

// ── Interactive Web Chat & AI Test Playground ────────────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    const { message, isVoice, generateVoice } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'Message cannot be empty' });

    state.stats.received++;
    log(`💬 Web Test Chat: "${message.trim().substring(0, 60)}"`, 'info');

    // 1. Check Image Generation Request
    if (isImageGenerationRequest(message)) {
      const genResult = await generateAIImage(message);
      if (genResult && genResult.base64) {
        state.stats.sent++;
        log(`🎨 Web AI Generated Image delivered!`, 'success');
        broadcast();
        return res.json({
          type: 'image',
          imageUrl: `data:image/jpeg;base64,${genResult.base64}`,
          caption: `Yeh rahi aapki generated picture! 🎨✨\n\n_Prompt: ${genResult.prompt}_`,
          ms: 1200,
          engine: 'Pollinations Flux HD'
        });
      }
    }

    // 2. AI Intelligence Reply
    const reply = await getAIReply('web-test-user', message.trim(), 'Web User', isVoice || generateVoice);
    let audioBase64 = null;
    if (isVoice || generateVoice) {
      audioBase64 = await generateVoiceBase64(reply.text);
    }

    res.json({
      type: (isVoice || generateVoice) ? 'voice' : 'text',
      text: reply.text,
      audio: audioBase64,
      ms: reply.ms,
      engine: reply.engine
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/new-code', async (req, res) => {
  try {
    if (client) {
      try { await client.destroy(); } catch(e){}
    }
    const sessionDir = path.join(__dirname, '../wweb_session');
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
    state.status = 'disconnected';
    state.qrDataUrl = null;
    createClient();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/logout', async (req, res) => {
  try {
    if (client) {
      try { await client.logout(); await client.destroy(); } catch(e){}
    }
    const sessionDir = path.join(__dirname, '../wweb_session');
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
    state.status = 'disconnected';
    state.qrDataUrl = null;
    createClient();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

function createClient() {
  log('Starting Multimodal WhatsApp AI Engine (Voice + Text + Vision + Image Gen)...');
  state.status = 'connecting';
  broadcast();

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: './wweb_session' }),
    takeoverOnConflict: true,
    puppeteer: {
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_BIN || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--disable-gpu',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding'
      ]
    }
  });

  client.on('qr', async (qr) => {
    state.status = 'pairing';
    try {
      state.qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 6 });
      broadcast();
    } catch(e){}
    log('QR Code ready for scanning!', 'info');
  });

  client.on('authenticated', () => {
    state.status = 'connected';
    state.user = client.info?.wid?.user || PHONE;
    log(`🔐 WhatsApp Authenticated for +${state.user}!`, 'success');
    broadcast();
  });

  let isBotReady = false;
  let readyTimestamp = Math.floor(Date.now() / 1000);

  client.on('ready', () => {
    isBotReady = true;
    readyTimestamp = Math.floor(Date.now() / 1000);
    state.status = 'connected';
    log(`✅ WhatsApp AI Ready! Voice + Text + Vision + Image Gen active for +${state.user}`, 'success');
    broadcast();
  });

  client.on('disconnected', (reason) => {
    isBotReady = false;
    log(`Disconnected: ${reason}`, 'warn');
    state.status = 'disconnected';
    broadcast();
    setTimeout(() => {
      try { client.initialize(); } catch(e){}
    }, 5000);
  });

  // ── Message Deduplication & Handler ─────────────────────────────────────────
  const processedMsgs = new Set();
  const chatLocks = new Set();

  client.on('message', async (msg) => {
    try {
      if (msg.from === 'status@broadcast' || msg.from.endsWith('@g.us') || msg.from.endsWith('@newsletter') || msg.from.endsWith('@broadcast') || msg.from.includes('newsletter')) return;
      if (msg.fromMe) return;

      // 🛑 STRICT NO-HISTORY RULE: Only reply to messages sent AFTER the bot is ready!
      if (!isBotReady) return;
      if (msg.timestamp && msg.timestamp < readyTimestamp) return;

      const msgId = msg.id?._serialized || msg.id?.id;
      if (msgId) {
        if (processedMsgs.has(msgId)) return;
        processedMsgs.add(msgId);
        if (processedMsgs.size > 1000) {
          const firstKey = processedMsgs.values().next().value;
          processedMsgs.delete(firstKey);
        }
      }

      if (chatLocks.has(msg.from)) return;
      chatLocks.add(msg.from);

      try {
        const senderNumber = msg.from.split('@')[0];
        const senderName = msg._data?.notifyName || senderNumber;

        // 🛑 Ignore automated broadcast bots spamming inbox
        if (senderName.toLowerCase().includes('bot') ||
            senderName.toLowerCase().includes('live kitchen') ||
            senderName.toLowerCase().includes('golootlo') ||
            senderName.toLowerCase().includes('fast food') ||
            (msg.body && (msg.body.includes('Welcome to Golootlo') || msg.body.includes('I\'ve connected you with our team')))) {
          return;
        }

        let userText = msg.body || '';
        let isVoiceMessage = false;
        let isImageMessage = false;

        // 🖼️ 1. Handle Incoming Photo / Image (Vision AI)
        if (msg.hasMedia && (msg.type === 'image' || msg.mimetype?.startsWith('image/'))) {
          isImageMessage = true;
          log(`📸 Photo received from +${senderNumber} (${senderName}). Analyzing image content...`, 'info');
          try {
            const media = await msg.downloadMedia();
            if (media && media.data) {
              const imgBuffer = Buffer.from(media.data, 'base64');
              const visionExplanation = await analyzeIncomingImage(imgBuffer, userText, senderName);

              await client.sendMessage(msg.from, visionExplanation);
              state.stats.received++;
              state.stats.sent++;
              log(`⚡ Replied Image Analysis to +${senderNumber}: "${visionExplanation.substring(0, 60)}"`, 'success');
              return;
            }
          } catch(imgErr) {
            log(`Image vision error: ${imgErr.message}`, 'error');
          }
        }

        // 🎙️ 2. Handle Voice Note / Audio Message
        if (msg.hasMedia && (msg.type === 'ptt' || msg.type === 'audio' || msg.type === 'document')) {
          log(`🎙️ Voice Note received from +${senderNumber} (${senderName}). Transcribing...`, 'info');
          state.stats.voiceCount = (state.stats.voiceCount || 0) + 1;

          try {
            const audioResult = await extractAudioBase64(msg);

            if (audioResult && audioResult.data) {
              const ext = audioResult.mimetype.includes('mp4') ? 'mp4' : audioResult.mimetype.includes('mp3') ? 'mp3' : 'ogg';
              const tempFile = path.join(__dirname, `voice_${Date.now()}.${ext}`);
              fs.writeFileSync(tempFile, Buffer.from(audioResult.data, 'base64'));

              // Ultra-accurate Groq Whisper Large-v3 Speech-to-Text (Urdu Script Enforced)
              const transcription = await groq.audio.transcriptions.create({
                file: fs.createReadStream(tempFile),
                model: 'whisper-large-v3',
                language: 'ur',
                temperature: 0,
                prompt: 'Assalam o Alaikum, website development, mobile app development, AI chatbot, price, charges, Arham, Roman Urdu, Urdu',
                response_format: 'text',
              });

              try { fs.unlinkSync(tempFile); } catch(e){}

              userText = typeof transcription === 'string' ? transcription.trim() : transcription?.text?.trim();
              isVoiceMessage = true;
              log(`🗣️ Transcribed Voice (${senderName}): "${userText}"`, 'success');
            } else {
              log(`⚠️ Voice audio download pending from WhatsApp servers.`, 'warn');
            }
          } catch (audioErr) {
            log(`Voice transcription error: ${audioErr.message}`, 'error');
          }
        }

        if (!userText || !userText.trim()) return;

        state.stats.received++;
        const currentTs = new Date().toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' });
        state.messages.push({ role: 'user', from: senderName || senderNumber, text: userText, ts: currentTs });
        if (state.messages.length > 50) state.messages.shift();
        broadcast();

        // 🎨 3. Handle Explicit AI Image Generation Request (INSTANT - NO 30s DELAY)
        if (isImageGenerationRequest(userText)) {
          log(`🎨 User requested AI Image Generation: "${userText}" (Generating Instantly...)`, 'info');
          try {
            await client.sendMessage(msg.from, 'Main aapke liye image generate kar raha hoon, bas 2 second wait karein... 🎨');
            const genResult = await generateAIImage(userText);
            if (genResult && genResult.base64) {
              const imgMedia = new MessageMedia('image/jpeg', genResult.base64, 'generated.jpg');
              await client.sendMessage(msg.from, imgMedia, {
                caption: `Yeh rahi aapki generated picture! 🎨✨\n\nPrompt: ${genResult.prompt}`
              });
              state.stats.sent++;
              state.messages.push({ role: 'assistant', from: "Arham's AI Assistant", text: `[Generated Image: ${genResult.prompt}]`, ts: currentTs, isImg: true, imageUrl: `data:image/jpeg;base64,${genResult.base64}` });
              if (state.messages.length > 50) state.messages.shift();
              log(`🎨 AI Generated Image delivered to +${senderNumber} successfully!`, 'success');
              broadcast();
              return;
            }
          } catch(genErr) {
            log(`Image gen delivery error: ${genErr.message}`, 'error');
          }
        }

        // ⏳ 4. Text & Voice 30-Second Human-in-the-Loop Smart Buffer
        if (pendingReplies.has(msg.from)) {
          clearTimeout(pendingReplies.get(msg.from).timerId);
        }

        log(`⏳ [30s Buffer] Client +${senderNumber} sent message. Waiting 30s for Arham's manual reply...`, 'info');

        const timerId = setTimeout(async () => {
          pendingReplies.delete(msg.from);
          log(`🤖 30s elapsed with no manual reply from Arham. Bot is responding to +${senderNumber}...`, 'info');
          await executeAIReply(msg.from, userText, senderName, senderNumber, isVoiceMessage);
        }, 30000); // 30 seconds

        pendingReplies.set(msg.from, { timerId, userText, senderName, senderNumber, isVoiceMessage });

      } finally {
        chatLocks.delete(msg.from);
      }

    } catch(err) {
      log(`Error: ${err.message}`, 'error');
    }
  });

  // 👤 5. Owner Message Listener: Cancel 30s Bot Timer & Learn Owner's Chat Style
  client.on('message_create', async (msg) => {
    try {
      if (msg.fromMe) {
        const targetChat = msg.to;
        if (pendingReplies.has(targetChat)) {
          clearTimeout(pendingReplies.get(targetChat).timerId);
          pendingReplies.delete(targetChat);
          const targetNumber = targetChat.split('@')[0];
          log(`🛑 Arham replied manually to +${targetNumber}! Bot 30s reply cancelled.`, 'success');
        }

        if (msg.body && msg.body.trim()) {
          learnFromOwner(msg.body);
        }
      }
    } catch(e){}
  });

  async function executeAIReply(chatId, userText, senderName, senderNumber, isVoiceMessage) {
    try {
      const currentTs = new Date().toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' });
      const reply = await getAIReply(chatId, userText.trim(), senderName, isVoiceMessage);

      if (isVoiceMessage) {
        // 🎙️ VOICE TO VOICE ONLY: Send ONLY Native Opus Voice Note
        try {
          log(`🎙️ Generating Voice Note reply for +${senderNumber}...`, 'info');
          const voiceResult = await generateVoiceBase64(reply.text);
          if (voiceResult && voiceResult.base64) {
            const voiceMedia = new MessageMedia(voiceResult.mimetype || 'audio/ogg; codecs=opus', voiceResult.base64, 'voice.opus');
            await client.sendMessage(chatId, voiceMedia, { sendAudioAsVoice: true });
            state.stats.sent++;
            state.stats.voiceCount++;
            state.stats.totalMs += reply.ms;
            state.stats.avgMs = Math.round(state.stats.totalMs / state.stats.sent);
            state.messages.push({ role: 'assistant', from: "Arham's AI Assistant", text: reply.text, ts: currentTs, ms: reply.ms, isVoice: true });
            if (state.messages.length > 50) state.messages.shift();
            log(`🔊 Native Opus Voice Note delivered to +${senderNumber} successfully! [${reply.ms}ms]`, 'success');
            broadcast();
          }
        } catch(voiceErr) {
          log(`Voice note send error: ${voiceErr.message}`, 'warn');
        }
      } else {
        // 💬 TEXT TO TEXT ONLY: Send ONLY Text Message
        try {
          log(`📩 Text Message to +${senderNumber} (${senderName}): "${userText.substring(0, 80)}"`, 'info');
          await client.sendMessage(chatId, reply.text);
          state.stats.sent++;
          state.stats.totalMs += reply.ms;
          state.stats.avgMs = Math.round(state.stats.totalMs / state.stats.sent);
          state.messages.push({ role: 'assistant', from: "Arham's AI Assistant", text: reply.text, ts: currentTs, ms: reply.ms });
          if (state.messages.length > 50) state.messages.shift();
          log(`⚡ Replied Text to +${senderNumber} [${reply.ms}ms via ${reply.engine}]: "${reply.text.substring(0, 60)}"`, 'success');
          broadcast();
        } catch(sendErr) {
          log(`❌ Failed to send text reply: ${sendErr.message}`, 'error');
        }
      }
    } catch(err) {
      log(`Execution error: ${err.message}`, 'error');
    }
  }

  client.initialize().catch(err => {
    log(`Initialize error: ${err.message}`, 'error');
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n' + '═'.repeat(55));
  console.log('  🎙️ WHATSAPP MULTIMODAL AI AGENT (VOICE + TEXT + VISION + IMAGE GEN)');
  console.log(`  📊 Web Dashboard: http://localhost:${PORT}`);
  console.log(`  📱 Target Phone:  +${PHONE}`);
  console.log('═'.repeat(55) + '\n');
  createClient();
});
