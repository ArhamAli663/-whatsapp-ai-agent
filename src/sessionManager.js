import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const AUTH_DIR = path.resolve('auth_info_baileys');

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

    console.log(`[SessionManager] Successfully restored ${restoredCount} auth files from environment session.`);
    return true;
  } catch (err) {
    console.error('[SessionManager] Restore Error:', err.message);
    return false;
  }
}

/**
 * Ensures session is loaded on boot if auth_info_baileys is missing or incomplete.
 */
export function ensureSessionRestored() {
  const credsPath = path.join(AUTH_DIR, 'creds.json');
  const hasLocalCreds = fs.existsSync(credsPath) && fs.statSync(credsPath).size > 100;

  if (!hasLocalCreds) {
    const sessionEnv = process.env.SESSION_DATA_BASE64 || process.env.WHATSAPP_SESSION_BASE64 || process.env.SESSION_DATA;
    if (sessionEnv) {
      console.log('[SessionManager] auth_info_baileys missing or empty. Restoring from SESSION_DATA_BASE64...');
      return restoreSessionFromBase64(sessionEnv);
    }
  }
  return hasLocalCreds;
}
