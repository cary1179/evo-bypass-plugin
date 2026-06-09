import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveServicePaths } from '../core/service-paths.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const LOCAL_FALLBACK_URL = 'http://127.0.0.1:8766';

export function serviceUrl({ host = '127.0.0.1', port = 8766 } = {}) {
  return `http://${host}:${port}`;
}

export async function readServiceUrl({ root = process.cwd(), fallbackUrl } = {}) {
  if (process.env.EVO_BYPASS_SERVICE_URL) {
    return safeServiceUrl(process.env.EVO_BYPASS_SERVICE_URL, fallbackUrl);
  }

  const paths = resolveServicePaths({ root });
  try {
    const text = await fs.readFile(paths.serviceUrlPath, 'utf8');
    return safeServiceUrl(text.trim(), fallbackUrl);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return safeFallbackUrl(fallbackUrl);
    }
    return safeFallbackUrl(fallbackUrl);
  }
}

export async function checkServiceHealth({ url, timeoutMs = 250 } = {}) {
  if (!url) {
    return { healthy: false, error: 'missing service url' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${trimTrailingSlashes(url)}/api/health`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return { healthy: false, error: `health returned ${response.status}` };
    }

    const body = await response.json();
    if (body?.name !== 'evo-bypassd') {
      return { healthy: false, error: 'unexpected service health response', body };
    }
    return { healthy: true, body };
  } catch (error) {
    return { healthy: false, error: error.message || String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function enqueueReviewJob({ url, job, timeoutMs = 500 } = {}) {
  if (!url) {
    return { enqueued: false, error: 'missing service url' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${trimTrailingSlashes(url)}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(job ?? {}),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { enqueued: false, error: `enqueue returned ${response.status}` };
    }

    let body;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    return { enqueued: true, body };
  } catch (error) {
    return { enqueued: false, error: error.message || String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function appendHookLog({ root = process.cwd(), file = 'stop-hook.log', entry = {} } = {}) {
  try {
    const logPath = path.join(root, '.bypass', file);
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(logPath, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      cwd: root,
      ...entry,
    })}\n`);
  } catch {
    // Hook observability is best-effort; hook output must stay valid JSON.
  }
}

export function startServiceDetached({ root = process.cwd(), scriptPath, env = process.env } = {}) {
  if (!scriptPath || !fsSync.existsSync(scriptPath)) {
    return { started: false, reason: 'missing_script', scriptPath };
  }

  const child = spawn(process.execPath, [scriptPath, '--root', root], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    env,
  });
  child.unref();
  return { started: true, pid: child.pid };
}

function trimTrailingSlashes(url) {
  return String(url).replace(/\/+$/, '');
}

function safeServiceUrl(candidate, fallbackUrl) {
  if (!candidate) {
    return safeFallbackUrl(fallbackUrl);
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.has(parsed.hostname)) {
      return safeFallbackUrl(fallbackUrl);
    }
    return trimTrailingSlashes(parsed.href);
  } catch {
    return safeFallbackUrl(fallbackUrl);
  }
}

function safeFallbackUrl(fallbackUrl) {
  if (!fallbackUrl) {
    return LOCAL_FALLBACK_URL;
  }

  try {
    const parsed = new URL(fallbackUrl);
    if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.has(parsed.hostname)) {
      return LOCAL_FALLBACK_URL;
    }
    return trimTrailingSlashes(parsed.href);
  } catch {
    return LOCAL_FALLBACK_URL;
  }
}
