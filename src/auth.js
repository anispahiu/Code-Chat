import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const deriveKey = promisify(scrypt);
const scryptOptions = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

export function validPassword(value) {
  return typeof value === 'string' && value.length >= 1 && Buffer.byteLength(value) <= 256;
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await deriveKey(password, salt, 32, scryptOptions);
  return `${salt}:${key.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [salt, key] = (stored || `${'0'.repeat(32)}:${'0'.repeat(64)}`).split(':');
  const actual = await deriveKey(password, salt, 32, scryptOptions);
  return timingSafeEqual(actual, Buffer.from(key, 'hex')) && Boolean(stored);
}

export function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}
