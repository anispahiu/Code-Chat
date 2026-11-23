CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS chats_by_user ON chats(user_id);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL CHECK (length(content) > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  request_id TEXT,
  reply_to INTEGER,
  CHECK (
    (role = 'user' AND request_id IS NOT NULL AND reply_to IS NULL)
    OR (role = 'assistant' AND request_id IS NULL AND reply_to IS NOT NULL)
  ),
  UNIQUE (chat_id, id),
  UNIQUE (chat_id, request_id),
  UNIQUE (chat_id, reply_to),
  FOREIGN KEY (chat_id, reply_to) REFERENCES messages(chat_id, id)
) STRICT;

CREATE TRIGGER IF NOT EXISTS chats_no_update BEFORE UPDATE ON chats
BEGIN
  SELECT RAISE(ABORT, 'Chats are append-only');
END;

CREATE TRIGGER IF NOT EXISTS chats_no_delete BEFORE DELETE ON chats
BEGIN
  SELECT RAISE(ABORT, 'Chats are append-only');
END;

CREATE TRIGGER IF NOT EXISTS messages_no_update BEFORE UPDATE ON messages
BEGIN
  SELECT RAISE(ABORT, 'Messages are append-only');
END;

CREATE TRIGGER IF NOT EXISTS messages_no_delete BEFORE DELETE ON messages
BEGIN
  SELECT RAISE(ABORT, 'Messages are append-only');
END;
