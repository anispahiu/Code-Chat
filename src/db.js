import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openDatabase() {
  const path = resolve(process.env.DATABASE_PATH || 'data/code-chat.sqlite');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA recursive_triggers = ON');
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  return db;
}
