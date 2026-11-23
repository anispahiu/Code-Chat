import { randomBytes } from 'node:crypto';
import { hashPassword, normalizeEmail } from './auth.js';
import { openDatabase } from './db.js';

process.umask(0o077);

const email = normalizeEmail(process.argv[2]);
if (!email || process.argv.length !== 3) {
  console.error('Usage: npm run create-user -- client@example.com');
  process.exit(1);
}

const db = openDatabase();
try {
  const password = randomBytes(24).toString('base64url');
  const hash = await hashPassword(password);
  const result = db.prepare(
    'INSERT INTO users (email, password_hash) VALUES (?, ?) ON CONFLICT(email) DO NOTHING',
  ).run(email, hash);
  if (!result.changes) {
    console.error('An account with that email already exists.');
    process.exitCode = 1;
  } else {
    console.log(`Email: ${email}\nPassword: ${password}`);
  }
} finally {
  db.close();
}
