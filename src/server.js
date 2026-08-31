import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { CONFIG, SYSTEM_INSTRUCTIONS } from './config.js';
import {
  connectWhatsApp,
  disconnectWhatsApp,
  clearSession,
  getStatus,
  addLogListener,
  addStatusListener
} from './whatsappService.js';
import { testAiPrompt, generateResponse } from './aiService.js';

dotenv.config();

process.on('uncaughtException', (err) => {
  console.error('[Process Error]:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled Rejection]:', reason);
});

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// SSE Clients list for live updates
const sseClients = new Set();

function sendSseEvent(client, eventName, data) {
  client.res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcastSse(eventName, data) {
  for (const client of sseClients) {
    try { sendSseEvent(client, eventName, data); } catch (e) {}
  }
}

// Listen to WhatsApp events and broadcast to Dashboard clients
addLogListener((logItem) => broadcastSse('log', logItem));
addStatusListener((statusItem) => broadcastSse('status', statusItem));

// --- API Endpoints ---

// Get current system status (supports both /status and /api/status)
app.get(['/status', '/api/status'], (req, res) => {
  const currentStatus = getStatus();
  res.json({
    success: true,
    status: currentStatus.connected ? 'connected' : (currentStatus.connecting ? 'connecting' : 'disconnected'),
    qrDataUrl: currentStatus.qrCodeUrl,
    code: currentStatus.pairingCode,
    phone: CONFIG.phoneNumber,
    user: currentStatus.user?.id ? currentStatus.user.id.split('@')[0] : null,
    logs: currentStatus.logs.map(l => ({ ts: l.timestamp, type: l.type, msg: l.message })),
    stats: { received: 0, sent: 0, voiceCount: 0, avgMs: 120 },
    rawStatus: currentStatus,
    config: {
      hasApiKey: Boolean(process.env.GEMINI_API_KEY || CONFIG.geminiApiKey || process.env.GROQ_KEY || CONFIG.groqApiKey),
      phoneNumber: process.env.PHONE_NUMBER || CONFIG.phoneNumber,
      authMode: process.env.AUTH_MODE || CONFIG.authMode || 'qr',
      systemInstructions: SYSTEM_INSTRUCTIONS
    }
  });
});

// SSE endpoint for live dashboard stream (supports both /events and /api/stream)
app.get(['/events', '/api/stream'], (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const clientId = Date.now();
  const client = { id: clientId, res };
  sseClients.add(client);

  const currentStatus = getStatus();
  sendSseEvent(client, 'update', {
    type: 'update',
    state: {
      status: currentStatus.connected ? 'connected' : 'disconnected',
      qrDataUrl: currentStatus.qrCodeUrl,
      phone: CONFIG.phoneNumber,
      user: currentStatus.user?.id ? currentStatus.user.id.split('@')[0] : null,
      logs: currentStatus.logs.map(l => ({ ts: l.timestamp, type: l.type, msg: l.message })),
      stats: { received: 0, sent: 0, voiceCount: 0, avgMs: 120 }
    }
  });

  req.on('close', () => {
    sseClients.delete(client);
  });
});

// Logout endpoint for dashboard Reset button
app.post(['/logout', '/api/logout'], async (req, res) => {
  try {
    await clearSession();
    connectWhatsApp(CONFIG.phoneNumber, CONFIG.authMode);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Chat endpoint for dashboard interactive playground
app.post(['/api/chat', '/api/test-ai'], async (req, res) => {
  const { message, text } = req.body || {};
  const prompt = message || text;
  if (!prompt) return res.status(400).json({ error: 'Message required' });
  try {
    const start = Date.now();
    const reply = await generateResponse('dashboard-test-user', prompt);
    res.json({
      success: true,
      text: reply,
      ms: Date.now() - start,
      engine: 'Groq + Gemini AI'
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger connection
app.post('/api/connect', async (req, res) => {
  const { phoneNumber, authMode, resetSession } = req.body;
  try {
    if (phoneNumber) {
      process.env.PHONE_NUMBER = phoneNumber;
      CONFIG.phoneNumber = phoneNumber;
    }
    if (authMode) {
      process.env.AUTH_MODE = authMode;
      CONFIG.authMode = authMode;
    }
    if (resetSession) {
      await clearSession();
    }
    connectWhatsApp(phoneNumber || CONFIG.phoneNumber, authMode || CONFIG.authMode);
    res.json({ success: true, message: 'Connection initiated.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reset session and restart with fresh QR / pairing
app.post('/api/reset-session', async (req, res) => {
  const { phoneNumber, authMode } = req.body || {};
  try {
    if (phoneNumber) {
      process.env.PHONE_NUMBER = phoneNumber;
      CONFIG.phoneNumber = phoneNumber;
    }
    if (authMode) {
      process.env.AUTH_MODE = authMode;
      CONFIG.authMode = authMode;
    }
    await clearSession();
    connectWhatsApp(phoneNumber || CONFIG.phoneNumber, authMode || CONFIG.authMode);
    res.json({ success: true, message: 'Session cache cleared. New connection starting.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Trigger disconnect
app.post('/api/disconnect', async (req, res) => {
  try {
    await disconnectWhatsApp();
    res.json({ success: true, message: 'Disconnected successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Save configuration (.env)
app.post('/api/save-config', (req, res) => {
  const { geminiApiKey, phoneNumber, authMode } = req.body;
  try {
    if (geminiApiKey !== undefined) {
      process.env.GEMINI_API_KEY = geminiApiKey;
      CONFIG.geminiApiKey = geminiApiKey;
    }
    if (phoneNumber) {
      process.env.PHONE_NUMBER = phoneNumber;
      CONFIG.phoneNumber = phoneNumber;
    }
    if (authMode) {
      process.env.AUTH_MODE = authMode;
      CONFIG.authMode = authMode;
    }

    // Write updated config to .env file
    const envContent = `# Google Gemini API Key
GEMINI_API_KEY=${process.env.GEMINI_API_KEY || ''}

# WhatsApp Phone Number
PHONE_NUMBER=${process.env.PHONE_NUMBER || '923298024266'}

# Web Server Port
PORT=${process.env.PORT || 3000}

# Connection Mode
AUTH_MODE=${process.env.AUTH_MODE || 'qr'}
`;
    fs.writeFileSync(path.resolve('.env'), envContent, 'utf-8');

    res.json({ success: true, message: 'Configuration saved successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Test AI responses in real-time
app.post('/api/test-ai', async (req, res) => {
  const { message, apiKey, chatId } = req.body;
  if (!message) {
    return res.status(400).json({ success: false, error: 'Message text is required.' });
  }
  try {
    const testChatId = chatId || 'test-session-' + Date.now();
    const reply = await generateResponse(testChatId, message, apiKey || null);
    res.json({ success: true, reply });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// SSE endpoint for live real-time dashboard events
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const clientId = Date.now();
  const client = { id: clientId, res };
  sseClients.add(client);

  sendSseEvent(client, 'status', getStatus());

  req.on('close', () => {
    sseClients.delete(client);
  });
});

// Keep-alive timer
setInterval(() => {}, 1000 * 30);

// Start Server
const PORT = CONFIG.port;
const server = app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`  🚀 ARHAM'S WHATSAPP AI AGENT DASHBOARD RUNNING`);
  console.log(`  🔗 Dashboard URL: http://localhost:${PORT}`);
  console.log(`  📱 Target Number: ${CONFIG.phoneNumber}`);
  console.log(`======================================================\n`);

  // Auto-connect WhatsApp on server start
  connectWhatsApp();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Server Error]: Port ${PORT} is already in use.`);
  } else {
    console.error('[Server Error]:', err.message);
  }
});

