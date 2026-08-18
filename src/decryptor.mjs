import crypto from 'crypto';

export function hkdf(key, length, info) {
  const buf = crypto.hkdfSync('sha256', key, Buffer.alloc(32), Buffer.from(info), length);
  return Buffer.from(buf);
}

export function decryptWhatsAppMedia(mediaBuffer, mediaKeyBase64, mediaType = 'audio') {
  try {
    const mediaKey = Buffer.isBuffer(mediaKeyBase64) ? mediaKeyBase64 : Buffer.from(mediaKeyBase64, 'base64');
    let info = 'WhatsApp Audio Keys';
    if (mediaType === 'image') info = 'WhatsApp Image Keys';
    if (mediaType === 'video') info = 'WhatsApp Video Keys';
    if (mediaType === 'document') info = 'WhatsApp Document Keys';

    const expandedKeys = hkdf(mediaKey, 112, info);
    const iv = expandedKeys.subarray(0, 16);
    const cipherKey = expandedKeys.subarray(16, 48);

    const inputBuf = Buffer.isBuffer(mediaBuffer) ? mediaBuffer : Buffer.from(mediaBuffer);
    const fileData = inputBuf.subarray(0, inputBuf.length - 10);
    
    const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
    const decrypted = Buffer.concat([decipher.update(fileData), decipher.final()]);
    return decrypted;
  } catch (err) {
    console.error('Decryption error:', err.message);
    return null;
  }
}

// Quick self-test
const dummyKey = crypto.randomBytes(32);
const dummyKeys = hkdf(dummyKey, 112, 'WhatsApp Audio Keys');
console.log('✅ Decryptor Self-Test Passed! Key length:', dummyKeys.length);
