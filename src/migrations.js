export const migrations = [
  {
    version: 1,
    up(db) {
      db.exec("ALTER TABLE users ADD COLUMN name TEXT NOT NULL DEFAULT ''");
      db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'client' CHECK (role IN ('admin', 'client'))");
      db.exec('ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1))');
      db.exec("ALTER TABLE users ADD COLUMN created_at TEXT NOT NULL DEFAULT ''");
      db.exec('CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions(user_id)');
    },
  },
  {
    version: 2,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          deleted_at TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ) STRICT;

        CREATE UNIQUE INDEX IF NOT EXISTS projects_active_name
          ON projects(name) WHERE deleted_at IS NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS projects_active_path
          ON projects(relative_path) WHERE deleted_at IS NULL;
      `);
    },
  },
  {
    version: 3,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_assignments (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          PRIMARY KEY (user_id, project_id)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS assignments_by_project ON project_assignments(project_id);
      `);
    },
  },
  {
    version: 4,
    up(db) {
      const hasProjectId = db.prepare('PRAGMA table_info(chats)').all().some((col) => col.name === 'project_id');
      if (hasProjectId) return;
      const existingChats = db.prepare('SELECT COUNT(*) AS count FROM chats').get().count;
      if (existingChats > 0) {
        throw new Error('Existing single-repo chats found; multi-project mode requires starting from a fresh database.');
      }
      db.exec(`
        DROP TRIGGER IF EXISTS messages_no_delete;
        DROP TRIGGER IF EXISTS messages_no_update;
        DROP TRIGGER IF EXISTS chats_no_delete;
        DROP TRIGGER IF EXISTS chats_no_update;
        DROP TABLE messages;
        DROP TABLE chats;

        CREATE TABLE chats (
          id TEXT PRIMARY KEY NOT NULL,
          user_id INTEGER NOT NULL REFERENCES users(id),
          project_id INTEGER NOT NULL REFERENCES projects(id),
          title TEXT NOT NULL
        ) STRICT;

        CREATE INDEX chats_by_user ON chats(user_id);
        CREATE INDEX chats_by_user_project ON chats(user_id, project_id);
        CREATE INDEX chats_by_project ON chats(project_id);

        CREATE TABLE messages (
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

        CREATE TRIGGER chats_no_update BEFORE UPDATE ON chats
        BEGIN
          SELECT RAISE(ABORT, 'Chats are append-only');
        END;

        CREATE TRIGGER chats_no_delete BEFORE DELETE ON chats
        BEGIN
          SELECT RAISE(ABORT, 'Chats are append-only');
        END;

        CREATE TRIGGER messages_no_update BEFORE UPDATE ON messages
        BEGIN
          SELECT RAISE(ABORT, 'Messages are append-only');
        END;

        CREATE TRIGGER messages_no_delete BEFORE DELETE ON messages
        BEGIN
          SELECT RAISE(ABORT, 'Messages are append-only');
        END;
      `);
    },
  },
];

export function runMigrations(db, list = migrations) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  const pending = [...list]
    .filter((migration) => migration.version > current)
    .sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
