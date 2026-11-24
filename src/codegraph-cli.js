import { execFile, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const maxOutputBytes = 16_384;

export function buildSafeEnv() {
  const keys = ['PATH', 'HOME', 'USERPROFILE', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR'];
  const env = {};
  for (const key of keys) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

export async function hasCodeGraphIndex(realPath) {
  try {
    await access(join(realPath, '.codegraph', 'codegraph.db'));
    return true;
  } catch {
    return false;
  }
}

function appendTail(existing, chunk) {
  const combined = existing + chunk;
  if (Buffer.byteLength(combined, 'utf8') <= maxOutputBytes) return combined;
  return combined.slice(-maxOutputBytes);
}

function snapshotJob(job, projectId) {
  if (!job) {
    return {
      projectId,
      action: null,
      state: 'idle',
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      signal: null,
      output: '',
      error: null,
    };
  }
  return {
    projectId: job.projectId,
    action: job.action,
    state: job.state,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    signal: job.signal,
    output: job.output,
    error: job.error,
  };
}

export function createCodeGraphCli({
  binary = 'codegraph',
  onBeforeIndex,
  statusTimeoutMs = 10_000,
  jobTimeoutMs = 10 * 60_000,
} = {}) {
  const jobs = new Map();
  const activeChildren = new Map();

  function isLocked(projectId) {
    return jobs.get(projectId)?.state === 'running';
  }

  function getJob(projectId) {
    return snapshotJob(jobs.get(projectId), projectId);
  }

  async function getStatus(projectId, realPath) {
    const indexedFile = await hasCodeGraphIndex(realPath);
    const job = getJob(projectId);
    if (!indexedFile) {
      return {
        pathExists: true,
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
        error: null,
        job,
      };
    }

    try {
      const { stdout } = await execFileAsync(binary, ['status', '--json', realPath], {
        cwd: realPath,
        env: buildSafeEnv(),
        timeout: statusTimeoutMs,
        maxBuffer: 1024 * 1024,
        shell: false,
      });
      const parsed = JSON.parse(stdout);
      const initialized = Boolean(parsed?.initialized);
      const complete = !parsed?.index || parsed.index.state === 'complete';
      return {
        pathExists: true,
        initialized,
        ready: initialized && complete && !isLocked(projectId),
        version: parsed?.version ?? null,
        lastIndexed: parsed?.lastIndexed ?? null,
        fileCount: Number.isInteger(parsed?.fileCount) ? parsed.fileCount : 0,
        nodeCount: Number.isInteger(parsed?.nodeCount) ? parsed.nodeCount : 0,
        edgeCount: Number.isInteger(parsed?.edgeCount) ? parsed.edgeCount : 0,
        pendingChanges: parsed?.pendingChanges ?? null,
        rebuildInProgress: Boolean(parsed?.rebuildInProgress),
        index: parsed?.index ?? null,
        error: null,
        job,
      };
    } catch (error) {
      return {
        pathExists: true,
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
        error: error.stderr?.trim() || error.message || 'Could not inspect CodeGraph status.',
        job,
      };
    }
  }

  async function startJob(projectId, action, realPath) {
    if (action !== 'init' && action !== 'sync') {
      throw Object.assign(new Error('Unsupported CodeGraph action.'), { code: 'INVALID_ACTION' });
    }
    if (isLocked(projectId)) {
      throw Object.assign(new Error('An indexing job is already running for this project.'), { code: 'JOB_RUNNING' });
    }
    if (action === 'sync' && !(await hasCodeGraphIndex(realPath))) {
      throw Object.assign(new Error('Initialize CodeGraph before running sync.'), { code: 'NOT_INITIALIZED' });
    }

    const job = {
      projectId,
      action,
      state: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      signal: null,
      output: '',
      error: null,
    };
    jobs.set(projectId, job);

    try {
      if (onBeforeIndex) await onBeforeIndex(projectId);
    } catch (error) {
      job.state = 'failed';
      job.finishedAt = new Date().toISOString();
      job.error = error.message || 'Failed to prepare project for indexing.';
      throw error;
    }

    const args = action === 'init'
      ? ['init', '--yes', '--local-only', realPath]
      : ['sync', realPath];

    const child = spawn(binary, args, {
      cwd: realPath,
      env: buildSafeEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    let settled = false;
    let killTimer;
    let forceKillTimer;

    const done = new Promise((resolveDone) => {
      function finish({ exitCode = null, signal = null, error = null }) {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        clearTimeout(forceKillTimer);
        activeChildren.delete(projectId);
        job.exitCode = exitCode;
        job.signal = signal;
        job.finishedAt = new Date().toISOString();
        if (error) {
          job.state = 'failed';
          job.error = error;
        } else if (exitCode === 0 && !signal) {
          job.state = 'succeeded';
        } else {
          job.state = 'failed';
          job.error = signal
            ? `CodeGraph ${action} terminated by ${signal}.`
            : `CodeGraph ${action} exited with code ${exitCode}.`;
        }
        resolveDone();
      }

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        job.output = appendTail(job.output, chunk);
      });
      child.stderr.on('data', (chunk) => {
        job.output = appendTail(job.output, chunk);
      });
      child.on('error', (error) => {
        finish({ error: error.message || `Failed to start CodeGraph ${action}.` });
      });
      child.on('exit', (code, signal) => {
        finish({ exitCode: code, signal });
      });

      killTimer = setTimeout(() => {
        if (settled) return;
        job.output = appendTail(job.output, '\n[Timed out — terminating CodeGraph process]\n');
        child.kill('SIGTERM');
        forceKillTimer = setTimeout(() => {
          if (!settled) child.kill('SIGKILL');
        }, 5_000);
        forceKillTimer.unref();
      }, jobTimeoutMs);
      killTimer.unref();
    });

    activeChildren.set(projectId, { child, done });
    return snapshotJob(job, projectId);
  }

  async function stopAll() {
    const entries = [...activeChildren.values()];
    if (!entries.length) return;
    await Promise.allSettled(entries.map(({ child, done }) => {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      timer.unref();
      return done.finally(() => clearTimeout(timer));
    }));
  }

  return {
    getStatus,
    startJob,
    getJob,
    isLocked,
    hasIndex: hasCodeGraphIndex,
    stopAll,
  };
}
