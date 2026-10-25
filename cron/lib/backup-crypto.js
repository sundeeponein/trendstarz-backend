// Encryption for database backups (AES-256-GCM). Shared by the nightly backup
// (src/data-integrity/database-backup.service.ts) and cron/restoreDatabase.js.
//
// File layout: "TSBK1" | 12-byte IV | 16-byte auth tag | ciphertext (the gzip).
// Key: BACKUP_ENCRYPTION_KEY = 64 hex characters (openssl rand -hex 32).
// Without the key a backup can't be read — keep a copy of it outside Railway.

const crypto = require('crypto');

const MAGIC = Buffer.from('TSBK1');

function keyFrom(hex) {
  const key = Buffer.from(String(hex || '').trim(), 'hex');
  if (key.length !== 32) throw new Error('BACKUP_ENCRYPTION_KEY must be 64 hex characters (openssl rand -hex 32).');
  return key;
}

function encryptBackup(plain, hexKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(hexKey), iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

function isEncryptedBackup(buf) {
  return Buffer.isBuffer(buf) && buf.length > MAGIC.length + 28 && buf.subarray(0, MAGIC.length).equals(MAGIC);
}

/** Decrypts (and checks the file wasn't changed: GCM fails on any tampering). */
function decryptBackup(buf, hexKey) {
  if (!isEncryptedBackup(buf)) throw new Error('Not an encrypted TrendStarZ backup.');
  const iv = buf.subarray(5, 17);
  const tag = buf.subarray(17, 33);
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(hexKey), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(buf.subarray(33)), decipher.final()]);
}

module.exports = { encryptBackup, decryptBackup, isEncryptedBackup };
