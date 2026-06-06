import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveServicePaths } from '../core/service-paths.js';
import { resolveSessionPaths } from '../core/session-paths.js';
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
  worker = runOneReviewJob,
} = {}) {
  const safeHost = normalizeLoopbackHost(host);
  const version = await packageVersion();
  const server = http.createServer(async (request, response) => {
    try {
      await handleRequest({ request, response, root, version, serverUrl: serviceUrl({ host: safeHost, port: serverPort(server, port) }) });
    } catch (error) {
      sendError(response, error);
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
  let closePromise;

  let workerTimer;
  let workerInFlight = false;
  if (startWorker) {
    await resetStaleRunningJobs({ root });
    workerTimer = setInterval(() => {
      if (workerInFlight) return;
      workerInFlight = true;
      worker({ root })
        .catch(() => {})
        .finally(() => {
          workerInFlight = false;
        });
    }, workerIntervalMs);
    workerTimer.unref?.();
  }

  return {
    server,
    host: safeHost,
    port: resolvedPort,
    url,
    close: () => {
      closePromise ??= closeService({ root, server, workerTimer, url, pid: process.pid });
      return closePromise;
    },
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
    if (!body.session_id || typeof body.session_id !== 'string') {
      throw new HttpError(400, 'session_id is required');
    }
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
    const jobId = safeDecodePathSegment(url.pathname.slice('/api/jobs/'.length));
    try {
      sendJson(response, 200, await readJob({ root, jobId }));
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new HttpError(404, 'Job not found');
      }
      throw mapValidationError(error);
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/sessions') {
    sendJson(response, 200, await listSessions({ root }));
    return;
  }

  if (request.method === 'POST' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/apply')) {
    const sessionId = safeDecodePathSegment(url.pathname.slice('/api/sessions/'.length, -'/apply'.length));
    validateSessionId({ root, sessionId });
    await handleApply({ response, root, sessionId, body: await readJsonBody(request) });
    return;
  }

  if (request.method === 'GET' && url.pathname.startsWith('/api/sessions/')) {
    const sessionId = safeDecodePathSegment(url.pathname.slice('/api/sessions/'.length));
    try {
      sendJson(response, 200, await getSessionDetail({ root, sessionId }));
    } catch (error) {
      throw mapValidationError(error);
    }
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
    throw mapValidationError(error);
  }
}

async function readJsonBody(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 1024 * 1024) {
      throw new HttpError(413, 'Request body too large');
    }
  }
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'JSON body must be an object');
    }
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new HttpError(400, 'Invalid JSON body');
    }
    throw error;
  }
}

function safeDecodePathSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    if (error instanceof URIError) {
      throw new HttpError(400, 'Malformed path encoding');
    }
    throw error;
  }
}

function validateSessionId({ root, sessionId }) {
  try {
    resolveSessionPaths({ root, sessionId });
  } catch (error) {
    throw mapValidationError(error);
  }
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function sendError(response, error) {
  if (error instanceof HttpError) {
    sendJson(response, error.statusCode, { error: error.message });
    return;
  }

  const mapped = mapValidationError(error);
  if (mapped instanceof HttpError) {
    sendJson(response, mapped.statusCode, { error: mapped.message });
    return;
  }

  sendJson(response, 500, { error: error.message || 'Internal server error' });
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

async function closeService({ root, server, workerTimer, url, pid }) {
  if (workerTimer) clearInterval(workerTimer);
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  await removeMatchingServiceFiles({ root, url, pid });
}

async function removeMatchingServiceFiles({ root, url, pid }) {
  const paths = resolveServicePaths({ root });
  await Promise.all([
    removeFileIfContentMatches(paths.serviceUrlPath, `${url}\n`),
    removeFileIfContentMatches(paths.servicePidPath, `${pid}\n`),
  ]);
}

async function removeFileIfContentMatches(filePath, expectedContent) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    if (content === expectedContent) {
      await fs.rm(filePath, { force: true });
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
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
  if (!LOOPBACK_HOSTS.has(trimmed)) return '127.0.0.1';
  return trimmed === '[::1]' ? '::1' : trimmed;
}

function mapValidationError(error) {
  if (error instanceof HttpError) return error;
  if (/safe path segment|required|invalid json|json body|approved_|approval must|edits must|target must stay|target must be a file path|non-empty/i.test(error.message || '')) {
    return new HttpError(400, error.message);
  }
  return error;
}

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}
