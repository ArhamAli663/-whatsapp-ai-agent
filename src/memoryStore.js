/**
 * Persistent Memory Store for WhatsApp Bot
 * Stores user profiles + full chat history (up to 500 messages per user)
 * Backed by JSON files so data survives container restarts.
 */
import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve('data');
const PROFILES_FILE = path.join(DATA_DIR, 'user_profiles.json');
const HISTORY_FILE = path.join(DATA_DIR, 'chat_history.json');

const MAX_HISTORY_PER_USER = 500;   // messages per user
const SAVE_DEBOUNCE_MS = 1500;       // write to disk 1.5s after last change

// In-memory cache (loaded from disk on startup)
let profiles = {};  // { chatId: { name, services, projectDetails, lang, notes, firstSeen, lastSeen } }
let history = {};   // { chatId: [{ role, text, timestamp, type }] }

// ── Load from disk on startup ──
function loadData() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(PROFILES_FILE)) {
      profiles = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf-8'));
      console.log(`[Memory] Loaded ${Object.keys(profiles).length} user profiles.`);
    }
    if (fs.existsSync(HISTORY_FILE)) {
      history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
      const totalMsgs = Object.values(history).reduce((a, h) => a + h.length, 0);
      console.log(`[Memory] Loaded ${Object.keys(history).length} users, ${totalMsgs} total messages.`);
    }
  } catch (err) {
    console.warn(`[Memory] Could not load data from disk: ${err.message}`);
    profiles = {};
    history = {};
  }
}

// ── Debounced save to disk ──
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2), 'utf-8');
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
    } catch (err) {
      console.warn(`[Memory] Could not save data to disk: ${err.message}`);
    }
  }, SAVE_DEBOUNCE_MS);
}

// ── User Profile Functions ──

export function getUserProfile(chatId) {
  if (!profiles[chatId]) {
    profiles[chatId] = {
      name: null,
      services: [],          // e.g. ['website', 'chatbot']
      projectDetails: null,  // e.g. 'restaurant website'
      budget: null,
      lang: 'ur',            // 'ur' = Roman Urdu, 'en' = English
      notes: [],             // important things user mentioned
      firstSeen: new Date().toISOString(),
      lastSeen: null,
      messageCount: 0,
    };
  }
  return profiles[chatId];
}

export function updateUserProfile(chatId, updates) {
  const profile = getUserProfile(chatId);
  Object.assign(profile, { ...updates, lastSeen: new Date().toISOString() });
  scheduleSave();
}

export function addUserNote(chatId, note) {
  const profile = getUserProfile(chatId);
  if (!profile.notes) profile.notes = [];
  if (!profile.notes.includes(note)) {
    profile.notes.push(note);
    if (profile.notes.length > 20) profile.notes = profile.notes.slice(-20);
  }
  scheduleSave();
}

export function addServiceInterest(chatId, service) {
  const profile = getUserProfile(chatId);
  if (!profile.services) profile.services = [];
  if (!profile.services.includes(service)) {
    profile.services.push(service);
    scheduleSave();
  }
}

// ── Chat History Functions ──

export function addMessage(chatId, role, text, type = 'text') {
  if (!history[chatId]) history[chatId] = [];

  history[chatId].push({
    role,   // 'user' | 'assistant'
    text: text?.substring(0, 1000) || '',  // trim very long messages
    timestamp: new Date().toISOString(),
    type,   // 'text' | 'voice' | 'image' | 'video'
  });

  // Keep last 500 messages
  if (history[chatId].length > MAX_HISTORY_PER_USER) {
    history[chatId] = history[chatId].slice(-MAX_HISTORY_PER_USER);
  }

  // Update profile message count
  const profile = getUserProfile(chatId);
  profile.messageCount = (profile.messageCount || 0) + 1;
  profile.lastSeen = new Date().toISOString();

  scheduleSave();
}

export function getRecentHistory(chatId, limit = 20) {
  const msgs = history[chatId] || [];
  return msgs.slice(-limit);
}

export function getAllHistory(chatId) {
  return history[chatId] || [];
}

export function getTotalMessageCount(chatId) {
  return (history[chatId] || []).length;
}

/**
 * Build a rich context string for the AI system prompt.
 * Includes user profile + conversation summary so AI knows everything about the user.
 */
export function buildUserContext(chatId) {
  const profile = getUserProfile(chatId);
  const allMsgs = getAllHistory(chatId);

  const lines = [];

  lines.push('=== USER MEMORY / PROFILE ===');

  if (profile.name) lines.push(`• Naam: ${profile.name}`);

  if (profile.services && profile.services.length > 0) {
    lines.push(`• Interested services: ${profile.services.join(', ')}`);
  }

  if (profile.projectDetails) lines.push(`• Project details: ${profile.projectDetails}`);
  if (profile.budget) lines.push(`• Budget discussed: ${profile.budget}`);
  if (profile.lang) lines.push(`• Preferred language: ${profile.lang === 'ur' ? 'Roman Urdu' : 'English'}`);

  if (profile.notes && profile.notes.length > 0) {
    lines.push(`• Key notes about user: ${profile.notes.join(' | ')}`);
  }

  if (profile.firstSeen) lines.push(`• First contact: ${new Date(profile.firstSeen).toLocaleDateString('en-PK')}`);
  if (profile.lastSeen) lines.push(`• Last seen: ${new Date(profile.lastSeen).toLocaleDateString('en-PK')}`);
  lines.push(`• Total messages exchanged: ${allMsgs.length}`);

  // Add yesterday/older conversation summary if available
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const olderMsgs = allMsgs.filter(m => new Date(m.timestamp) < yesterday);
  if (olderMsgs.length > 0) {
    lines.push(`• Previous sessions: ${olderMsgs.length} older messages on file`);
    // Summarize last older user messages
    const lastOlderUserMsgs = olderMsgs
      .filter(m => m.role === 'user')
      .slice(-5)
      .map(m => `"${m.text.substring(0, 60)}"`)
      .join(', ');
    if (lastOlderUserMsgs) lines.push(`• Last things user said in older sessions: ${lastOlderUserMsgs}`);
  }

  lines.push('=== END USER MEMORY ===');

  return lines.join('\n');
}

/**
 * Get recent history in Groq/OpenAI format (role: user/assistant)
 */
export function getGroqHistory(chatId, limit = 20) {
  return getRecentHistory(chatId, limit).map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.text || ''
  })).filter(m => m.content);
}

/**
 * Get recent history in Gemini format (role: user/model)
 */
export function getGeminiHistory(chatId, limit = 20) {
  return getRecentHistory(chatId, limit).map(m => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.text || '' }]
  })).filter(m => m.parts[0].text);
}

export function clearUserMemory(chatId) {
  delete profiles[chatId];
  delete history[chatId];
  scheduleSave();
}

export function getStats() {
  return {
    totalUsers: Object.keys(profiles).length,
    totalMessages: Object.values(history).reduce((a, h) => a + h.length, 0),
  };
}

// Load on module init
loadData();
