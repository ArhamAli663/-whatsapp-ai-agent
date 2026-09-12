import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  fetchLatestBaileysVersion,
  delay,
  Browsers,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { CONFIG } from './config.js';
import { generateResponse, transcribeVoice, generateVoiceBuffer } from './aiService.js';
import { ensureSessionRestored, sanitizeCredsRegistration, persistSession } from './sessionManager.js';

let sock = null;
let reconnectTimer = null;
let globalKeepAliveTimer = null;
let isConnecting = false;

let status = {
  connected: false,
  connecting: false,
  authMode: 'qr',
  pairingCode: null,
  qrCodeUrl: null,
  qrRaw: null,
  user: null,
  logs: []
};

// Track recent bot replies to avoid infinite echo loops
const recentBotSentIds = new Set();

// Message Store for retry decryption (Prevents "Waiting for this message" & Bad MAC)
const messageStore = new Map();
function saveMessage(id, msg) {
  if (!id || !msg) return;
  messageStore.set(id, msg);
  if (messageStore.size > 1500) {
    const firstKey = messageStore.keys().next().value;
    messageStore.delete(firstKey);
  }
}

// 30-Second pending auto-replies map
// key: senderJid (e.g. 923xxxxxxxxx@s.whatsapp.net)
// val: { timer, texts: string[], wantsVoice: boolean, senderPhone: string }
const pendingReplies = new Map();

// Human-Handoff Pause Map
// If Arham replies to a customer, pause AI for that customer so Arham can chat freely!
// key: senderJid, val: timestamp (ms) until which bot is silent
const humanPausedUntil = new Map();

// Event listeners for UI updates
const logListeners = new Set();
const statusListeners = new Set();

export function addLogListener(fn) {
  logListeners.add(fn);
}

export function addStatusListener(fn) {
  statusListeners.add(fn);
}

function broadcastLog(logItem) {
  status.logs.unshift(logItem);
  if (status.logs.length > 150) status.logs.pop();
  for (const listener of logListeners) {
    try { listener(logItem); } catch (e) {}
  }
}

function broadcastStatus() {
  for (const listener of statusListeners) {
    try { listener({ ...status }); } catch (e) {}
  }
}

function addLog(type, message, details = null) {
  const logItem = {
    id: Date.now() + Math.random().toString(36).substr(2, 4),
    timestamp: new Date().toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    type,
    message,
    details
  };
  console.log(`[${logItem.timestamp}] [${type.toUpperCase()}] ${message}`);
  broadcastLog(logItem);
}

export function getStatus() {
  return { ...status };
}

// ── UNWRAP ANY WHATSAPP MESSAGE FORMAT ──
function unwrapMessage(msg) {
  let m = msg.message;
  if (!m) return { text: '', isAudio: false, isImage: false };

  if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
  if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
  if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
  if (m.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;

  const isAudio = Boolean(m.audioMessage || m.pttMessage);
  const isImage = Boolean(m.imageMessage);

  const text =
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    m.templateButtonReplyMessage?.selectedId ||
    m.listResponseMessage?.title ||
    m.interactiveResponseMessage?.body?.text ||
    '';

  return { text: text.trim(), isAudio, isImage };
}

// Manual session clearing ONLY if user explicitly triggers it
export async function clearSession() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (globalKeepAliveTimer) {
    clearInterval(globalKeepAliveTimer);
    globalKeepAliveTimer = null;
  }
  if (sock) {
    try {
      sock.ev.removeAllListeners('connection.update');
      sock.ev.removeAllListeners('messages.upsert');
      sock.ev.removeAllListeners('creds.update');
      if (sock.ws) sock.ws.close();
    } catch (e) {}
    sock = null;
  }

  for (const [, item] of pendingReplies) {
    clearTimeout(item.timer);
  }
  pendingReplies.clear();
  humanPausedUntil.clear();

  const authFolder = path.resolve('auth_info_baileys');
  try {
    if (fs.existsSync(authFolder)) {
      fs.rmSync(authFolder, { recursive: true, force: true });
    }
  } catch (e) {
    console.error('Failed to remove auth_info_baileys:', e.message);
  }

  status.connected = false;
  status.connecting = false;
  status.pairingCode = null;
  status.qrCodeUrl = null;
  status.qrRaw = null;
  status.user = null;
  addLog('info', 'Session cache cleared.');
  broadcastStatus();
}

export async function connectWhatsApp(phoneNumberOverride = null, authModeOverride = null) {
  if (isConnecting) return sock;
  isConnecting = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (sock) {
    try {
      sock.ev.removeAllListeners('connection.update');
      sock.ev.removeAllListeners('messages.upsert');
      sock.ev.removeAllListeners('creds.update');
      if (sock.ws) sock.ws.close();
    } catch (e) {}
    sock = null;
  }

  const targetPhone = (phoneNumberOverride || CONFIG.phoneNumber || '923298024266').replace(/\D/g, '');
  const targetAuthMode = authModeOverride || CONFIG.authMode || 'pairing';
  status.authMode = targetAuthMode;

  addLog('info', `Connecting WhatsApp 24/7 Agent (Mode: ${targetAuthMode.toUpperCase()}) for +${targetPhone}...`);
  status.connecting = true;
  status.connected = false;
  broadcastStatus();

  // Ensure session is available and creds are sanitized
  ensureSessionRestored();
  sanitizeCredsRegistration();

  const authFolder = path.resolve('auth_info_baileys');
  if (!fs.existsSync(authFolder)) {
    fs.mkdirSync(authFolder, { recursive: true });
  }

  try {
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1043857760] }));

    if (state.creds?.me && !state.creds.registered) {
      state.creds.registered = true;
    }
    const isRegistered = state.creds?.registered === true;

    const silentLogger = pino({ level: 'silent' });
    const waSocketFunc = makeWASocket.default || makeWASocket;

    sock = waSocketFunc({
      version,
      logger: silentLogger,
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, silentLogger),
      },
      browser: Browsers.macOS('Desktop'),
      markOnlineOnConnect: true,
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 15000,
      emitOwnEvents: false,
      getMessage: async (key) => {
        if (key && key.id && messageStore.has(key.id)) {
          return messageStore.get(key.id);
        }
        return { conversation: '' };
      },
    });

    sock.ev.on('creds.update', async () => {
      await saveCreds();
      persistSession();
    });

    let pairingRequested = false;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !isRegistered && !state.creds?.me) {
        status.qrRaw = qr;
        try {
          const qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 6 });
          status.qrCodeUrl = qrDataUrl;
          broadcastStatus();
        } catch (err) {}

        if (!pairingRequested && targetPhone) {
          pairingRequested = true;
          setTimeout(async () => {
            if (!sock) return;
            try {
              addLog('info', `Requesting 8-digit Pairing Code for +${targetPhone}...`);
              const code = await sock.requestPairingCode(targetPhone);
              const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
              status.pairingCode = formatted;
              addLog('success', `🔑 PAIRING CODE: ${formatted}`);
              broadcastStatus();
            } catch (pairErr) {
              addLog('error', `Failed to request pairing code: ${pairErr.message}`);
              pairingRequested = false;
            }
          }, 2000);
        }
      }

      if (connection === 'open') {
        status.connected = true;
        status.connecting = false;
        status.pairingCode = null;
        status.qrCodeUrl = null;
        status.qrRaw = null;
        status.user = sock.user;
        pairingRequested = false;
        isConnecting = false;

        const myNum = sock.user?.id?.split(':')[0] || targetPhone;
        addLog('success', `✅ WhatsApp 24/7 Agent CONNECTED! Active for +${myNum}`);
        broadcastStatus();

        persistSession();

        if (globalKeepAliveTimer) clearInterval(globalKeepAliveTimer);
        globalKeepAliveTimer = setInterval(async () => {
          if (sock && status.connected) {
            try {
              await sock.sendPresenceUpdate('available');
            } catch (e) {}
          }
        }, 15000);
      }

      if (connection === 'close') {
        status.connected = false;
        status.connecting = false;
        isConnecting = false;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.message || 'Connection lost';

        addLog('warning', `Connection closed [${statusCode ?? 'N/A'}]: ${reason}`);
        broadcastStatus();

        addLog('info', 'Reconnecting to WhatsApp in 5 seconds (preserving session keys)...');
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connectWhatsApp(targetPhone, targetAuthMode);
        }, 5000);
      }
    });

    // ── MESSAGE UPSERT ──
    sock.ev.on('messages.upsert', async (m) => {
      try {
        const msg = m.messages?.[0];
        if (!msg || !msg.message) return;

        // Save to in-memory message store for retry resolution
        if (msg.key?.id) {
          saveMessage(msg.key.id, msg.message);
        }

        const senderJid = msg.key.remoteJid;
        if (!senderJid || senderJid === 'status@broadcast') return;
        if (senderJid.endsWith('@broadcast') || senderJid.endsWith('@g.us') || senderJid.endsWith('@newsletter')) return;

        if (msg.key?.id && recentBotSentIds.has(msg.key.id)) {
          return;
        }

        const senderPhone = senderJid.split('@')[0];
        const botPhone = (sock.user?.id?.split(':')[0] || targetPhone).replace(/\D/g, '');
        const isSelfChat = senderJid.includes(botPhone) || senderPhone === botPhone;

        const unwrapped = unwrapMessage(msg);
        let userText = unwrapped.text;
        const isAudio = unwrapped.isAudio;

        // ── OWNER MANUAL REPLY & COMMAND HANDLING ──
        if (msg.key.fromMe) {
          if (!isSelfChat) {
            // Check for control commands
            if (userText.toLowerCase() === '.bot off' || userText.toLowerCase() === '#stop') {
              humanPausedUntil.set(senderJid, Date.now() + 24 * 60 * 60 * 1000); // 24 hours
              addLog('info', `🛑 AI Bot manually MUTED for +${senderPhone} for 24 hours.`);
              return;
            }
            if (userText.toLowerCase() === '.bot on' || userText.toLowerCase() === '#start') {
              humanPausedUntil.delete(senderJid);
              addLog('info', `▶️ AI Bot manually UNMUTED for +${senderPhone}.`);
              return;
            }

            // Arham sent a normal reply to the customer:
            // 1. Cancel pending 30s timer
            if (pendingReplies.has(senderJid)) {
              const pending = pendingReplies.get(senderJid);
              clearTimeout(pending.timer);
              pendingReplies.delete(senderJid);
            }
            // 2. Pause AI for this chat for 20 minutes so Arham can talk without AI intrusion!
            humanPausedUntil.set(senderJid, Date.now() + 20 * 60 * 1000);
            addLog('info', `👤 Owner (Arham) replied to +${senderPhone}. AI auto-reply PAUSED for 20 mins for this chat.`);
            return;
          }
        }

        // Check if this chat is currently paused by human handoff
        if (!isSelfChat) {
          const pausedUntil = humanPausedUntil.get(senderJid) || 0;
          if (Date.now() < pausedUntil) {
            const remainingMins = Math.ceil((pausedUntil - Date.now()) / 60000);
            addLog('info', `⏸️ Chat with +${senderPhone} is paused (${remainingMins}m left) because owner is chatting. AI silent.`);
            return;
          }
        }

        // Voice Note transcription
        if (isAudio) {
          addLog('info', `🎙️ Voice Note received from +${senderPhone}. Transcribing via Groq Whisper...`);
          try {
            const audioBuffer = await downloadMediaMessage(msg, 'buffer', {});
            if (audioBuffer) {
              const transcribed = await transcribeVoice(audioBuffer);
              if (transcribed) {
                userText = transcribed;
                addLog('success', `🎙️ Voice Transcribed (+${senderPhone}): "${transcribed}"`);
              }
            }
          } catch (audioErr) {
            console.warn('[Audio Download Error]:', audioErr.message);
          }
        }

        if (!userText || !userText.trim()) return;

        const explicitVoiceReq = /(voice|audio|awaaz|awaz|bol ke|batao voice|voice bhejo|vais|وائس)/i.test(userText);
        const wantsVoice = isAudio || explicitVoiceReq;

        addLog('message_in', `📩 From +${senderPhone}: "${userText.substring(0, 80)}"`, { from: senderPhone });

        // Check if there is already a pending reply timer for this chat
        let pending = pendingReplies.get(senderJid);
        if (pending) {
          clearTimeout(pending.timer);
          pending.texts.push(userText.trim());
          if (wantsVoice) pending.wantsVoice = true;
          addLog('info', `⏳ Additional message from +${senderPhone}. 30s delay refreshed.`);
        } else {
          pending = {
            texts: [userText.trim()],
            wantsVoice,
            senderPhone,
            timer: null
          };
          pendingReplies.set(senderJid, pending);
          addLog('info', `⏳ 30s delay started for +${senderPhone} (giving owner time to reply or user to finish typing)...`);
        }

        // ── 30 SECONDS DELAY ──
        pending.timer = setTimeout(async () => {
          pendingReplies.delete(senderJid);

          if (!sock || !status.connected) {
            console.warn('[AutoReply] WhatsApp not connected when 30s timer expired.');
            return;
          }

          // Check again if owner replied during the 30 seconds
          const currentPause = humanPausedUntil.get(senderJid) || 0;
          if (Date.now() < currentPause) {
            addLog('info', `⏸️ Owner took over chat with +${senderPhone}. Auto-reply aborted.`);
            return;
          }

          const combinedText = pending.texts.join('\n');
          const replyInVoice = pending.wantsVoice;

          addLog('info', `🤖 30s elapsed for +${senderPhone}. AI preparing response...`);

          try {
            await sock.sendPresenceUpdate(replyInVoice ? 'recording' : 'composing', senderJid);
          } catch (e) {}

          const aiReply = await generateResponse(senderJid, combinedText);

          if (replyInVoice) {
            addLog('info', `🎙️ Generating Voice Note reply for +${senderPhone}...`);
            let voiceSent = false;
            try {
              const voiceData = await generateVoiceBuffer(aiReply);
              if (voiceData?.buffer && voiceData.buffer.length > 500) {
                const sent = await sock.sendMessage(senderJid, {
                  audio: voiceData.buffer,
                  mimetype: voiceData.mimetype,
                  ptt: true
                });
                if (sent?.key?.id) {
                  recentBotSentIds.add(sent.key.id);
                  saveMessage(sent.key.id, sent.message);
                }
                voiceSent = true;
                addLog('message_out', `🎙️ Sent Voice Note to +${senderPhone}`);
              }
            } catch (vErr) {
              console.warn('[Voice Send Error]:', vErr.message);
            }

            if (!voiceSent) {
              const sent = await sock.sendMessage(senderJid, { text: aiReply });
              if (sent?.key?.id) {
                recentBotSentIds.add(sent.key.id);
                saveMessage(sent.key.id, sent.message);
              }
              addLog('message_out', `Sent text reply to +${senderPhone}: "${aiReply.substring(0, 70)}..."`);
            }
          } else {
            const sent = await sock.sendMessage(senderJid, { text: aiReply });
            if (sent?.key?.id) {
              recentBotSentIds.add(sent.key.id);
              saveMessage(sent.key.id, sent.message);
            }
            addLog('message_out', `⚡ Sent AI reply to +${senderPhone}: "${aiReply.substring(0, 70)}..."`);
          }

          try {
            await sock.sendPresenceUpdate('paused', senderJid);
          } catch (e) {}

        }, 30000); // Exactly 30 seconds

      } catch (err) {
        addLog('error', `Error handling message: ${err.message}`);
      }
    });

  } catch (err) {
    addLog('error', `Init error: ${err.message}`);
    isConnecting = false;
    reconnectTimer = setTimeout(() => connectWhatsApp(targetPhone, targetAuthMode), 5000);
  }

  isConnecting = false;
  return sock;
}

export async function disconnectWhatsApp() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (globalKeepAliveTimer) {
    clearInterval(globalKeepAliveTimer);
    globalKeepAliveTimer = null;
  }
  if (sock) {
    try {
      sock.ev.removeAllListeners('connection.update');
      sock.ev.removeAllListeners('messages.upsert');
      await sock.logout();
    } catch (e) {
      try { sock.end(); } catch (err) {}
    }
    sock = null;
    status.connected = false;
    status.connecting = false;
    status.user = null;
    status.qrCodeUrl = null;
    status.pairingCode = null;
    broadcastStatus();
  }
}
