import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const enqueueCli = path.join(repoRoot, 'scripts', 'enqueue-review-job.js');
const sessionStartCli = path.join(repoRoot, 'scripts', 'session-start-service.js');

test('enqueue-review-job skips when service health is unavailable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-hook-'));
  const result = spawnSync(process.execPath, [enqueueCli, '--runtime', 'codex'], {
    cwd: root,
    input: JSON.stringify({ session_id: 'sess_skip', cwd: root }),
    env: { ...process.env, EVO_BYPASS_SERVICE_URL: 'http://127.0.0.1:9' },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.continue, true);
  const log = await fs.readFile(path.join(root, '.bypass', 'stop-hook.log'), 'utf8');
  assert.match(log, /service_unhealthy/);
});

test('enqueue-review-job posts job when service is healthy', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-hook-'));
  const jobs = [];
  const server = http.createServer(async (request, response) => {
    if (request.url === '/api/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ name: 'evo-bypassd', ok: true }));
      return;
    }
    if (request.url === '/api/jobs') {
      let body = '';
      for await (const chunk of request) body += chunk;
      jobs.push(JSON.parse(body));
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'job_sess_ok', status: 'queued' }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const result = await runCli([enqueueCli, '--runtime', 'codex'], {
      cwd: root,
      input: JSON.stringify({ session_id: 'sess_ok', cwd: root }),
      env: { ...process.env, EVO_BYPASS_SERVICE_URL: `http://127.0.0.1:${port}` },
    });

    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { continue: true, suppressOutput: true });
    assert.deepEqual(jobs[0], { session_id: 'sess_ok', runtime: 'codex', root });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('enqueue-review-job honors payload root when service is healthy', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-hook-cwd-'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-hook-root-'));
  const jobs = [];
  const server = http.createServer(async (request, response) => {
    if (request.url === '/api/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ name: 'evo-bypassd', ok: true }));
      return;
    }
    if (request.url === '/api/jobs') {
      let body = '';
      for await (const chunk of request) body += chunk;
      jobs.push(JSON.parse(body));
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'job_sess_root', status: 'queued' }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const result = await runCli([enqueueCli, '--runtime', 'codex'], {
      cwd,
      input: JSON.stringify({ session_id: 'sess_root', root }),
      env: { ...process.env, EVO_BYPASS_SERVICE_URL: `http://127.0.0.1:${port}` },
    });

    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { continue: true, suppressOutput: true });
    assert.deepEqual(jobs[0], { session_id: 'sess_root', runtime: 'codex', root });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('session-start-service emits continue JSON when service is already healthy', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-session-start-'));
  const server = http.createServer((request, response) => {
    if (request.url === '/api/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ name: 'evo-bypassd', ok: true }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const result = await runCli([sessionStartCli, '--runtime', 'claude'], {
      cwd: root,
      input: JSON.stringify({ cwd: root }),
      env: { ...process.env, EVO_BYPASS_SERVICE_URL: `http://127.0.0.1:${port}` },
    });

    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { continue: true, suppressOutput: true });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

function runCli(args, { cwd, input, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (status, signal) => {
      resolve({ status, signal, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

test('session-start-service emits continue JSON when service is disabled', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-session-disabled-'));
  await fs.mkdir(path.join(root, '.bypass'), { recursive: true });
  await fs.writeFile(path.join(root, '.bypass', 'config.json'), JSON.stringify({ service: { enabled: false } }));

  const result = spawnSync(process.execPath, [sessionStartCli, '--runtime', 'codex'], {
    cwd: root,
    input: JSON.stringify({ cwd: root }),
    env: { ...process.env, EVO_BYPASS_SERVICE_URL: 'http://127.0.0.1:9' },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { continue: true, suppressOutput: true });
});

test('session-start-service honors payload root when service is disabled', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-session-cwd-'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-session-root-'));
  await fs.mkdir(path.join(root, '.bypass'), { recursive: true });
  await fs.writeFile(path.join(root, '.bypass', 'config.json'), JSON.stringify({ service: { enabled: false } }));

  const result = spawnSync(process.execPath, [sessionStartCli, '--runtime', 'codex'], {
    cwd,
    input: JSON.stringify({ root }),
    env: { ...process.env, EVO_BYPASS_SERVICE_URL: 'http://127.0.0.1:9' },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { continue: true, suppressOutput: true });
  await assert.rejects(fs.stat(path.join(cwd, '.bypass', 'service', 'session-start.log')), { code: 'ENOENT' });
});

test('session-start-service requests daemon start when service is unhealthy', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-session-start-daemon-'));
  const port = await freePort();
  await fs.mkdir(path.join(root, '.bypass'), { recursive: true });
  await fs.writeFile(path.join(root, '.bypass', 'config.json'), JSON.stringify({ service: { port } }));
  const result = spawnSync(process.execPath, [sessionStartCli, '--runtime', 'codex'], {
    cwd: root,
    input: JSON.stringify({ root }),
    env: { ...process.env, EVO_BYPASS_SERVICE_URL: 'http://127.0.0.1:9' },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { continue: true, suppressOutput: true });
  const log = await fs.readFile(path.join(root, '.bypass', 'service', 'session-start.log'), 'utf8');
  const entry = JSON.parse(log.trim());
  assert.equal(entry.event, 'service_start_requested');
  assert.equal(entry.runtime, 'codex');
  assert.equal(typeof entry.pid, 'number');
  try {
    const serviceUrl = await waitForServiceUrl(root);
    assert.equal(serviceUrl, `http://127.0.0.1:${port}`);
  } finally {
    stopDetachedProcess(entry.pid);
  }
});

function stopDetachedProcess(pid) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // The daemon may have already exited if the default port was unavailable.
  }
}

function freePort() {
  const server = http.createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServiceUrl(root, { timeoutMs = 1000 } = {}) {
  const serviceUrlPath = path.join(root, '.bypass', 'service', 'service-url');
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return (await fs.readFile(serviceUrlPath, 'utf8')).trim();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('timed out waiting for daemon service-url file');
}
