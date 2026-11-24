import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { hashPassword, normalizeEmail, tokenHash, validPassword, verifyPassword } from './auth.js';
import { createCodeGraphCli } from './codegraph-cli.js';
import { checkInputGuardrail, checkOutputGuardrail } from './guardrails.js';
import { PathError, resolveProjectPath } from './paths.js';

const sessionSeconds = 7 * 24 * 60 * 60;
const uuid = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;
const maxQuestionLength = 4000;
const maxLoginKeys = 4096;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function parseOrigin(rawOrigin) {
  const base = new URL(rawOrigin);
  if (!['http:', 'https:'].includes(base.protocol) || base.href !== base.origin + '/') {
    throw new Error('APP_ORIGIN must be an HTTP(S) origin without a path.');
  }
  return base;
}

function loadAssets() {
  const assets = new Map(Object.entries({
    '/': ['text/html; charset=utf-8', 'index.html'],
    '/login': ['text/html; charset=utf-8', 'login.html'],
    '/admin': ['text/html; charset=utf-8', 'admin.html'],
    '/app.css': ['text/css; charset=utf-8', 'app.css'],
    '/app.js': ['text/javascript; charset=utf-8', 'app.js'],
    '/admin.js': ['text/javascript; charset=utf-8', 'admin.js'],
    '/markdown.js': ['text/javascript; charset=utf-8', 'markdown.js'],
    '/theme.js': ['text/javascript; charset=utf-8', 'theme.js'],
  }).map(([route, [type, file]]) => [route, [type, readFileSync(new URL(`../public/${file}`, import.meta.url))]]));
  assets.set('/markdown-it.js', [
    'text/javascript; charset=utf-8',
    readFileSync(new URL(import.meta.resolve('markdown-it/browser'))),
  ]);
  return assets;
}

function parsePositiveInt(raw) {
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const num = Number(raw);
  return Number.isSafeInteger(num) ? num : null;
}

function formatUser(row, projectIds = undefined) {
  const user = {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    disabled: Boolean(row.disabled),
    createdAt: row.created_at,
  };
  if (projectIds !== undefined) user.projectIds = projectIds;
  return user;
}

function formatProject(row, { job, chatCount = 0, assignedCount = 0 } = {}) {
  return {
    id: row.id,
    name: row.name,
    relativePath: row.relative_path,
    description: row.description,
    deletedAt: row.deleted_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    chatCount,
    assignedCount,
    job: job ?? null,
  };
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((info) => info.name === column);
}

function hasTable(db, table) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table));
}

export function createApp({
  db,
  answer,
  appOrigin,
  projectsBaseDir = process.env.PROJECTS_BASE_DIR || '',
  codegraphCli,
  mcpManager = null,
}) {
  const base = parseOrigin(appOrigin);
  const origin = base.origin;
  const secure = base.protocol === 'https:';
  const cookieName = secure ? '__Host-codechat' : 'codechat';
  const cli = codegraphCli ?? createCodeGraphCli({
    binary: process.env.CODEGRAPH_BIN || 'codegraph',
    onBeforeIndex: mcpManager ? (projectId) => mcpManager.stop(projectId) : undefined,
  });
  const chatsHaveProjectId = hasColumn(db, 'chats', 'project_id');
  const hasAssignmentsTable = hasTable(db, 'project_assignments');

  const findUser = db.prepare('SELECT * FROM users WHERE email = ?');
  const findUserById = db.prepare('SELECT id, email, name, role, disabled, created_at FROM users WHERE id = ?');
  const listUsers = db.prepare('SELECT id, email, name, role, disabled, created_at FROM users ORDER BY role DESC, email ASC');
  const insertUser = db.prepare(`
    INSERT INTO users (email, password_hash, name, role, disabled, created_at)
    VALUES (?, ?, ?, ?, 0, ?)
    ON CONFLICT(email) DO NOTHING
  `);
  const updateUser = db.prepare('UPDATE users SET email = ?, name = ?, disabled = ? WHERE id = ?');
  const updateUserPassword = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
  const countOtherActiveAdmins = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?");
  const deleteUserSessions = db.prepare('DELETE FROM sessions WHERE user_id = ?');

  const listActiveProjects = db.prepare('SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY name ASC');
  const findActiveProject = db.prepare('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL');
  const insertProject = db.prepare(`
    INSERT INTO projects (name, relative_path, description) VALUES (?, ?, ?)
  `);
  const updateProject = db.prepare(`
    UPDATE projects SET name = ?, relative_path = ?, description = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND deleted_at IS NULL
  `);
  const softDeleteProject = db.prepare(`
    UPDATE projects SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND deleted_at IS NULL
  `);
  const hardDeleteProject = db.prepare('DELETE FROM projects WHERE id = ?');
  const countProjectChats = chatsHaveProjectId
    ? db.prepare('SELECT COUNT(*) AS count FROM chats WHERE project_id = ?')
    : null;
  const deleteProjectChatMessages = chatsHaveProjectId
    ? db.prepare('DELETE FROM messages WHERE chat_id IN (SELECT id FROM chats WHERE project_id = ?)')
    : null;
  const deleteProjectChats = chatsHaveProjectId
    ? db.prepare('DELETE FROM chats WHERE project_id = ?')
    : null;
  const countProjectAssignments = hasAssignmentsTable
    ? db.prepare('SELECT COUNT(*) AS count FROM project_assignments WHERE project_id = ?')
    : null;
  const deleteProjectAssignments = hasAssignmentsTable
    ? db.prepare('DELETE FROM project_assignments WHERE project_id = ?')
    : null;
  const listUserAssignedProjectIds = hasAssignmentsTable
    ? db.prepare(`
      SELECT pa.project_id
      FROM project_assignments AS pa
      JOIN projects AS p ON p.id = pa.project_id
      WHERE pa.user_id = ? AND p.deleted_at IS NULL
      ORDER BY p.name ASC
    `)
    : null;
  const listAllActiveAssignments = hasAssignmentsTable
    ? db.prepare(`
      SELECT pa.user_id, pa.project_id
      FROM project_assignments AS pa
      JOIN projects AS p ON p.id = pa.project_id
      WHERE p.deleted_at IS NULL
      ORDER BY p.name ASC
    `)
    : null;
  const deleteUserAssignments = hasAssignmentsTable
    ? db.prepare('DELETE FROM project_assignments WHERE user_id = ?')
    : null;
  const insertAssignment = hasAssignmentsTable
    ? db.prepare('INSERT OR IGNORE INTO project_assignments (user_id, project_id) VALUES (?, ?)')
    : null;
  const removeAssignment = hasAssignmentsTable
    ? db.prepare('DELETE FROM project_assignments WHERE project_id = ? AND user_id = ?')
    : null;
  const listHistoryProjects = db.prepare(`
    SELECT id, name, deleted_at FROM projects
    WHERE deleted_at IS NULL OR id IN (SELECT DISTINCT project_id FROM chats)
    ORDER BY deleted_at IS NOT NULL ASC, name ASC
  `);
  const findAdminChat = db.prepare(`
    SELECT
      c.id,
      c.title,
      c.user_id,
      u.email AS user_email,
      u.name AS user_name,
      u.disabled AS user_disabled,
      c.project_id,
      p.name AS project_name,
      p.deleted_at AS project_deleted_at,
      EXISTS(
        SELECT 1 FROM project_assignments AS pa
        WHERE pa.user_id = c.user_id AND pa.project_id = c.project_id
      ) AS is_assigned
    FROM chats AS c
    JOIN users AS u ON u.id = c.user_id
    JOIN projects AS p ON p.id = c.project_id
    WHERE c.id = ?
  `);
  const findSession = db.prepare(`
    SELECT users.id, users.email, users.name, users.role
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE token_hash = ? AND expires_at > ? AND users.disabled = 0
  `);
  const addSession = db.prepare('INSERT INTO sessions VALUES (?, ?, ?)');
  const removeSession = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
  const purgeSessions = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');

  const listChatsByProject = db.prepare(`
    SELECT id, project_id, title FROM chats
    WHERE user_id = ? AND project_id = ?
    ORDER BY (SELECT MAX(id) FROM messages WHERE chat_id = chats.id) DESC
  `);
  const listAssignedChats = db.prepare(`
    SELECT c.id, c.project_id, c.title
    FROM chats AS c
    JOIN project_assignments AS pa ON pa.project_id = c.project_id AND pa.user_id = c.user_id
    JOIN projects AS p ON p.id = c.project_id
    WHERE c.user_id = ? AND p.deleted_at IS NULL
    ORDER BY (SELECT MAX(id) FROM messages WHERE chat_id = c.id) DESC
  `);
  const findChat = db.prepare('SELECT id, user_id, project_id, title FROM chats WHERE id = ?');
  const addChat = db.prepare('INSERT INTO chats (id, user_id, project_id, title) VALUES (?, ?, ?, ?)');
  const listAssignedProjects = db.prepare(`
    SELECT p.id, p.name, p.relative_path, p.description
    FROM project_assignments AS pa
    JOIN projects AS p ON p.id = pa.project_id
    WHERE pa.user_id = ? AND p.deleted_at IS NULL
    ORDER BY p.name ASC
  `);
  const findAssignedProject = db.prepare(`
    SELECT p.id, p.name, p.relative_path, p.description
    FROM project_assignments AS pa
    JOIN projects AS p ON p.id = pa.project_id
    WHERE pa.user_id = ? AND p.id = ? AND p.deleted_at IS NULL
  `);
  const listMessages = db.prepare(`
    SELECT id, role, content, created_at FROM messages WHERE chat_id = ? ORDER BY id
  `);
  const latestMessage = db.prepare('SELECT id, role, content FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1');
  const findRequest = db.prepare('SELECT id, content FROM messages WHERE chat_id = ? AND request_id = ?');
  const addQuestion = db.prepare(`
    INSERT INTO messages (chat_id, role, content, request_id) VALUES (?, 'user', ?, ?)
  `);
  const addAnswer = db.prepare(`
    INSERT INTO messages (chat_id, role, content, reply_to) VALUES (?, 'assistant', ?, ?)
  `);
  const readHistory = db.prepare(`
    SELECT question.content AS question, reply.content AS answer
    FROM messages AS reply
    JOIN messages AS question ON question.id = reply.reply_to
    WHERE reply.chat_id = ? AND reply.id < ?
    ORDER BY reply.id DESC LIMIT 7
  `);

  const assets = loadAssets();
  const inFlight = new Map();
  const loginAttempts = new Map();
  let closing = false;

  function send(res, status, body, type = 'application/json; charset=utf-8') {
    res.writeHead(status, { 'Content-Type': type });
    res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
  }

  function redirect(res, path) {
    res.writeHead(303, { Location: path });
    res.end();
  }

  function setSessionCookie(res, value, maxAge) {
    res.setHeader('Set-Cookie',
      `${cookieName}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`);
  }

  function sessionToken(req) {
    const prefix = `${cookieName}=`;
    const cookie = req.headers.cookie?.split(';').map((part) => part.trim())
      .find((part) => part.startsWith(prefix))?.slice(prefix.length);
    return cookie && /^[\w-]{43}$/.test(cookie) ? tokenHash(cookie) : null;
  }

  async function readBody(req, form = false) {
    const type = req.headers['content-type']?.split(';')[0].trim();
    if (type !== (form ? 'application/x-www-form-urlencoded' : 'application/json')) {
      throw new HttpError(415, 'Unsupported request format.');
    }

    let size = 0;
    const chunks = [];
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > 32_768) {
        req.resume();
        throw new HttpError(413, 'This request is too large.');
      }
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString('utf8');
    if (form) return Object.fromEntries(new URLSearchParams(body));
    try {
      const data = JSON.parse(body);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
      return data;
    } catch {
      throw new HttpError(400, 'Invalid request.');
    }
  }

  function rateLimit(key, limit) {
    const now = Date.now();
    const message = 'Too many sign-in attempts. Try again in 15 minutes.';
    let attempt = loginAttempts.get(key);
    if (!attempt || attempt.expiresAt <= now) {
      if (!attempt && loginAttempts.size >= maxLoginKeys) throw new HttpError(429, message);
      attempt = { count: 0, expiresAt: now + 15 * 60_000 };
      loginAttempts.set(key, attempt);
    }
    if (attempt.count >= limit) throw new HttpError(429, message);
    attempt.count++;
  }

  async function login(req, res, currentToken) {
    const form = req.headers['content-type']?.startsWith('application/x-www-form-urlencoded');
    try {
      rateLimit('ip:' + req.socket.remoteAddress, 60);
      const body = await readBody(req, form);
      const email = normalizeEmail(body.email);
      if (!email || !validPassword(body.password)) throw new HttpError(401, 'Email or password is incorrect.');
      rateLimit('email:' + email, 8);
      const user = findUser.get(email);
      const valid = await verifyPassword(body.password, user?.password_hash);
      if (!valid || user.disabled) {
        throw new HttpError(401, 'Email or password is incorrect.');
      }

      const token = randomBytes(32).toString('base64url');
      if (currentToken) removeSession.run(currentToken);
      addSession.run(tokenHash(token), user.id, Date.now() + sessionSeconds * 1000);
      loginAttempts.delete('email:' + email);
      setSessionCookie(res, token, sessionSeconds);
      if (form) return redirect(res, user.role === 'admin' ? '/admin' : '/');
      send(res, 200, { email: user.email, name: user.name, role: user.role });
    } catch (error) {
      if (!form || !(error instanceof HttpError)) throw error;
      redirect(res, error.status === 429 ? '/login?error=limit' : '/login?error=credentials');
    }
  }

  function chatView(chat) {
    const messages = listMessages.all(chat.id);
    const last = messages.at(-1);
    return {
      id: chat.id,
      projectId: chat.project_id,
      title: chat.title,
      messages,
      status: inFlight.has(chat.id) ? 'pending' : last?.role === 'user' ? 'unanswered' : 'ready',
    };
  }

  function requireCapacity(chatId) {
    if (inFlight.has(chatId)) throw new HttpError(409, 'An answer is already on its way.');
    if (inFlight.size >= 4) throw new HttpError(503, 'The assistant is busy. Try again in a moment.');
  }

  function queueAnswer(chatId, messageId, question, projectId, realPath) {
    const inputCheck = checkInputGuardrail(question);
    if (!inputCheck.allowed) {
      addAnswer.run(chatId, inputCheck.refusal, messageId);
      return;
    }

    const history = readHistory.all(chatId, messageId).reverse().flatMap((turn) => [
      { role: 'user', content: turn.question },
      { role: 'assistant', content: turn.answer },
    ]);
    history.push({ role: 'user', content: question });

    const exploreFn = mcpManager
      ? (query) => mcpManager.explore(projectId, realPath, query)
      : undefined;

    const job = answer(history, exploreFn)
      .then((response) => {
        const outputCheck = checkOutputGuardrail(response);
        const safeText = outputCheck.allowed ? outputCheck.text : outputCheck.refusal;
        addAnswer.run(chatId, safeText, messageId);
      })
      .catch((error) => console.error('Answer failed:', error.message))
      .finally(() => inFlight.delete(chatId));
    inFlight.set(chatId, job);
  }

  async function requireReadyProject(userId, projectId) {
    const project = findAssignedProject.get(userId, projectId);
    if (!project) throw new HttpError(404, 'Project not found.');
    if (cli.isLocked(project.id)) {
      throw new HttpError(503, 'Project index is currently updating. Try again shortly.');
    }
    let resolved;
    try {
      resolved = await resolveProjectPath(projectsBaseDir, project.relative_path);
    } catch {
      throw new HttpError(409, 'Project directory is currently unavailable. Contact your administrator.');
    }
    if (!(await cli.hasIndex(resolved.realPath))) {
      throw new HttpError(409, 'This project is not indexed yet. Ask your administrator to initialize CodeGraph.');
    }
    return { project, realPath: resolved.realPath };
  }

  async function route(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');

    const parsedUrl = new URL(req.url, origin);
    const path = parsedUrl.pathname;
    const method = req.method;
    if (method !== 'GET' && method !== 'HEAD' && req.headers.origin !== origin) {
      throw new HttpError(403, 'Refresh the page and try again.');
    }
    const token = sessionToken(req);
    const user = token && findSession.get(token, Date.now());

    if (method === 'GET' && path === '/admin') {
      if (!user) return redirect(res, '/login');
      if (user.role !== 'admin') throw new HttpError(403, 'Admin access required.');
      const [type, body] = assets.get('/admin');
      return send(res, 200, body, type);
    }

    if (method === 'GET' && assets.has(path)) {
      if (path === '/') {
        if (!user) return redirect(res, '/login');
        if (user.role === 'admin') return redirect(res, '/admin');
      }
      if (path === '/login' && user) return redirect(res, user.role === 'admin' ? '/admin' : '/');
      const [type, body] = assets.get(path);
      return send(res, 200, body, type);
    }

    if (method === 'POST' && path === '/api/login') return login(req, res, token);
    if (method === 'POST' && path === '/api/logout') {
      if (token) removeSession.run(token);
      setSessionCookie(res, '', 0);
      return redirect(res, '/login');
    }

    if (!path.startsWith('/api/')) throw new HttpError(404, 'Page not found.');
    if (!user) throw new HttpError(401, 'Sign in to continue.');

    if (method === 'GET' && path === '/api/me') {
      return send(res, 200, { id: user.id, email: user.email, name: user.name, role: user.role });
    }

    if (path.startsWith('/api/admin/') || path === '/api/admin') {
      if (user.role !== 'admin') throw new HttpError(403, 'Admin access required.');

      if (method === 'GET' && path === '/api/admin/users') {
        const byUser = new Map();
        if (listAllActiveAssignments) {
          for (const row of listAllActiveAssignments.all()) {
            const list = byUser.get(row.user_id) || [];
            list.push(row.project_id);
            byUser.set(row.user_id, list);
          }
        }
        return send(res, 200, {
          users: listUsers.all().map((row) => formatUser(row, byUser.get(row.id) || [])),
        });
      }

      if (method === 'POST' && path === '/api/admin/users') {
        const body = await readBody(req);
        const freshAdmin = findSession.get(token, Date.now());
        if (!freshAdmin || freshAdmin.role !== 'admin') throw new HttpError(401, 'Sign in to continue.');

        const email = normalizeEmail(body.email);
        if (!email) throw new HttpError(400, 'Enter a valid email address.');
        const name = body.name === undefined ? '' : typeof body.name === 'string' ? body.name.trim() : null;
        if (name === null || name.includes('\0') || name.length > 120) {
          throw new HttpError(400, 'Name must be 120 characters or fewer.');
        }
        const role = body.role === undefined ? 'client' : body.role;
        if (role !== 'client' && role !== 'admin') throw new HttpError(400, 'Invalid role.');

        const password = randomBytes(24).toString('base64url');
        const hash = await hashPassword(password);
        const createdAt = new Date().toISOString();
        const result = insertUser.run(email, hash, name, role, createdAt);
        if (!result.changes) throw new HttpError(409, 'An account with that email already exists.');
        const created = findUserById.get(Number(result.lastInsertRowid));
        return send(res, 201, { user: formatUser(created), password });
      }

      const userMatch = path.match(/^\/api\/admin\/users\/([^/]+)(\/(reset-password|projects))?$/);
      if (userMatch) {
        const targetId = parsePositiveInt(userMatch[1]);
        const userSub = userMatch[3] || '';
        const resetAction = userSub === 'reset-password';
        if (!targetId) throw new HttpError(404, 'User not found.');

        if (userSub === 'projects') {
          if (method === 'GET') {
            const target = findUserById.get(targetId);
            if (!target) throw new HttpError(404, 'User not found.');
            const projectIds = listUserAssignedProjectIds.all(targetId).map((row) => row.project_id);
            return send(res, 200, { userId: targetId, projectIds });
          }

          if (method === 'PUT') {
            const body = await readBody(req);
            const freshAdmin = findSession.get(token, Date.now());
            if (!freshAdmin || freshAdmin.role !== 'admin') throw new HttpError(401, 'Sign in to continue.');
            if (!Array.isArray(body.projectIds)) {
              throw new HttpError(400, 'projectIds must be an array.');
            }
            const uniqueIds = [];
            const seen = new Set();
            for (const rawId of body.projectIds) {
              if (!Number.isInteger(rawId) || rawId < 1) {
                throw new HttpError(400, 'Each project ID must be a positive integer.');
              }
              if (!seen.has(rawId)) {
                seen.add(rawId);
                uniqueIds.push(rawId);
              }
            }

            db.exec('BEGIN IMMEDIATE');
            try {
              const target = findUserById.get(targetId);
              if (!target) throw new HttpError(404, 'User not found.');
              for (const pid of uniqueIds) {
                if (!findActiveProject.get(pid)) {
                  throw new HttpError(404, `Project ${pid} not found.`);
                }
              }
              deleteUserAssignments.run(targetId);
              for (const pid of uniqueIds) {
                insertAssignment.run(targetId, pid);
              }
              db.exec('COMMIT');
              const projectIds = listUserAssignedProjectIds.all(targetId).map((row) => row.project_id);
              return send(res, 200, { userId: targetId, projectIds });
            } catch (error) {
              db.exec('ROLLBACK');
              throw error;
            }
          }
        }

        if (method === 'PATCH' && !userSub) {
          const body = await readBody(req);
          const freshAdmin = findSession.get(token, Date.now());
          if (!freshAdmin || freshAdmin.role !== 'admin') throw new HttpError(401, 'Sign in to continue.');

          db.exec('BEGIN IMMEDIATE');
          try {
            const target = findUserById.get(targetId);
            if (!target) throw new HttpError(404, 'User not found.');

            const email = body.email !== undefined ? normalizeEmail(body.email) : target.email;
            if (!email) throw new HttpError(400, 'Enter a valid email address.');
            const name = body.name !== undefined
              ? (typeof body.name === 'string' ? body.name.trim() : null)
              : target.name;
            if (name === null || name.includes('\0') || name.length > 120) {
              throw new HttpError(400, 'Name must be 120 characters or fewer.');
            }
            if (body.disabled !== undefined && typeof body.disabled !== 'boolean') {
              throw new HttpError(400, 'Invalid account status.');
            }
            const nextDisabled = body.disabled !== undefined ? (body.disabled ? 1 : 0) : target.disabled;

            if (nextDisabled === 1) {
              if (target.id === freshAdmin.id) {
                throw new HttpError(400, 'You cannot disable your own account.');
              }
              if (target.role === 'admin' && countOtherActiveAdmins.get(target.id).count === 0) {
                throw new HttpError(400, 'At least one active admin account is required.');
              }
            }

            try {
              updateUser.run(email, name, nextDisabled, target.id);
            } catch (err) {
              if (String(err.message).includes('UNIQUE')) {
                throw new HttpError(409, 'An account with that email already exists.');
              }
              throw err;
            }
            if (nextDisabled === 1) deleteUserSessions.run(target.id);
            const updated = findUserById.get(target.id);
            db.exec('COMMIT');
            return send(res, 200, { user: formatUser(updated) });
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
        }

        if (method === 'POST' && resetAction) {
          if (req.headers['content-type']) await readBody(req);
          const freshAdmin = findSession.get(token, Date.now());
          if (!freshAdmin || freshAdmin.role !== 'admin') throw new HttpError(401, 'Sign in to continue.');

          const existing = findUserById.get(targetId);
          if (!existing) throw new HttpError(404, 'User not found.');
          const password = randomBytes(24).toString('base64url');
          const hash = await hashPassword(password);

          db.exec('BEGIN IMMEDIATE');
          try {
            const target = findUserById.get(targetId);
            if (!target) throw new HttpError(404, 'User not found.');
            updateUserPassword.run(hash, target.id);
            deleteUserSessions.run(target.id);
            db.exec('COMMIT');
            return send(res, 200, { user: formatUser(target), password });
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
        }
      }

      if (method === 'GET' && path === '/api/admin/projects') {
        const rows = listActiveProjects.all();
        return send(res, 200, {
          projects: rows.map((row) => formatProject(row, {
            job: cli.getJob(row.id),
            chatCount: countProjectChats ? countProjectChats.get(row.id).count : 0,
            assignedCount: countProjectAssignments ? countProjectAssignments.get(row.id).count : 0,
          })),
        });
      }

      if (method === 'POST' && path === '/api/admin/projects') {
        const body = await readBody(req);
        const freshAdmin = findSession.get(token, Date.now());
        if (!freshAdmin || freshAdmin.role !== 'admin') throw new HttpError(401, 'Sign in to continue.');

        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name || name.includes('\0') || name.length > 120) {
          throw new HttpError(400, 'Enter a project name of 1 to 120 characters.');
        }
        const description = body.description === undefined ? '' : typeof body.description === 'string' ? body.description.trim() : null;
        if (description === null || description.includes('\0') || description.length > 500) {
          throw new HttpError(400, 'Description must be 500 characters or fewer.');
        }

        let resolved;
        try {
          resolved = await resolveProjectPath(projectsBaseDir, body.relativePath);
        } catch (error) {
          if (error instanceof PathError) {
            throw new HttpError(error.code === 'BASE_DIR_INVALID' ? 500 : 400, error.message);
          }
          throw error;
        }

        let createdId;
        try {
          createdId = Number(insertProject.run(name, resolved.relativePath, description).lastInsertRowid);
        } catch (error) {
          if (String(error.message).includes('UNIQUE')) {
            throw new HttpError(409, 'A project with that name or path already exists.');
          }
          throw error;
        }
        const created = findActiveProject.get(createdId);
        return send(res, 201, {
          project: formatProject(created, { job: cli.getJob(created.id), chatCount: 0, assignedCount: 0 }),
        });
      }

      const assignMatch = path.match(/^\/api\/admin\/projects\/([^/]+)\/assignments(?:\/([^/]+))?$/);
      if (assignMatch) {
        const projectId = parsePositiveInt(assignMatch[1]);
        const userIdParam = assignMatch[2] ? parsePositiveInt(assignMatch[2]) : null;
        if (!projectId || (assignMatch[2] && !userIdParam)) {
          throw new HttpError(404, 'Assignment target not found.');
        }

        if (method === 'POST' && !assignMatch[2]) {
          const body = await readBody(req);
          const freshAdmin = findSession.get(token, Date.now());
          if (!freshAdmin || freshAdmin.role !== 'admin') throw new HttpError(401, 'Sign in to continue.');
          if (!Number.isInteger(body.userId) || body.userId < 1) {
            throw new HttpError(400, 'Enter a valid userId.');
          }
          if (!findActiveProject.get(projectId)) throw new HttpError(404, 'Project not found.');
          if (!findUserById.get(body.userId)) throw new HttpError(404, 'User not found.');
          insertAssignment.run(body.userId, projectId);
          return send(res, 200, { assigned: true, projectId, userId: body.userId });
        }

        if (method === 'DELETE' && userIdParam) {
          const freshAdmin = findSession.get(token, Date.now());
          if (!freshAdmin || freshAdmin.role !== 'admin') throw new HttpError(401, 'Sign in to continue.');
          removeAssignment.run(projectId, userIdParam);
          return send(res, 200, { removed: true, projectId, userId: userIdParam });
        }
      }

      const projectMatch = path.match(/^\/api\/admin\/projects\/([^/]+)(\/(status|init|sync|job))?$/);
      if (projectMatch) {
        const projectId = parsePositiveInt(projectMatch[1]);
        const subAction = projectMatch[3] || '';
        if (!projectId) throw new HttpError(404, 'Project not found.');

        if (method === 'PATCH' && !subAction) {
          const body = await readBody(req);
          const freshAdmin = findSession.get(token, Date.now());
          if (!freshAdmin || freshAdmin.role !== 'admin') throw new HttpError(401, 'Sign in to continue.');
          if (cli.isLocked(projectId)) {
            throw new HttpError(409, 'Wait for the current indexing job to finish before editing.');
          }

          const existing = findActiveProject.get(projectId);
          if (!existing) throw new HttpError(404, 'Project not found.');

          const name = body.name !== undefined
            ? (typeof body.name === 'string' ? body.name.trim() : '')
            : existing.name;
          if (!name || name.includes('\0') || name.length > 120) {
            throw new HttpError(400, 'Enter a project name of 1 to 120 characters.');
          }
          const description = body.description !== undefined
            ? (typeof body.description === 'string' ? body.description.trim() : null)
            : existing.description;
          if (description === null || description.includes('\0') || description.length > 500) {
            throw new HttpError(400, 'Description must be 500 characters or fewer.');
          }

          let nextRelativePath = existing.relative_path;
          if (body.relativePath !== undefined) {
            try {
              const resolved = await resolveProjectPath(projectsBaseDir, body.relativePath);
              nextRelativePath = resolved.relativePath;
            } catch (error) {
              if (error instanceof PathError) {
                throw new HttpError(error.code === 'BASE_DIR_INVALID' ? 500 : 400, error.message);
              }
              throw error;
            }
          }

          const pathChanged = nextRelativePath !== existing.relative_path;
          if (pathChanged && mcpManager) {
            await mcpManager.stop(projectId);
          }

          try {
            const updatedRes = updateProject.run(name, nextRelativePath, description, projectId);
            if (!updatedRes.changes) throw new HttpError(404, 'Project not found.');
          } catch (error) {
            if (error instanceof HttpError) throw error;
            if (String(error.message).includes('UNIQUE')) {
              throw new HttpError(409, 'A project with that name or path already exists.');
            }
            throw error;
          }
          const updated = findActiveProject.get(projectId);
          return send(res, 200, {
            project: formatProject(updated, {
              job: cli.getJob(projectId),
              chatCount: countProjectChats ? countProjectChats.get(projectId).count : 0,
              assignedCount: countProjectAssignments ? countProjectAssignments.get(projectId).count : 0,
            }),
          });
        }

        if (method === 'DELETE' && !subAction) {
          const body = req.headers['content-type'] ? await readBody(req) : {};
          const freshAdmin = findSession.get(token, Date.now());
          if (!freshAdmin || freshAdmin.role !== 'admin') throw new HttpError(401, 'Sign in to continue.');
          if (cli.isLocked(projectId)) {
            throw new HttpError(409, 'Wait for the current indexing job to finish before deleting.');
          }
          if (body.deleteChats !== undefined && typeof body.deleteChats !== 'boolean') {
            throw new HttpError(400, 'Invalid deleteChats option.');
          }
          const deleteChats = Boolean(body.deleteChats);
          const existing = findActiveProject.get(projectId);
          if (!existing) throw new HttpError(404, 'Project not found.');

          if (mcpManager) await mcpManager.stop(projectId);

          db.exec('BEGIN IMMEDIATE');
          try {
            const target = findActiveProject.get(projectId);
            if (!target) throw new HttpError(404, 'Project not found.');
            const chatCount = countProjectChats ? countProjectChats.get(projectId).count : 0;

            if (deleteChats && chatCount > 0) {
              db.exec('DROP TRIGGER IF EXISTS messages_no_delete');
              db.exec('DROP TRIGGER IF EXISTS chats_no_delete');
              deleteProjectChatMessages.run(projectId);
              deleteProjectChats.run(projectId);
              hardDeleteProject.run(projectId);
              db.exec(`
                CREATE TRIGGER IF NOT EXISTS chats_no_delete BEFORE DELETE ON chats
                BEGIN
                  SELECT RAISE(ABORT, 'Chats are append-only');
                END;
                CREATE TRIGGER IF NOT EXISTS messages_no_delete BEFORE DELETE ON messages
                BEGIN
                  SELECT RAISE(ABORT, 'Messages are append-only');
                END;
              `);
            } else if (chatCount === 0) {
              hardDeleteProject.run(projectId);
            } else {
              if (deleteProjectAssignments) deleteProjectAssignments.run(projectId);
              softDeleteProject.run(projectId);
            }
            db.exec('COMMIT');
            return send(res, 200, { deleted: true, deletedChats: deleteChats && chatCount > 0, retainedHistory: !deleteChats && chatCount > 0 });
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
        }

        if (method === 'GET' && subAction === 'status') {
          const project = findActiveProject.get(projectId);
          if (!project) throw new HttpError(404, 'Project not found.');
          let resolved;
          try {
            resolved = await resolveProjectPath(projectsBaseDir, project.relative_path);
          } catch (error) {
            if (error instanceof PathError) {
              return send(res, 200, {
                pathExists: false,
                initialized: false,
                ready: false,
                version: null,
                lastIndexed: null,
                fileCount: 0,
                nodeCount: 0,
                edgeCount: 0,
                pendingChanges: null,
                rebuildInProgress: false,
                index: null,
                error: error.message,
                job: cli.getJob(projectId),
              });
            }
            throw error;
          }
          const statusData = await cli.getStatus(projectId, resolved.realPath);
          return send(res, 200, statusData);
        }

        if (method === 'GET' && subAction === 'job') {
          const project = findActiveProject.get(projectId);
          if (!project) throw new HttpError(404, 'Project not found.');
          return send(res, 200, { job: cli.getJob(projectId) });
        }

        if (method === 'POST' && (subAction === 'init' || subAction === 'sync')) {
          if (req.headers['content-type']) await readBody(req);
          const freshAdmin = findSession.get(token, Date.now());
          if (!freshAdmin || freshAdmin.role !== 'admin') throw new HttpError(401, 'Sign in to continue.');
          if (closing) throw new HttpError(503, 'The app is restarting. Try again in a moment.');

          const project = findActiveProject.get(projectId);
          if (!project) throw new HttpError(404, 'Project not found.');

          let resolved;
          try {
            resolved = await resolveProjectPath(projectsBaseDir, project.relative_path);
          } catch (error) {
            if (error instanceof PathError) {
              throw new HttpError(error.code === 'BASE_DIR_INVALID' ? 500 : 400, error.message);
            }
            throw error;
          }

          try {
            const job = await cli.startJob(projectId, subAction, resolved.realPath);
            return send(res, 202, { job });
          } catch (error) {
            if (error.code === 'JOB_RUNNING' || error.code === 'NOT_INITIALIZED') {
              throw new HttpError(409, error.message);
            }
            throw error;
          }
        }
      }

      if (method === 'GET' && path === '/api/admin/chats') {
        const rawUserId = parsedUrl.searchParams.get('userId');
        const rawProjectId = parsedUrl.searchParams.get('projectId');
        const rawLimit = parsedUrl.searchParams.get('limit');
        const rawOffset = parsedUrl.searchParams.get('offset');

        const userIdFilter = rawUserId ? parsePositiveInt(rawUserId) : null;
        if (rawUserId && !userIdFilter) throw new HttpError(400, 'Invalid userId filter.');
        const projectIdFilter = rawProjectId ? parsePositiveInt(rawProjectId) : null;
        if (rawProjectId && !projectIdFilter) throw new HttpError(400, 'Invalid projectId filter.');

        const limit = rawLimit ? parsePositiveInt(rawLimit) : 50;
        if (!limit || limit > 200) throw new HttpError(400, 'Limit must be between 1 and 200.');
        const offset = rawOffset === null || rawOffset === '' ? 0 : (/^\d+$/.test(rawOffset) ? Number(rawOffset) : -1);
        if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, 'Invalid offset.');

        const clauses = [];
        const params = [];
        if (userIdFilter) {
          clauses.push('c.user_id = ?');
          params.push(userIdFilter);
        }
        if (projectIdFilter) {
          clauses.push('c.project_id = ?');
          params.push(projectIdFilter);
        }
        const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        const rows = db.prepare(`
          SELECT
            c.id,
            c.title,
            c.user_id,
            u.email AS user_email,
            u.name AS user_name,
            u.disabled AS user_disabled,
            c.project_id,
            p.name AS project_name,
            p.deleted_at AS project_deleted_at,
            EXISTS(
              SELECT 1 FROM project_assignments AS pa
              WHERE pa.user_id = c.user_id AND pa.project_id = c.project_id
            ) AS is_assigned,
            (SELECT COUNT(*) FROM messages WHERE chat_id = c.id) AS message_count,
            (SELECT MAX(id) FROM messages WHERE chat_id = c.id) AS last_message_id,
            (SELECT created_at FROM messages WHERE chat_id = c.id ORDER BY id DESC LIMIT 1) AS last_message_at,
            (SELECT role FROM messages WHERE chat_id = c.id ORDER BY id DESC LIMIT 1) AS last_role
          FROM chats AS c
          JOIN users AS u ON u.id = c.user_id
          JOIN projects AS p ON p.id = c.project_id
          ${whereSql}
          ORDER BY last_message_id DESC, c.id DESC
          LIMIT ? OFFSET ?
        `).all(...params, limit, offset);

        return send(res, 200, {
          chats: rows.map((row) => ({
            id: row.id,
            title: row.title,
            user: {
              id: row.user_id,
              email: row.user_email,
              name: row.user_name,
              disabled: Boolean(row.user_disabled),
            },
            project: {
              id: row.project_id,
              name: row.project_name,
              deletedAt: row.project_deleted_at ?? null,
            },
            accessRevoked: !row.project_deleted_at && !row.is_assigned,
            messageCount: row.message_count,
            lastMessageAt: row.last_message_at,
            status: inFlight.has(row.id) ? 'pending' : row.last_role === 'user' ? 'unanswered' : 'ready',
          })),
          projects: listHistoryProjects.all().map((row) => ({
            id: row.id,
            name: row.name,
            deletedAt: row.deleted_at ?? null,
          })),
        });
      }

      const adminChatMatch = path.match(/^\/api\/admin\/chats\/([^/]+)$/);
      if (adminChatMatch) {
        if (method !== 'GET') throw new HttpError(405, 'Conversation history is read-only.');
        const chatId = adminChatMatch[1];
        if (!uuid.test(chatId)) throw new HttpError(404, 'Conversation not found.');
        const row = findAdminChat.get(chatId);
        if (!row) throw new HttpError(404, 'Conversation not found.');
        const messages = listMessages.all(chatId);
        const last = messages.at(-1);
        return send(res, 200, {
          id: row.id,
          title: row.title,
          user: {
            id: row.user_id,
            email: row.user_email,
            name: row.user_name,
            disabled: Boolean(row.user_disabled),
          },
          project: {
            id: row.project_id,
            name: row.project_name,
            deletedAt: row.project_deleted_at ?? null,
          },
          accessRevoked: !row.project_deleted_at && !row.is_assigned,
          status: inFlight.has(row.id) ? 'pending' : last?.role === 'user' ? 'unanswered' : 'ready',
          messages,
        });
      }

      throw new HttpError(404, 'Page not found.');
    }

    if (user.role !== 'client') {
      throw new HttpError(403, 'Client access required.');
    }

    if (method === 'GET' && path === '/api/projects') {
      const assigned = listAssignedProjects.all(user.id);
      const items = await Promise.all(assigned.map(async (project) => {
        const indexing = cli.isLocked(project.id);
        let indexed = false;
        try {
          const resolved = await resolveProjectPath(projectsBaseDir, project.relative_path);
          indexed = await cli.hasIndex(resolved.realPath);
        } catch {
          indexed = false;
        }
        return {
          id: project.id,
          name: project.name,
          description: project.description,
          indexed,
          indexing,
        };
      }));
      return send(res, 200, { projects: items });
    }

    if (method === 'GET' && path === '/api/chats') {
      const projectIdParam = parsedUrl.searchParams.get('projectId');
      if (projectIdParam !== null && projectIdParam !== '') {
        const projectId = parsePositiveInt(projectIdParam);
        if (!projectId) throw new HttpError(400, 'Select a valid project.');
        const assigned = findAssignedProject.get(user.id, projectId);
        if (!assigned) throw new HttpError(404, 'Project not found.');
        return send(res, 200, {
          email: user.email,
          name: user.name,
          role: user.role,
          projectId,
          chats: listChatsByProject.all(user.id, projectId).map((row) => ({
            id: row.id,
            projectId: row.project_id,
            title: row.title,
          })),
        });
      }
      return send(res, 200, {
        email: user.email,
        name: user.name,
        role: user.role,
        chats: listAssignedChats.all(user.id).map((row) => ({
          id: row.id,
          projectId: row.project_id,
          title: row.title,
        })),
      });
    }

    const match = path.match(/^\/api\/chats\/([^/]+)(\/retry)?$/);
    if (!match || !uuid.test(match[1])) throw new HttpError(404, 'Conversation not found.');
    const [, chatId, retry] = match;
    let chat = findChat.get(chatId);
    if (chat) {
      if (chat.user_id !== user.id || !findAssignedProject.get(user.id, chat.project_id)) {
        throw new HttpError(404, 'Conversation not found.');
      }
    }

    if (method === 'GET' && !retry && chat) return send(res, 200, chatView(chat));
    if (method !== 'POST') throw new HttpError(404, 'Page not found.');

    const body = await readBody(req);
    if (closing) throw new HttpError(503, 'The app is restarting. Try again in a moment.');
    // Request bodies arrive asynchronously. Recheck user session, chat ownership, and project assignment before writing.
    const freshUser = findSession.get(token, Date.now());
    if (!freshUser) throw new HttpError(401, 'Sign in to continue.');
    if (freshUser.role !== 'client') throw new HttpError(403, 'Client access required.');

    chat = findChat.get(chatId);
    if (chat) {
      if (chat.user_id !== freshUser.id || !findAssignedProject.get(freshUser.id, chat.project_id)) {
        throw new HttpError(404, 'Conversation not found.');
      }
    }

    if (retry) {
      if (!chat) throw new HttpError(404, 'Conversation not found.');
      const { project, realPath } = await requireReadyProject(freshUser.id, chat.project_id);
      requireCapacity(chatId);
      const last = latestMessage.get(chatId);
      if (last?.role !== 'user' || last.id !== body.messageId) {
        throw new HttpError(409, 'This question is no longer waiting for an answer.');
      }
      queueAnswer(chatId, last.id, last.content, project.id, realPath);
      return send(res, 202, chatView(chat));
    }

    const question = typeof body.message === 'string' ? body.message.trim() : '';
    if (!question || question.includes('\0') || question.length > maxQuestionLength) {
      throw new HttpError(400, 'Enter a question of 1 to 4,000 characters.');
    }
    if (typeof body.requestId !== 'string' || !uuid.test(body.requestId)) {
      throw new HttpError(400, 'Invalid message request.');
    }

    const targetProjectId = chat
      ? chat.project_id
      : (Number.isInteger(body.projectId) && body.projectId >= 1 ? body.projectId : null);
    if (!targetProjectId) {
      throw new HttpError(400, 'Select a valid project.');
    }
    if (chat && body.projectId !== undefined && body.projectId !== chat.project_id) {
      throw new HttpError(400, 'Conversation belongs to a different project.');
    }

    const { project, realPath } = await requireReadyProject(freshUser.id, targetProjectId);

    const existing = chat && findRequest.get(chatId, body.requestId);
    if (existing) {
      if (existing.content !== question) throw new HttpError(409, 'This message has already been saved.');
      return send(res, 200, chatView(chat));
    }
    requireCapacity(chatId);

    db.exec('BEGIN IMMEDIATE');
    let messageId;
    try {
      // Final assignment check inside write transaction
      if (!findAssignedProject.get(freshUser.id, project.id)) {
        throw new HttpError(404, 'Project not found.');
      }
      if (!chat) {
        const firstLine = [...question.split(/\r?\n/, 1)[0]];
        const title = firstLine.slice(0, 70).join('') + (firstLine.length > 70 ? '…' : '');
        addChat.run(chatId, freshUser.id, project.id, title);
        chat = findChat.get(chatId);
      }
      messageId = Number(addQuestion.run(chatId, question, body.requestId).lastInsertRowid);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    queueAnswer(chatId, messageId, question, project.id, realPath);
    send(res, 202, chatView(chat));
  }

  purgeSessions.run(Date.now());
  const maintenance = setInterval(() => {
    const now = Date.now();
    purgeSessions.run(now);
    for (const [key, value] of loginAttempts) {
      if (value.expiresAt <= now) loginAttempts.delete(key);
    }
  }, 60_000);
  maintenance.unref();

  const server = createServer({ headersTimeout: 10_000, requestTimeout: 15_000 }, (req, res) => {
    route(req, res).catch((error) => {
      if (res.headersSent || res.destroyed) return;
      if (error instanceof HttpError) {
        send(res, error.status, { error: error.message });
      } else {
        console.error('Request failed:', error.message);
        send(res, 500, { error: 'Something went wrong. Try again.' });
      }
    });
  });

  async function close() {
    if (closing) return;
    closing = true;
    clearInterval(maintenance);
    await new Promise((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
      server.closeIdleConnections?.();
    });
    await Promise.allSettled(inFlight.values());
    await cli.stopAll();
  }

  return { server, close, origin, cookieName, inFlight, codegraphCli: cli };
}
