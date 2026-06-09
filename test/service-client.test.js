import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  appendHookLog,
  checkServiceHealth,
  enqueueReviewJob,
  readServiceUrl,
  serviceUrl,
} from '../src/service/service-client.js';

test('serviceUrl formats service host and port', () => {
  assert.equal(serviceUrl({ host: '127.0.0.1', port: 8766 }), 'http://127.0.0.1:8766');
});

test('readServiceUrl prefers environment then service-url file then fallback', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-service-url-'));
  const previous = process.env.EVO_BYPASS_SERVICE_URL;
  try {
    process.env.EVO_BYPASS_SERVICE_URL = 'http://127.0.0.1:1111';
    assert.equal(await readServiceUrl({ root, fallbackUrl: 'http://127.0.0.1:2222' }), 'http://127.0.0.1:1111');

    delete process.env.EVO_BYPASS_SERVICE_URL;
    await fs.mkdir(path.join(root, '.bypass', 'service'), { recursive: true });
    await fs.writeFile(path.join(root, '.bypass', 'service', 'service-url'), 'http://127.0.0.1:3333\n');
    assert.equal(await readServiceUrl({ root, fallbackUrl: 'http://127.0.0.1:2222' }), 'http://127.0.0.1:3333');
  } finally {
    restoreEnv('EVO_BYPASS_SERVICE_URL', previous);
  }
});

test('readServiceUrl ignores remote environment URL', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-service-url-'));
  const previous = process.env.EVO_BYPASS_SERVICE_URL;
  try {
    process.env.EVO_BYPASS_SERVICE_URL = 'http://example.com:8766';
    assert.equal(await readServiceUrl({ root, fallbackUrl: 'http://127.0.0.1:2222' }), 'http://127.0.0.1:2222');
  } finally {
    restoreEnv('EVO_BYPASS_SERVICE_URL', previous);
  }
});

test('readServiceUrl ignores remote service-url file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-service-url-'));
  const previous = process.env.EVO_BYPASS_SERVICE_URL;
  try {
    delete process.env.EVO_BYPASS_SERVICE_URL;
    await fs.mkdir(path.join(root, '.bypass', 'service'), { recursive: true });
    await fs.writeFile(path.join(root, '.bypass', 'service', 'service-url'), 'http://10.0.0.20:8766\n');
    assert.equal(await readServiceUrl({ root, fallbackUrl: 'http://127.0.0.1:2222' }), 'http://127.0.0.1:2222');
  } finally {
    restoreEnv('EVO_BYPASS_SERVICE_URL', previous);
  }
});

test('readServiceUrl ignores remote fallback URL', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-service-url-'));
  const previous = process.env.EVO_BYPASS_SERVICE_URL;
  try {
    delete process.env.EVO_BYPASS_SERVICE_URL;
    assert.equal(await readServiceUrl({ root, fallbackUrl: 'http://example.com:8766' }), 'http://127.0.0.1:8766');
  } finally {
    restoreEnv('EVO_BYPASS_SERVICE_URL', previous);
  }
});

test('readServiceUrl accepts loopback service URLs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-service-url-'));
  const previous = process.env.EVO_BYPASS_SERVICE_URL;
  try {
    process.env.EVO_BYPASS_SERVICE_URL = 'http://localhost:8766';
    assert.equal(await readServiceUrl({ root, fallbackUrl: 'http://127.0.0.1:2222' }), 'http://localhost:8766');

    process.env.EVO_BYPASS_SERVICE_URL = 'http://[::1]:8766';
    assert.equal(await readServiceUrl({ root, fallbackUrl: 'http://127.0.0.1:2222' }), 'http://[::1]:8766');
  } finally {
    restoreEnv('EVO_BYPASS_SERVICE_URL', previous);
  }
});

test('checkServiceHealth returns healthy for service health response', async () => {
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/api/health');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ name: 'evo-bypassd', ok: true }));
  });
  await listen(server);
  try {
    const { port } = server.address();
    const result = await checkServiceHealth({ url: `http://127.0.0.1:${port}`, timeoutMs: 500 });
    assert.equal(result.healthy, true);
  } finally {
    await close(server);
  }
});

test('checkServiceHealth rejects health response from other services', async () => {
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/api/health');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ name: 'some-other-service', ok: true }));
  });
  await listen(server);
  try {
    const { port } = server.address();
    const result = await checkServiceHealth({ url: `http://127.0.0.1:${port}`, timeoutMs: 500 });
    assert.equal(result.healthy, false);
  } finally {
    await close(server);
  }
});

test('checkServiceHealth returns unhealthy on connection failure', async () => {
  const result = await checkServiceHealth({ url: 'http://127.0.0.1:9', timeoutMs: 50 });
  assert.equal(result.healthy, false);
  assert.match(result.error, /fetch failed|bad port|ECONNREFUSED|terminated/i);
});

test('enqueueReviewJob posts small job payload', async () => {
  const received = [];
  const server = http.createServer(async (request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/api/jobs');
    let body = '';
    for await (const chunk of request) body += chunk;
    received.push(JSON.parse(body));
    response.writeHead(202, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'job_sess_1', status: 'queued' }));
  });
  await listen(server);
  try {
    const { port } = server.address();
    const result = await enqueueReviewJob({
      url: `http://127.0.0.1:${port}`,
      job: { session_id: 'sess_1', runtime: 'codex', root: '/tmp/repo' },
      timeoutMs: 500,
    });
    assert.equal(result.enqueued, true);
    assert.deepEqual(received[0], { session_id: 'sess_1', runtime: 'codex', root: '/tmp/repo' });
  } finally {
    await close(server);
  }
});

test('appendHookLog is best-effort and writes JSONL when possible', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-hook-log-'));
  await appendHookLog({ root, entry: { event: 'service_unhealthy', runtime: 'codex' } });
  const line = await fs.readFile(path.join(root, '.bypass', 'stop-hook.log'), 'utf8');
  const parsed = JSON.parse(line);
  assert.equal(parsed.event, 'service_unhealthy');
  assert.equal(parsed.runtime, 'codex');
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function restoreEnv(name, previousValue) {
  if (previousValue === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previousValue;
  }
}
