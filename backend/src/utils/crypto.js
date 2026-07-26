const crypto = require('crypto');

// Derived (via scrypt) from CREDENTIALS_ENCRYPTION_KEY so any passphrase length
// works, not just an exact 32-byte hex string. Falls back to a fixed dev key
// with a loud warning — set CREDENTIALS_ENCRYPTION_KEY in .env for real use.
const SECRET = process.env.CREDENTIALS_ENCRYPTION_KEY;
if (!SECRET) {
  console.warn('[crypto] CREDENTIALS_ENCRYPTION_KEY not set — using an insecure default. Set it in .env before storing real credentials.');
}
const KEY = crypto.scryptSync(SECRET || 'insecure-dev-key-do-not-use-in-prod', 'qa-tool-auth-credentials', 32);

const ALGORITHM = 'aes-256-gcm';

/** Encrypts plaintext into "iv:authTag:ciphertext" (all base64). */
function encrypt(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/** Decrypts a string produced by encrypt(). Returns the original as stored if it isn't in that format (e.g. pre-encryption legacy rows). */
function decrypt(payload) {
  if (typeof payload !== 'string' || payload.split(':').length !== 3) return payload;
  const [ivB64, authTagB64, ciphertextB64] = payload.split(':');
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, KEY, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, 'base64')), decipher.final()]);
    return plain.toString('utf8');
  } catch {
    return payload;
  }
}

module.exports = { encrypt, decrypt };
