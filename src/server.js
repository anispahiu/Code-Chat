import { createApp } from './app.js';
import { createCodeGraphCli } from './codegraph-cli.js';
import { createCodeGraphManager } from './codegraph-manager.js';
import { openDatabase } from './db.js';
import { createAnswerer } from './llm.js';
import { resolveBaseDir } from './paths.js';

process.umask(0o077);

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');

const appOrigin = process.env.APP_ORIGIN || `http://127.0.0.1:${port}`;
const projectsBaseDir = await resolveBaseDir(process.env.PROJECTS_BASE_DIR);
const codegraphBin = process.env.CODEGRAPH_BIN || 'codegraph';
const maxWorkers = Number(process.env.CODEGRAPH_MCP_MAX_WORKERS || 4);
const idleMs = Number(process.env.CODEGRAPH_MCP_IDLE_MS || 600_000);
if (!Number.isInteger(maxWorkers) || maxWorkers < 1) {
  throw new Error('CODEGRAPH_MCP_MAX_WORKERS must be a positive integer.');
}
if (!Number.isInteger(idleMs) || idleMs < 1000) {
  throw new Error('CODEGRAPH_MCP_IDLE_MS must be at least 1000.');
}

let mcpManager;
const codegraphCli = createCodeGraphCli({
  binary: codegraphBin,
  onBeforeIndex: (projectId) => mcpManager.stop(projectId),
});
mcpManager = createCodeGraphManager({
  binary: codegraphBin,
  maxWorkers,
  idleMs,
  isLocked: (projectId) => codegraphCli.isLocked(projectId),
});

const answer = createAnswerer();
const db = openDatabase();
const app = createApp({
  db,
  answer,
  appOrigin,
  projectsBaseDir,
  codegraphCli,
  mcpManager,
});

app.server.on('error', (error) => {
  console.error('Server error:', error.message);
  mcpManager.closeAll().finally(() => {
    db.close();
    process.exitCode = 1;
  });
});
app.server.listen(port, host, () => {
  console.log(`Code Chat listening on ${host}:${port} (browser origin ${app.origin}, projects root ${projectsBaseDir})`);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await app.close();
  await mcpManager.closeAll();
  db.close();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
