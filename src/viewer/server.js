import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSessions, getSessionDetail } from './session-store.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const packageJsonPath = path.join(repoRoot, 'package.json');
const uiPath = path.join(repoRoot, 'src', 'viewer', 'static', 'index.html');

export async function createViewerServer({ root = process.cwd() } = {}) {
  const version = await packageVersion();
  return http.createServer(async (request, response) => {
    try {
      await handleRequest({ request, response, root, version });
    } catch (error) {
      sendJson(response, 500, { error: error.message || 'Internal server error' });
    }
  });
}

export async function startViewerServer({ root = process.cwd(), host = '127.0.0.1', port = 8766 } = {}) {
  const server = await createViewerServer({ root });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const resolvedPort = typeof address === 'object' && address ? address.port : port;
  return {
    server,
    host,
    port: resolvedPort,
    url: `http://${host}:${resolvedPort}`,
    appUrl: viewerUrl({ host, port: resolvedPort }),
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

export function viewerUrl({ host, port, sessionId }) {
  const base = `http://${host}:${port}/sessions`;
  return sessionId ? `${base}/${encodeURIComponent(sessionId)}` : base;
}

async function handleRequest({ request, response, root, version }) {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  if (url.pathname === '/api/health') {
    sendJson(response, 200, { name: 'evo-bypass-session-viewer', root, version });
    return;
  }

  if (url.pathname === '/api/sessions') {
    sendJson(response, 200, await listSessions({ root }));
    return;
  }

  if (url.pathname.startsWith('/api/sessions/')) {
    const sessionId = decodeURIComponent(url.pathname.slice('/api/sessions/'.length));
    sendJson(response, 200, await getSessionDetail({ root, sessionId }));
    return;
  }

  if (url.pathname === '/sessions' || url.pathname.startsWith('/sessions/')) {
    await sendUi(response);
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    sendJson(response, 404, { error: 'Not found' });
    return;
  }

  await sendUi(response);
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

async function sendUi(response) {
  const html = await fs.readFile(uiPath, 'utf8');
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(html);
}

async function packageVersion() {
  try {
    const pkg = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}
