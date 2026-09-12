import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const AUTH_DIR = path.resolve('auth_info_baileys');
const BACKUP_DIR = path.resolve('auth_info_baileys_backup');

/**
 * Packs all files in auth_info_baileys into a compressed base64 string.
 */
export function packSessionToBase64() {
  try {
    if (!fs.existsSync(AUTH_DIR)) return null;
    const files = fs.readdirSync(AUTH_DIR);
    if (files.length === 0) return null;

    const dataMap = {};
    for (const file of files) {
      const filePath = path.join(AUTH_DIR, file);
      if (fs.statSync(filePath).isFile()) {
        dataMap[file] = fs.readFileSync(filePath, 'utf-8');
      }
    }

    const jsonStr = JSON.stringify(dataMap);
    const compressed = zlib.gzipSync(Buffer.from(jsonStr, 'utf-8'));
    return compressed.toString('base64');
  } catch (err) {
    console.error('[SessionManager] Pack Error:', err.message);
    return null;
  }
}

/**
 * Restores all files in auth_info_baileys from a compressed base64 string.
 */
export function restoreSessionFromBase64(base64Data) {
  try {
    if (!base64Data || typeof base64Data !== 'string') return false;

    const compressed = Buffer.from(base64Data.trim(), 'base64');
    const decompressed = zlib.gunzipSync(compressed).toString('utf-8');
    const dataMap = JSON.parse(decompressed);

    if (!fs.existsSync(AUTH_DIR)) {
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    }

    let restoredCount = 0;
    for (const [filename, content] of Object.entries(dataMap)) {
      const filePath = path.join(AUTH_DIR, filename);
      fs.writeFileSync(filePath, content, 'utf-8');
      restoredCount++;
    }

    sanitizeCredsRegistration();
    console.log(`[SessionManager] Successfully restored ${restoredCount} auth files from environment session.`);
    return true;
  } catch (err) {
    console.error('[SessionManager] Restore Error:', err.message);
    return false;
  }
}

/**
 * Ensures creds.json has registered=true if me identity exists.
 */
export function sanitizeCredsRegistration() {
  const credsPath = path.join(AUTH_DIR, 'creds.json');
  try {
    if (fs.existsSync(credsPath)) {
      const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
      if (creds.me && creds.registered !== true) {
        creds.registered = true;
        fs.writeFileSync(credsPath, JSON.stringify(creds, null, 2), 'utf-8');
        console.log('[SessionManager] Auto-fixed creds.json: registered flag set to true for WhatsApp link.');
      }
    }
  } catch (e) {}
}

/**
 * Syncs current auth_info_baileys to local backup folder and .env base64 string
 */
export function persistSession() {
  try {
    sanitizeCredsRegistration();

    // 1. Copy to local backup folder
    if (fs.existsSync(AUTH_DIR)) {
      if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const files = fs.readdirSync(AUTH_DIR);
      for (const f of files) {
        const src = path.join(AUTH_DIR, f);
        if (fs.statSync(src).isFile()) {
          fs.copyFileSync(src, path.join(BACKUP_DIR, f));
        }
      }
    }

    // 2. Update .env
    const b64 = packSessionToBase64();
    if (b64) {
      const envPath = path.resolve('.env');
      let lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8').split(/\r?\n/) : [];
      let found = false;
      lines = lines.map(line => {
        if (line.startsWith('SESSION_DATA_BASE64=')) {
          found = true;
          return `SESSION_DATA_BASE64=${b64}`;
        }
        return line;
      });
      if (!found) lines.push(`SESSION_DATA_BASE64=${b64}`);
      fs.writeFileSync(envPath, lines.join('\n'), 'utf-8');
    }
    console.log('[SessionManager] Session permanently backed up to folder and .env');
  } catch (err) {
    console.error('[SessionManager] Persist Error:', err.message);
  }
}

/**
 * Ensures session is loaded on boot if auth_info_baileys is missing or incomplete.
 */
export function ensureSessionRestored() {
  const credsPath = path.join(AUTH_DIR, 'creds.json');
  const hasLocalCreds = fs.existsSync(credsPath) && fs.statSync(credsPath).size > 100;

  if (hasLocalCreds) {
    sanitizeCredsRegistration();
    return true;
  }

  // Check backup directory
  const backupCreds = path.join(BACKUP_DIR, 'creds.json');
  if (fs.existsSync(backupCreds) && fs.statSync(backupCreds).size > 100) {
    console.log('[SessionManager] Restoring from auth_info_baileys_backup directory...');
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    for (const f of fs.readdirSync(BACKUP_DIR)) {
      fs.copyFileSync(path.join(BACKUP_DIR, f), path.join(AUTH_DIR, f));
    }
    sanitizeCredsRegistration();
    return true;
  }

  // Check .env base64
  let sessionEnv = process.env.SESSION_DATA_BASE64 || process.env.WHATSAPP_SESSION_BASE64 || process.env.SESSION_DATA;
  if (!sessionEnv && process.env.SESSION_DATA_BASE64_1) {
    sessionEnv = (process.env.SESSION_DATA_BASE64_1 || '') +
                 (process.env.SESSION_DATA_BASE64_2 || '') +
                 (process.env.SESSION_DATA_BASE64_3 || '') +
                 (process.env.SESSION_DATA_BASE64_4 || '');
  }

  if (sessionEnv) {
    console.log('[SessionManager] auth_info_baileys missing or empty. Restoring from SESSION_DATA_BASE64 environment variables...');
    const ok = restoreSessionFromBase64(sessionEnv);
    if (ok) sanitizeCredsRegistration();
    return ok;
  }

  return false;
}
