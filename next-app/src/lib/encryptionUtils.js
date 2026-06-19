import CryptoJS from 'crypto-js';

const KEY = process.env.ENCRYPTION_KEY;

export function encryptData(plainObject) {
  const json = JSON.stringify(plainObject);
  return CryptoJS.AES.encrypt(json, KEY).toString();
}

export function decryptData(cipherText) {
  const bytes = CryptoJS.AES.decrypt(cipherText, KEY);
  const decrypted = bytes.toString(CryptoJS.enc.Utf8);
  return JSON.parse(decrypted);
}

export function encryptField(value) {
  if (typeof value !== 'string') value = String(value);
  return CryptoJS.AES.encrypt(value, KEY).toString();
}

export function decryptField(cipher) {
  const bytes = CryptoJS.AES.decrypt(cipher, KEY);
  return bytes.toString(CryptoJS.enc.Utf8);
}

// Deep-encrypt all leaf string values in an object
export function deepEncryptObject(obj) {
  if (typeof obj === 'string') return encryptField(obj);
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(deepEncryptObject);
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = deepEncryptObject(v);
  }
  return result;
}

export function deepDecryptObject(obj) {
  if (typeof obj === 'string') {
    try { return decryptField(obj); } catch { return obj; }
  }
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(deepDecryptObject);
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = deepDecryptObject(v);
  }
  return result;
}