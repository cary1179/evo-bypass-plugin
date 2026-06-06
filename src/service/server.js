import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveServicePaths } from '../core/service-paths.js';
import { enqueueJob, listJobs, readJob, resetStaleRunningJobs } from './job-store.js';
import { runOneReviewJob } from './review-worker.js';
import { listSessions, getSessionDetail } from '../viewer/session-store.js';
import { applyEditedApprovedUpdate } from './apply-edited-update.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const packageJsonPath = path.join(repoRoot, 'package.json');
const uiPath = path.join(repoRoot, 'src', 'viewer', 'static', 'index.html');
const DEFAULT_WORKER_INTERVAL_MS = 2000;

export async function startServiceServer({
  root = process.cwd(),
  host = '127.0.0.1',
  port = 8765,
  startWorker = true,
  workerIntervalMs = DEFAULT_WORKER_INTERVAL_MS,
} = {}) {
  const safeHost = normalizeLoopbackHost(host);
  const version = await packageVersion();
  const server = http.createServer(async (request, response) => {
    try {
      await handleRequest({ request, response, root, version, serverUrl: serviceUrl({ host: safeHost, port: serverPort(server, port) }) });
    } catch (error) {
      sendJson(response, 500, { error: error.message || 'Internal server error' });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, safeHost, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const resolvedPort = serverPort(server, port);
  const url = serviceUrl({ host: safeHost, port: resolvedPort });
  await writeServiceFiles({ root, url });

  let workerTimer;
  if (startWorker) {
    await resetStaleRunningJobs({ root });
    workerTimer = setInterval(() => {
      runOneReviewJob({ root }).catch(() => {});
    }, workerIntervalMs);
    workerTimer.unref?.();
  }

  return {
    server,
    host: safeHost,
    port: resolvedPort,
    url,
    close: () => closeService({ server, workerTimer }),
  };
}

async function handleRequest({ request, response, root, version, serverUrl }) {
  const url = new URL(request.url, 'http://127.0.0.1');

  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, {
      name: 'evo-bypassd',
      ok: true,
      root,
      version,
      pid: process.pid,
      url: serverUrl,
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/jobs') {
    const body = await readJsonBody(request);
    const job = await enqueueJob({
      root,
      sessionId: body.session_id,
      runtime: body.runtime,
    });
    sendJson(response, 202, job);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/jobs') {
    sendJson(response, 200, { root, jobs: await listJobs({ root }) });
    return;
  }

  if (request.method === 'GET' && url.pathname.startsWith('/api/jobs/')) {
    const jobId = decodeURIComponent(url.pathname.slice('/api/jobs/'.length));
    sendJson(response, 200, await readJob({ root, jobId }));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/sessions') {
    sendJson(response, 200, await listSessions({ root }));
    return;
  }

  if (request.method === 'POST' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/apply')) {
    const sessionId = decodeURIComponent(url.pathname.slice('/api/sessions/'.length, -'/apply'.length));
    await handleApply({ response, root, sessionId, body: await readJsonBody(request) });
    return;
  }

  if (request.method === 'GET' && url.pathname.startsWith('/api/sessions/')) {
    const sessionId = decodeURIComponent(url.pathname.slice('/api/sessions/'.length));
    sendJson(response, 200, await getSessionDetail({ root, sessionId }));
    return;
  }

  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/sessions' || url.pathname.startsWith('/sessions/'))) {
    await sendUi(response);
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    sendJson(response, request.method === 'GET' || request.method === 'POST' ? 404 : 405, { error: 'Not found' });
    return;
  }

  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  await sendUi(response);
}

async function handleApply({ response, root, sessionId, body }) {
  try {
    const result = await applyEditedApprovedUpdate({ root, sessionId, ...body });
    sendJson(response, 200, result);
  } catch (error) {
    if (/not implemented/i.test(error.message || '')) {
      sendJson(response, 501, { error: error.message });
      return;
    }
    throw error;
  }
}

async function readJsonBody(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 1024 * 1024) {
      throw new Error('Request body too large');
    }
  }
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON body must be an object');
    }
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('Invalid JSON body');
    }
    throw error;
  }
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

async function writeServiceFiles({ root, url }) {
  const paths = resolveServicePaths({ root });
  await fs.mkdir(paths.serviceDir, { recursive: true });
  await fs.writeFile(paths.serviceUrlPath, `${url}\n`);
  await fs.writeFile(paths.servicePidPath, `${process.pid}\n`);
}

function closeService({ server, workerTimer }) {
  if (workerTimer) clearInterval(workerTimer);
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function serverPort(server, fallbackPort) {
  const address = server.address();
  return typeof address === 'object' && address ? address.port : fallbackPort;
}

function serviceUrl({ host, port }) {
  return `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
}

function normalizeLoopbackHost(host) {
  if (typeof host !== 'string') return '127.0.0.1';
  const trimmed = host.trim();
  return LOOPBACK_HOSTS.has(trimmed) ? trimmed : '127.0.0.1';
}
