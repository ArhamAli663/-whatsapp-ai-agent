import makeWASocket, {
  useMultiFileAuthState,
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

let sock = null;
let reconnectTimer = null;
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

// ── 30-SECOND HUMAN TAKEOVER & AUTO-RESUME STATE ──
const humanTakeover = new Map(); // chatId -> timestamp of when takeover expires
const TAKEOVER_DURATION_MS = 30 * 1000; // 30 seconds
const pendingCustomerMsgTimestamps = new Map(); // chatId -> timestamp of latest customer msg

// Event listeners array for UI updates
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
  if (status.logs.length > 100) status.logs.pop();
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
    timestamp: new Date().toLocaleTimeString(),
    type, // 'info', 'success', 'warning', 'error', 'message_in', 'message_out'
    message,
    details
  };
  console.log(`[${logItem.timestamp}] [${type.toUpperCase()}] ${message}`);
  broadcastLog(logItem);
}

export function getStatus() {
  return { ...status };
}

export async function clearSession() {
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
  addLog('info', 'Session cache cleared. Ready for clean login.');
  broadcastStatus();
}

export async function connectWhatsApp(phoneNumberOverride = null, authModeOverride = null) {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  // Clean up existing socket connection safely
  if (sock) {
    try {
      sock.ev.removeAllListeners('connection.update');
      sock.ev.removeAllListeners('messages.upsert');
      sock.ev.removeAllListeners('creds.update');
      if (sock.ws) sock.ws.close();
    } catch (e) {}
    sock = null;
  }

  const targetPhone = phoneNumberOverride || CONFIG.phoneNumber;
  const targetAuthMode = authModeOverride || CONFIG.authMode || 'qr';
  status.authMode = targetAuthMode;

  addLog('info', `Initializing WhatsApp session (Mode: ${targetAuthMode.toUpperCase()})...`);
  status.connecting = true;
  status.connected = false;
  status.pairingCode = null;
  status.qrCodeUrl = null;
  status.qrRaw = null;
  broadcastStatus();

  const authFolder = path.resolve('auth_info_baileys');
  if (!fs.existsSync(authFolder)) {
    fs.mkdirSync(authFolder, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

  const waSocketFunc = makeWASocket.default || makeWASocket;

  sock = waSocketFunc({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: Browsers.macOS('Desktop'),
    markOnlineOnConnect: true,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 10000,
    emitOwnEvents: false,
  });

  sock.ev.on('creds.update', saveCreds);

  let pairingRequested = false;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      status.qrRaw = qr;
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, {
          margin: 2,
          width: 320,
          color: {
            dark: '#0f172a',
            light: '#ffffff'
          }
        });
        status.qrCodeUrl = qrDataUrl;
      } catch (err) {
        status.qrCodeUrl = qr;
      }

      if (targetAuthMode === 'qr') {
        addLog('info', 'QR Code generated! Scan with WhatsApp -> Linked Devices -> Link a Device.');
        QRCode.toString(qr, { type: 'terminal', small: true }, (err, str) => {
          if (!err) console.log(str);
        });
        broadcastStatus();
      } else if (targetAuthMode === 'pairing' && !sock.authState?.creds?.registered && !pairingRequested && targetPhone) {
        pairingRequested = true;
        try {
          const formattedNumber = targetPhone.replace(/[^0-9]/g, '');
          addLog('info', `Requesting Pairing Code for number +${formattedNumber}...`);
          const code = await sock.requestPairingCode(formattedNumber);
          status.pairingCode = code;
          addLog('success', `Pairing Code generated: ${code}`);
          console.log('\n======================================================');
          console.log(`  YOUR WHATSAPP PAIRING CODE FOR +${formattedNumber}: ${code}`);
          console.log('======================================================\n');
          broadcastStatus();
        } catch (pairErr) {
          addLog('error', `Failed to request pairing code: ${pairErr.message}`);
          pairingRequested = false;
        }
      } else {
        broadcastStatus();
      }
    }

    if (connection === 'close') {
      status.connected = false;
      status.connecting = false;

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
      const isRestartRequired = statusCode === DisconnectReason.restartRequired || statusCode === 515;

      if (isRestartRequired) {
        addLog('info', 'Finalizing WhatsApp connection...');
        status.connecting = true;
        broadcastStatus();
        if (!reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connectWhatsApp(targetPhone, targetAuthMode);
          }, 1000);
        }
      } else if (!isLoggedOut) {
        addLog('warning', `Connection closed (Code: ${statusCode || 'Unknown'}). Reconnecting in 3s...`);
        broadcastStatus();
        if (!reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connectWhatsApp(targetPhone, targetAuthMode);
          }, 3000);
        }
      } else {
        addLog('warning', 'Session logged out from device. Refreshing fresh QR code...');
        await clearSession();
        if (!reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connectWhatsApp(targetPhone, targetAuthMode);
          }, 1500);
        }
      }
    } else if (connection === 'open') {
      status.connected = true;
      status.connecting = false;
      status.pairingCode = null;
      status.qrCodeUrl = null;
      status.qrRaw = null;
      status.user = sock.user;

      addLog('success', `🎉 WhatsApp Connected Successfully! Account: ${sock.user?.id || 'Connected'}`);
      broadcastStatus();
    }
  });

  // ── HANDLE INCOMING & OUTGOING MESSAGES ──
  sock.ev.on('messages.upsert', async (m) => {
    try {
      const msg = m.messages[0];
      if (!msg || !msg.message) return;

      const senderJid = msg.key.remoteJid;
      if (!senderJid || senderJid === 'status@broadcast') return;

      // Ignore group messages
      if (senderJid.endsWith('@g.us')) return;

      const senderPhone = senderJid.split('@')[0];

      // ── ARHAM (OWNER) MANUAL REPLY INTERCEPTION ──
      if (msg.key.fromMe) {
        const ownerText = msg.message.conversation ||
                          msg.message.extendedTextMessage?.text || '';
        humanTakeover.set(senderJid, Date.now() + TAKEOVER_DURATION_MS);
        if (ownerText.trim()) {
          addLog('info', `🧑 Arham chatting (+${senderPhone}): bot paused 30s. "${ownerText.substring(0, 35)}"`);
        }
        return;
      }

      // ── EXTRACT CUSTOMER MESSAGE (TEXT OR VOICE NOTE) ──
      let userText = msg.message.conversation ||
                     msg.message.extendedTextMessage?.text ||
                     msg.message.imageMessage?.caption ||
                     msg.message.videoMessage?.caption || '';

      const isAudio = Boolean(msg.message.audioMessage || msg.message.pttMessage);

      if (isAudio) {
        addLog('info', `🎙️ Voice Note received from +${senderPhone}. Transcribing...`);
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

      if (!userText.trim()) return;

      const msgReceivedTime = Date.now();
      pendingCustomerMsgTimestamps.set(senderJid, msgReceivedTime);

      addLog('message_in', `Incoming message from +${senderPhone}: "${userText}"`, { from: senderPhone });

      // ── 30-SECOND TIMER DELAY: GIVE ARHAM TIME TO REPLY ──
      addLog('info', `⏳ Waiting 30s for Arham to reply to +${senderPhone} before bot steps in...`);
      await delay(30000); // 30 SECONDS WAIT

      // Check if Arham replied during these 30 seconds
      const lastOwnerActivity = humanTakeover.get(senderJid) || 0;
      if (lastOwnerActivity > msgReceivedTime) {
        addLog('warning', `🚫 Arham replied to +${senderPhone}. Bot staying silent.`);
        return;
      }

      // Check if a newer message arrived and superseded this one
      if (pendingCustomerMsgTimestamps.get(senderJid) !== msgReceivedTime) {
        return;
      }

      // ── 30 SECONDS ELAPSED ➔ BOT GENERATES AI RESPONSE ──
      const wantsVoice = isAudio || /(voice|audio|awaaz|awaz|bol ke|batao voice|voice bhejo|vais|وائس)/i.test(userText);
      addLog('success', `🤖 30s elapsed without Arham reply (+${senderPhone}) — Bot generating AI reply...`);

      try { await sock.sendPresenceUpdate(wantsVoice ? 'recording' : 'composing', senderJid); } catch (e) {}

      const aiReply = await generateResponse(senderJid, userText);

      // Re-verify takeover one last time before sending
      if ((humanTakeover.get(senderJid) || 0) > msgReceivedTime) {
        addLog('warning', `🚫 Aborted reply to +${senderPhone} because Arham replied during AI generation.`);
        try { await sock.sendPresenceUpdate('paused', senderJid); } catch (e) {}
        return;
      }

      // ── IF VOICE REQUESTED OR VOICE NOTE RECEIVED ➔ SEND VOICE PTT NOTE ──
      if (wantsVoice) {
        addLog('info', `🎙️ Generating WhatsApp Voice Note for +${senderPhone}...`);
        try {
          const voiceBuffer = await generateVoiceBuffer(aiReply);
          if (voiceBuffer && voiceBuffer.length > 500) {
            await sock.sendMessage(senderJid, {
              audio: voiceBuffer,
              mimetype: 'audio/mp4',
              ptt: true // Real WhatsApp Voice Note waveform
            });
            addLog('message_out', `🎙️ Sent WhatsApp Voice Note (PTT) to +${senderPhone}`);
          }
        } catch (voiceErr) {
          addLog('warning', `Voice Note fallback to text: ${voiceErr.message}`);
        }
      }

      // Always send the clear text response too
      await sock.sendMessage(senderJid, { text: aiReply });
      addLog('message_out', `Sent AI reply to +${senderPhone}: "${aiReply.substring(0, 70)}..."`, { to: senderPhone, text: aiReply });

      try { await sock.sendPresenceUpdate('paused', senderJid); } catch (e) {}

    } catch (err) {
      addLog('error', `Error processing incoming message: ${err.message}`);
    }
  });

  return sock;
}

export async function disconnectWhatsApp() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
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
