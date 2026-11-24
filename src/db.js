import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './migrations.js';

export function openDatabase(dbPath) {
  const target = dbPath ?? (process.env.DATABASE_PATH || 'data/code-chat.sqlite');
  const resolved = target === ':memory:' ? target : resolve(target);
  if (resolved !== ':memory:') {
    mkdirSync(dirname(resolved), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(resolved);
  db.exec('PRAGMA busy_timeout = 5000');
  if (resolved !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
  }
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA recursive_triggers = ON');
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  runMigrations(db);
  return db;
}
