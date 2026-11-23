import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const protocolVersion = '2024-11-05';

function connect(binary, root) {
  const { PATH, HOME, USERPROFILE, XDG_CACHE_HOME, XDG_RUNTIME_DIR, TMPDIR } = process.env;
  const child = spawn(binary, ['serve', '--mcp', '--no-telemetry', '--path', root], {
    cwd: root,
    env: { PATH, HOME, USERPROFILE, XDG_CACHE_HOME, XDG_RUNTIME_DIR, TMPDIR },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const pending = new Map();
  let nextId = 0;
  let closed = false;

  function close(error = new Error('CodeGraph connection closed')) {
    if (closed) return;
    closed = true;
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
    child.kill();
  }

  child.on('error', close);
  child.on('exit', () => close());
  child.stdin.on('error', close);
  child.stdout.on('end', () => close());

  createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      message = null;
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      close(new Error('Invalid MCP response from CodeGraph'));
      return;
    }
    if (message.method === 'ping' && message.id !== undefined) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\n');
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(`CodeGraph RPC error ${message.error.code}`));
    else request.resolve(message.result);
  });

  function send(method, params) {
    if (closed) return Promise.reject(new Error('CodeGraph connection closed'));
    const notification = method.startsWith('notifications/');
    const id = notification ? undefined : ++nextId;
    const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    if (notification) {
      child.stdin.write(line);
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('CodeGraph timed out'));
      }, 20_000);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      child.stdin.write(line);
    });
  }

  return { send, close, get closed() { return closed; } };
}

export function createCodeGraph(root, binary) {
  let connection;
  let ready;
  async function start() {
    if (connection && !connection.closed) return ready;
    connection = connect(binary, root);
    const current = connection;
    ready = (async () => {
      const info = await current.send('initialize', {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: 'code-chat', version: '1.0.0' },
      });
      if (info?.protocolVersion !== protocolVersion) throw new Error('Unsupported CodeGraph MCP version');
      await current.send('notifications/initialized');
      const list = await current.send('tools/list');
      if (!list?.tools?.some((tool) => tool.name === 'codegraph_explore')) {
        throw new Error('CodeGraph must provide the codegraph_explore tool');
      }
      return current;
    })().catch((error) => {
      current.close();
      throw error;
    });
    return ready;
  }

  return {
    async start() {
      try {
        await access(join(root, '.codegraph', 'codegraph.db'));
      } catch {
        throw new Error('CodeGraph index missing. Run codegraph init --yes --local-only on REPO_PATH.');
      }
      await start();
    },
    close() { connection?.close(); },
    async explore(query) {
      const current = await start();
      const result = await current.send('tools/call', {
        name: 'codegraph_explore',
        arguments: { query },
      });
      const output = result?.content?.filter((part) => part.type === 'text')
        .map((part) => part.text).join('\n').trim();
      if (result?.isError || !output) throw new Error('CodeGraph lookup failed');
      return output.length > 32_000
        ? output.slice(0, 32_000) + '\n[Search result truncated]'
        : output;
    },
  };
}
