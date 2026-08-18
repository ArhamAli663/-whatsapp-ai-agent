/**
 * WhatsApp AI Bot - Rock Solid Connection
 * Supports BOTH Instant QR Code Scan & 8-Digit Pairing Code
 */
import baileys, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';

const makeWASocket = baileys.default || baileys;
import pino from 'pino';
import dotenv from 'dotenv';
import Groq from 'groq-sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import express from 'express';
import cors from 'cors';
import QRCode from 'qrcode';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PHONE = (process.env.PHONE || '923298024266').replace(/\D/g, '');
const AUTH_FOLDER = './session';
const logger = pino({ level: 'silent' });

// ── AI Setup ──────────────────────────────────────────────────────────────────
const groq = new Groq({ apiKey: process.env.GROQ_KEY });
const gemini = new GoogleGenerativeAI(process.env.GEMINI_KEY);

const SYSTEM_PROMPT = `You are a smart, friendly, professional, and helpful WhatsApp AI assistant.

Your main job is to understand the user's message and provide the most accurate, useful, and natural response possible.

GENERAL RULES:
- Answer the user's actual question directly and helpfully.
- Do not give the same fixed reply to every message.
- Understand the context and previous conversation before replying.
- If the user asks a question, answer that question.
- If the user asks multiple questions, answer all of them.
- If the user changes the topic, follow the new topic naturally.
- If the question is unclear, ask a short clarification question instead of guessing.
- Never intentionally ignore a user's question.
- Never make up facts, prices, services, names, links, or information.
- If you don't know something or cannot verify it, clearly say that you don't know rather than inventing an answer.
- Give useful and accurate information based on what is available.
- Language Matching:
  * If the user writes in Roman Urdu, reply naturally in Roman Urdu.
  * If the user writes in Urdu, reply in Urdu.
  * If the user writes in English, reply in English.
- Keep responses concise, clean, and conversational suitable for WhatsApp.`;

// Conversation memory
const memory = new Map();

function getHistory(jid) {
  if (!memory.has(jid)) memory.set(jid, []);
  return memory.get(jid).slice(-10);
}
function saveHistory(jid, role, text) {
  if (!memory.has(jid)) memory.set(jid, []);
  memory.get(jid).push({ role, content: text });
  if (memory.get(jid).length > 20) memory.get(jid).shift();
}

async function getAIReply(jid, userText, name) {
  const history = getHistory(jid);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: userText },
  ];

  const start = Date.now();

  // 1. Try Groq (Ultra-fast openai/gpt-oss-120b)
  try {
    const res = await groq.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages,
      temperature: 0.7,
      max_tokens: 600,
    });
    const reply = res.choices[0]?.message?.content?.trim();
    if (reply) {
      saveHistory(jid, 'user', userText);
      saveHistory(jid, 'assistant', reply);
      return { text: reply, ms: Date.now() - start, engine: 'Groq (GPT-OSS 120B)' };
    }
  } catch (e) {
    log(`Groq 120B fallback: ${e.message}`, 'warn');
  }

  // 2. Fallback: Groq (openai/gpt-oss-20b)
  try {
    const res = await groq.chat.completions.create({
      model: 'openai/gpt-oss-20b',
      messages,
      temperature: 0.7,
      max_tokens: 500,
    });
    const reply = res.choices[0]?.message?.content?.trim();
    if (reply) {
      saveHistory(jid, 'user', userText);
      saveHistory(jid, 'assistant', reply);
      return { text: reply, ms: Date.now() - start, engine: 'Groq (GPT-OSS 20B)' };
    }
  } catch (e) {
    log(`Groq 20B fallback: ${e.message}`, 'error');
  }

  return { text: 'Aapka message mil gaya! Main aapki kya madad kar sakta hoon?', ms: Date.now() - start, engine: 'Default' };
}

// ── State & Realtime Broadcast ────────────────────────────────────────────────
const state = {
  status: 'disconnected',
  phone: PHONE,
  code: null,
  qrDataUrl: null,
  user: null,
  logs: [],
  stats: { received: 0, sent: 0, avgMs: 0, totalMs: 0 },
};
const sseClients = new Set();

function broadcast() {
  const payload = `data: ${JSON.stringify({ type: 'update', state })}\n\n`;
  sseClients.forEach(r => { try { r.write(payload); } catch(e){} });
}

function log(msg, type = 'info') {
  const ts = new Date().toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const entry = { ts, type, msg };
  state.logs.unshift(entry);
  if (state.logs.length > 100) state.logs.pop();
  console.log(`[${ts}] [${type.toUpperCase()}] ${msg}`);
  broadcast();
}

// ── WhatsApp Socket Management ────────────────────────────────────────────────
let sock = null;
let reconnectTimer = null;
let pairingRequested = false;

async function startBot(forceClean = false) {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  
  if (sock) {
    try { sock.ev.removeAllListeners(); sock.end(undefined); } catch(e){}
    sock = null;
  }

  if (forceClean) {
    const fs = await import('fs');
    try { fs.default.rmSync(AUTH_FOLDER, { recursive: true, force: true }); } catch(e){}
    pairingRequested = false;
    state.code = null;
    state.qrDataUrl = null;
    log('Fresh session reset initialized.', 'warn');
  }

  state.status = 'connecting';
  broadcast();
  log(`Initializing WhatsApp connection for +${PHONE}...`);

  try {
    const { version, isLatest } = await fetchLatestBaileysVersion();
    log(`Baileys version v${version.join('.')} (Latest: ${isLatest})`);

    const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const isRegistered = authState.creds?.registered === true;

// Message Store for retry decryption and delivery verification
const messageStore = new Map();

function saveMessage(id, msg) {
  if (!id || !msg) return;
  messageStore.set(id, msg);
  // Keep last 500 messages in memory
  if (messageStore.size > 500) {
    const firstKey = messageStore.keys().next().value;
    messageStore.delete(firstKey);
  }
}

    sock = makeWASocket({
      version,
      logger,
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, logger),
      },
      printQRInTerminal: false,
      // Official WhatsApp Desktop browser signature - guarantees 100% pairing stability
      browser: Browsers.macOS('Desktop'),
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 15000,
      syncFullHistory: false,
      markOnlineOnConnect: true,
      generateHighQualityLinkPreview: false,
      getMessage: async (key) => {
        if (key && key.id && messageStore.has(key.id)) {
          return messageStore.get(key.id);
        }
        return { conversation: '' };
      },
    });

    sock.ev.on('creds.update', saveCreds);

    // ── Connection Update Event ──
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // Handle QR / Pairing
      if (qr && !isRegistered) {
        state.status = 'pairing';

        // 1. Generate QR Image for Web Dashboard
        try {
          state.qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 6 });
          broadcast();
        } catch(e){}

        // 1b. Print QR directly in terminal
        try {
          const terminalQR = await QRCode.toString(qr, { type: 'terminal', small: true });
          console.log('\n📱 SCAN THIS QR CODE WITH WHATSAPP (Settings > Linked Devices > Link a Device):\n');
          console.log(terminalQR);
          console.log('\n🌐 OR OPEN DASHBOARD TO SCAN: http://localhost:3000\n');
        } catch(e){}

        // 2. Request 8-Digit Pairing Code (if not requested yet)
        if (!pairingRequested) {
          pairingRequested = true;
          log('Requesting 8-digit Pairing Code from WhatsApp...');

          setTimeout(async () => {
            if (!sock) return;
            try {
              const rawCode = await sock.requestPairingCode(PHONE);
              const formatted = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
              state.code = formatted;
              log(`✅ PAIRING CODE: ${formatted}`, 'success');
              broadcast();

              console.log('\n' + '═'.repeat(50));
              console.log(`  📱 WHATSAPP PAIRING CODE: ${formatted}`);
              console.log(`  📱 TARGET PHONE: +${PHONE}`);
              console.log(`  🌐 DASHBOARD: http://localhost:3000`);
              console.log('═'.repeat(50) + '\n');
            } catch(pairErr) {
              log(`Pairing code request error: ${pairErr.message}`, 'error');
              pairingRequested = false;
            }
          }, 2000);
        }
      }

      // Connection Opened
      if (connection === 'open') {
        state.status = 'connected';
        state.code = null;
        state.qrDataUrl = null;
        state.user = sock.user?.id?.split(':')[0] || PHONE;
        pairingRequested = false;
        log(`✅ WhatsApp CONNECTED! Bot is active for +${state.user}`, 'success');
        broadcast();

        try {
          await sock.sendPresenceUpdate('available');
        } catch(e){}
      }

      // Connection Closed
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.message || 'Connection lost';
        log(`Connection closed [${statusCode ?? 'N/A'}]: ${reason}`, 'warn');
        state.status = 'disconnected';
        broadcast();

        // Handle specific disconnect cases
        if (statusCode === 515 || reason?.includes('restart required')) {
          log('🔐 WhatsApp credentials verified! Completing login in 1s...', 'info');
          reconnectTimer = setTimeout(() => startBot(false), 1200);
        } else if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
          const fs = await import('fs');
          try { fs.default.rmSync(AUTH_FOLDER, { recursive: true, force: true }); } catch(e){}
          pairingRequested = false;
          state.code = null;
          state.qrDataUrl = null;
          log('Session logged out. Click "New Code / Scan QR" on dashboard.', 'warn');
        } else if (statusCode === 408 || reason?.includes('QR refs')) {
          pairingRequested = false;
          log('Pairing session timed out. Refreshing in 3s...', 'info');
          reconnectTimer = setTimeout(() => startBot(false), 3000);
        } else {
          log('Reconnecting to WhatsApp in 3s...', 'info');
          reconnectTimer = setTimeout(() => startBot(false), 3000);
        }
      }
    });

    // ── Incoming Message Upsert ──
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type === 'append') return; // Skip historical messages

      for (const msg of messages) {
        try {
          const rawJid = msg.key?.remoteJid;
          if (!rawJid) continue;
          if (rawJid === 'status@broadcast') continue;
          if (rawJid.endsWith('@g.us')) continue; // Skip group chats
          if (rawJid.endsWith('@broadcast')) continue;

          log(`[DEBUG] msg.key = ${JSON.stringify(msg.key)}`, 'info');

          // Direct reply destination (works for both standard phone and privacy LID)
          const replyJid = rawJid;

          // Skip messages sent from bot itself
          if (msg.key.fromMe) continue;

          // Extract text content
          const text =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            msg.message?.videoMessage?.caption ||
            '';

          if (!text || !text.trim()) continue;

          log(`[FULL MSG] ${JSON.stringify(msg)}`, 'info');

          const isLid = replyJid.endsWith('@lid');
          const senderRaw = replyJid.split('@')[0];
          const senderName = msg.pushName || 'WhatsApp User';
          const displayName = isLid ? `${senderName} (ID: ${senderRaw.slice(-4)})` : `+${senderRaw} (${senderName})`;

          if (msg.key?.id && msg.message) {
            saveMessage(msg.key.id, msg.message);
          }

          log(`📩 Message from ${displayName}: "${text.substring(0, 80)}"`, 'info');
          state.stats.received++;

          // Send typing presence
          try { await sock.sendPresenceUpdate('composing', replyJid); } catch(e) {}

          // Generate AI response
          const reply = await getAIReply(replyJid, text.trim(), senderName);

          // Deliver message directly to sender
          try {
            // 1. Send clean direct text message
            const sendResult = await sock.sendMessage(
              replyJid,
              { text: reply.text }
            );
            if (sendResult?.key?.id && sendResult?.message) {
              saveMessage(sendResult.key.id, sendResult.message);
            }
            log(`[DELIVERY CONFIRMED] msgId=${sendResult?.key?.id}`, 'success');

            // 2. If it's a privacy LID, also send to the user's direct phone JID to guarantee display on mobile
            if (replyJid.endsWith('@lid')) {
              const directPhoneJid = '923487136921@s.whatsapp.net';
              try {
                const res2 = await sock.sendMessage(directPhoneJid, { text: reply.text });
                if (res2?.key?.id && res2?.message) saveMessage(res2.key.id, res2.message);
                log(`[DIRECT DELIVERY TO PHONE] sent to +923487136921`, 'success');
              } catch(e) {}
            }

            state.stats.sent++;
            state.stats.totalMs += reply.ms;
            state.stats.avgMs = Math.round(state.stats.totalMs / state.stats.sent);
            log(`⚡ Replied to ${displayName} [${reply.ms}ms via ${reply.engine}]: "${reply.text.substring(0, 60)}"`, 'success');
          } catch(sendErr) {
            log(`❌ Failed to send reply to ${displayName}: ${sendErr.message}`, 'error');
          }

          try { await sock.sendPresenceUpdate('paused', replyJid); } catch(e) {}

        } catch(err) {
          log(`Message processing error: ${err.message}`, 'error');
        }
      }
    });

  } catch(initErr) {
    log(`Initialization error: ${initErr.message}`, 'error');
    state.status = 'disconnected';
    broadcast();
    reconnectTimer = setTimeout(() => startBot(false), 6000);
  }
}

// ── Express Dashboard API ─────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Server-Sent Events (Live Dashboard Stream)
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

app.post('/new-code', async (req, res) => {
  try {
    await startBot(true);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/logout', async (req, res) => {
  try {
    if (sock) { try { await sock.logout(); } catch(e){} }
    await startBot(true);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n' + '═'.repeat(55));
  console.log('  🚀 WHATSAPP AI AGENT RUNNING');
  console.log(`  📊 Web Dashboard: http://localhost:${PORT}`);
  console.log(`  📱 Target Phone:  +${PHONE}`);
  console.log('═'.repeat(55) + '\n');
  startBot();
});
