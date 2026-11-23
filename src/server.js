import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { normalizeEmail, tokenHash, validPassword, verifyPassword } from './auth.js';
import { createCodeGraph } from './codegraph.js';
import { openDatabase } from './db.js';
import { createAnswerer } from './llm.js';

process.umask(0o077);

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');

const base = new URL(process.env.APP_ORIGIN || `http://127.0.0.1:${port}`);
if (!['http:', 'https:'].includes(base.protocol) || base.href !== base.origin + '/') {
  throw new Error('APP_ORIGIN must be an HTTP(S) origin without a path.');
}
const origin = base.origin;
const secure = base.protocol === 'https:';
const cookieName = secure ? '__Host-codechat' : 'codechat';
const sessionSeconds = 7 * 24 * 60 * 60;
const uuid = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;
const maxQuestionLength = 4000;
const maxLoginKeys = 4096;

if (!process.env.REPO_PATH?.trim()) throw new Error('Set REPO_PATH to a local repository.');
const graph = createCodeGraph(resolve(process.env.REPO_PATH), process.env.CODEGRAPH_BIN || 'codegraph');
const answer = createAnswerer(graph);
await graph.start();

const db = openDatabase();
const findUser = db.prepare('SELECT * FROM users WHERE email = ?');
const findSession = db.prepare(`
  SELECT users.id, users.email
  FROM sessions JOIN users ON users.id = sessions.user_id
  WHERE token_hash = ? AND expires_at > ?
`);
const addSession = db.prepare('INSERT INTO sessions VALUES (?, ?, ?)');
const removeSession = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
const purgeSessions = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');

const listChats = db.prepare(`
  SELECT id, title FROM chats WHERE user_id = ?
  ORDER BY (SELECT MAX(id) FROM messages WHERE chat_id = chats.id) DESC
`);
const findChat = db.prepare('SELECT id, user_id, title FROM chats WHERE id = ?');
const addChat = db.prepare('INSERT INTO chats (id, user_id, title) VALUES (?, ?, ?)');
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

const assets = new Map(Object.entries({
  '/': ['text/html; charset=utf-8', 'index.html'],
  '/login': ['text/html; charset=utf-8', 'login.html'],
  '/app.css': ['text/css; charset=utf-8', 'app.css'],
  '/app.js': ['text/javascript; charset=utf-8', 'app.js'],
  '/theme.js': ['text/javascript; charset=utf-8', 'theme.js'],
}).map(([route, [type, file]]) => [route, [type, readFileSync(new URL(`../public/${file}`, import.meta.url))]]));
assets.set('/markdown-it.js', [
  'text/javascript; charset=utf-8',
  readFileSync(new URL(import.meta.resolve('markdown-it/browser'))),
]);

const inFlight = new Map();
const loginAttempts = new Map();
let closing = false;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

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
    if (!await verifyPassword(body.password, user?.password_hash)) {
      throw new HttpError(401, 'Email or password is incorrect.');
    }

    const token = randomBytes(32).toString('base64url');
    if (currentToken) removeSession.run(currentToken);
    addSession.run(tokenHash(token), user.id, Date.now() + sessionSeconds * 1000);
    loginAttempts.delete('email:' + email);
    setSessionCookie(res, token, sessionSeconds);
    if (form) return redirect(res, '/');
    send(res, 200, { email });
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
    title: chat.title,
    messages,
    status: inFlight.has(chat.id) ? 'pending' : last?.role === 'user' ? 'unanswered' : 'ready',
  };
}

function requireCapacity(chatId) {
  if (inFlight.has(chatId)) throw new HttpError(409, 'An answer is already on its way.');
  if (inFlight.size >= 4) throw new HttpError(503, 'The assistant is busy. Try again in a moment.');
}

function queueAnswer(chatId, messageId, question) {
  const history = readHistory.all(chatId, messageId).reverse().flatMap((turn) => [
    { role: 'user', content: turn.question },
    { role: 'assistant', content: turn.answer },
  ]);
  history.push({ role: 'user', content: question });

  const job = answer(history)
    .then((response) => addAnswer.run(chatId, response, messageId))
    .catch((error) => console.error('Answer failed:', error.message))
    .finally(() => inFlight.delete(chatId));
  inFlight.set(chatId, job);
}

async function route(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');

  const path = new URL(req.url, origin).pathname;
  const method = req.method;
  if (method === 'POST' && req.headers.origin !== origin) {
    throw new HttpError(403, 'Refresh the page and try again.');
  }
  const token = sessionToken(req);
  const user = token && findSession.get(token, Date.now());

  if (method === 'GET' && assets.has(path)) {
    if (path === '/' && !user) return redirect(res, '/login');
    if (path === '/login' && user) return redirect(res, '/');
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
  if (method === 'GET' && path === '/api/chats') {
    return send(res, 200, { email: user.email, chats: listChats.all(user.id) });
  }

  const match = path.match(/^\/api\/chats\/([^/]+)(\/retry)?$/);
  if (!match || !uuid.test(match[1])) throw new HttpError(404, 'Conversation not found.');
  const [, chatId, retry] = match;
  let chat = findChat.get(chatId);
  if (chat && chat.user_id !== user.id) throw new HttpError(404, 'Conversation not found.');

  if (method === 'GET' && !retry && chat) return send(res, 200, chatView(chat));
  if (method !== 'POST') throw new HttpError(404, 'Page not found.');

  const body = await readBody(req);
  if (closing) throw new HttpError(503, 'The app is restarting. Try again in a moment.');
  // Request bodies arrive asynchronously. Recheck state before writing.
  chat = findChat.get(chatId);
  if (chat && chat.user_id !== user.id) throw new HttpError(404, 'Conversation not found.');

  if (retry) {
    if (!chat) throw new HttpError(404, 'Conversation not found.');
    requireCapacity(chatId);
    const last = latestMessage.get(chatId);
    if (last?.role !== 'user' || last.id !== body.messageId) {
      throw new HttpError(409, 'This question is no longer waiting for an answer.');
    }
    queueAnswer(chatId, last.id, last.content);
    return send(res, 202, chatView(chat));
  }

  const question = typeof body.message === 'string' ? body.message.trim() : '';
  if (!question || question.includes('\0') || question.length > maxQuestionLength) {
    throw new HttpError(400, 'Enter a question of 1 to 4,000 characters.');
  }
  if (typeof body.requestId !== 'string' || !uuid.test(body.requestId)) {
    throw new HttpError(400, 'Invalid message request.');
  }
  const existing = chat && findRequest.get(chatId, body.requestId);
  if (existing) {
    if (existing.content !== question) throw new HttpError(409, 'This message has already been saved.');
    return send(res, 200, chatView(chat));
  }
  requireCapacity(chatId);

  db.exec('BEGIN IMMEDIATE');
  let messageId;
  try {
    if (!chat) {
      const firstLine = [...question.split(/\r?\n/, 1)[0]];
      const title = firstLine.slice(0, 70).join('') + (firstLine.length > 70 ? '…' : '');
      addChat.run(chatId, user.id, title);
      chat = findChat.get(chatId);
    }
    messageId = Number(addQuestion.run(chatId, question, body.requestId).lastInsertRowid);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  queueAnswer(chatId, messageId, question);
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
server.on('error', (error) => {
  console.error('Server error:', error.message);
  graph.close();
  process.exitCode = 1;
});
server.listen(port, host, () => console.log(`Code Chat listening on ${host}:${port} (browser origin ${origin})`));

function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(maintenance);
  server.close(async () => {
    await Promise.allSettled(inFlight.values());
    graph.close();
    db.close();
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
