import { createCodeGraph } from './codegraph.js';
import { hasCodeGraphIndex } from './codegraph-cli.js';

export function createCodeGraphManager({
  binary = 'codegraph',
  maxWorkers = 4,
  idleMs = 600_000,
  isLocked,
  workerFactory = createCodeGraph,
} = {}) {
  const workers = new Map();
  let closed = false;

  const sweepInterval = Math.min(60_000, Math.max(50, Math.floor(idleMs / 2)));
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [projectId, entry] of workers) {
      if (entry.activeCalls === 0 && !entry.stopping && now - entry.lastUsedAt >= idleMs) {
        stop(projectId).catch(() => {});
      }
    }
  }, sweepInterval);
  timer.unref();

  async function stop(projectId) {
    const entry = workers.get(projectId);
    if (!entry) return;
    entry.stopping = true;
    workers.delete(projectId);
    await entry.client.close();
  }

  async function evictIfNeeded() {
    while (workers.size >= maxWorkers) {
      let oldest = null;
      for (const entry of workers.values()) {
        if (entry.activeCalls === 0 && !entry.stopping) {
          if (!oldest || entry.lastUsedAt < oldest.lastUsedAt) oldest = entry;
        }
      }
      if (!oldest) {
        throw Object.assign(
          new Error('The assistant is busy with other projects. Try again in a moment.'),
          { code: 'POOL_BUSY' },
        );
      }
      await stop(oldest.projectId);
    }
  }

  async function explore(projectId, rootPath, query) {
    if (closed) {
      throw Object.assign(new Error('The app is restarting. Try again in a moment.'), { code: 'CLOSING' });
    }
    if (isLocked?.(projectId)) {
      throw Object.assign(
        new Error('Project index is currently updating. Try again shortly.'),
        { code: 'PROJECT_INDEXING' },
      );
    }

    let entry = workers.get(projectId);
    if (entry && (entry.rootPath !== rootPath || entry.stopping)) {
      await stop(projectId);
      entry = null;
    }

    if (!entry) {
      if (!(await hasCodeGraphIndex(rootPath))) {
        throw Object.assign(
          new Error('This project is not indexed yet. Ask your administrator to initialize CodeGraph.'),
          { code: 'NOT_INDEXED' },
        );
      }
      await evictIfNeeded();
      if (isLocked?.(projectId)) {
        throw Object.assign(
          new Error('Project index is currently updating. Try again shortly.'),
          { code: 'PROJECT_INDEXING' },
        );
      }
      entry = {
        projectId,
        rootPath,
        client: workerFactory(rootPath, binary),
        lastUsedAt: Date.now(),
        activeCalls: 0,
        stopping: false,
      };
      workers.set(projectId, entry);
    }

    entry.activeCalls++;
    entry.lastUsedAt = Date.now();
    try {
      return await entry.client.explore(query);
    } finally {
      entry.activeCalls = Math.max(0, entry.activeCalls - 1);
      entry.lastUsedAt = Date.now();
    }
  }

  async function closeAll() {
    closed = true;
    clearInterval(timer);
    const ids = [...workers.keys()];
    await Promise.allSettled(ids.map((id) => stop(id)));
  }

  function stats() {
    return {
      size: workers.size,
      projectIds: [...workers.keys()],
    };
  }

  return {
    explore,
    stop,
    closeAll,
    stats,
  };
}
