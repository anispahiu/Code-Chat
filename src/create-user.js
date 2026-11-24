import { randomBytes } from 'node:crypto';
import { hashPassword, normalizeEmail } from './auth.js';
import { openDatabase } from './db.js';

process.umask(0o077);

function usage() {
  console.error('Usage:');
  console.error('  npm run create-user -- client@example.com [--name "Full Name"]');
  console.error('  npm run create-user -- --admin admin@example.com [--name "Admin Name"]');
  console.error('  npm run create-user -- --promote-admin existing@example.com');
  process.exit(1);
}

const args = process.argv.slice(2);
let role = 'client';
let promote = false;
let name = '';
let rawEmail = '';

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--admin') {
    role = 'admin';
  } else if (arg === '--promote-admin') {
    promote = true;
  } else if (arg === '--name') {
    if (i + 1 >= args.length) usage();
    name = args[++i].trim();
  } else if (arg.startsWith('--')) {
    usage();
  } else if (!rawEmail) {
    rawEmail = arg;
  } else {
    usage();
  }
}

const email = normalizeEmail(rawEmail);
if (!email || (promote && role === 'admin') || name.length > 120) {
  usage();
}

const db = openDatabase();
try {
  if (promote) {
    const result = db.prepare(
      "UPDATE users SET role = 'admin', disabled = 0 WHERE email = ?",
    ).run(email);
    if (!result.changes) {
      console.error('No account found with that email.');
      process.exitCode = 1;
    } else {
      console.log(`Promoted to admin: ${email}`);
    }
  } else {
    const password = randomBytes(24).toString('base64url');
    const hash = await hashPassword(password);
    const createdAt = new Date().toISOString();
    const result = db.prepare(
      'INSERT INTO users (email, password_hash, name, role, disabled, created_at) VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT(email) DO NOTHING',
    ).run(email, hash, name, role, createdAt);
    if (!result.changes) {
      console.error('An account with that email already exists.');
      process.exitCode = 1;
    } else {
      console.log(`Role: ${role}\nEmail: ${email}\nPassword: ${password}`);
    }
  }
} finally {
  db.close();
}
