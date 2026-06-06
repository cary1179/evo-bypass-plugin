import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServiceServer } from '../src/service/server.js';
import { resolveServicePaths } from '../src/core/service-paths.js';
import { resolveSessionPaths } from '../src/core/session-paths.js';

test('service server exposes health and writes service files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-service-'));
  const service = await startServiceServer({ root, host: '127.0.0.1', port: 0, startWorker: false });
  try {
    const health = await getJson(`${service.url}/api/health`);
    assert.equal(health.name, 'evo-bypassd');
    assert.equal(health.ok, true);
    assert.equal(health.root, root);
    assert.equal(health.url, service.url);
    assert.equal(health.pid, process.pid);

    const paths = resolveServicePaths({ root });
    assert.equal((await fs.readFile(paths.serviceUrlPath, 'utf8')).trim(), service.url);
    assert.equal((await fs.readFile(paths.servicePidPath, 'utf8')).trim(), String(process.pid));
  } finally {
    await service.close();
  }
});

test('service server enqueues, lists, and returns job details using configured root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-service-'));
  const escapedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-escaped-'));
  const service = await startServiceServer({ root, host: '127.0.0.1', port: 0, startWorker: false });
  try {
    const enqueue = await postJson(`${service.url}/api/jobs`, {
      session_id: 'sess_jobs',
      runtime: 'codex',
      root: escapedRoot,
    });
    assert.equal(enqueue.response.status, 202);
    assert.equal(enqueue.body.id, 'job_sess_jobs');
    assert.equal(enqueue.body.session_id, 'sess_jobs');
    assert.equal(enqueue.body.runtime, 'codex');
    assert.equal(enqueue.body.root, root);

    const list = await getJson(`${service.url}/api/jobs`);
    assert.equal(list.root, root);
    assert.equal(list.jobs.length, 1);
    assert.equal(list.jobs[0].id, 'job_sess_jobs');

    const detail = await getJson(`${service.url}/api/jobs/job_sess_jobs`);
    assert.equal(detail.id, 'job_sess_jobs');
    assert.equal(detail.root, root);

    const escapedJobsDir = resolveServicePaths({ root: escapedRoot }).jobsDir;
    await assert.rejects(fs.readdir(escapedJobsDir), { code: 'ENOENT' });
  } finally {
    await service.close();
  }
});

test('service server delegates sessions APIs and serves existing UI HTML', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-service-'));
  await writeSession(root, 'sess_ui');
  const service = await startServiceServer({ root, host: '127.0.0.1', port: 0, startWorker: false });
  try {
    const sessions = await getJson(`${service.url}/api/sessions`);
    assert.equal(sessions.root, root);
    assert.equal(sessions.sessions.length, 1);
    assert.equal(sessions.sessions[0].session_id, 'sess_ui');

    const detail = await getJson(`${service.url}/api/sessions/sess_ui`);
    assert.equal(detail.session_id, 'sess_ui');
    assert.equal(detail.metadata.runtime, 'codex');

    for (const route of ['/', '/sessions', '/sessions/sess_ui']) {
      const response = await fetch(`${service.url}${route}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type').includes('text/html'), true);
      assert.match(await response.text(), /Evo Bypass Session Reviewer/);
    }
  } finally {
    await service.close();
  }
});

test('service server keeps apply route isolated until Task 7 exists', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-service-'));
  await writeSession(root, 'sess_apply');
  const service = await startServiceServer({ root, host: '127.0.0.1', port: 0, startWorker: false });
  try {
    const result = await postJson(`${service.url}/api/sessions/sess_apply/apply`, {});
    assert.equal(result.response.status, 501);
    assert.match(result.body.error, /not implemented/i);
  } finally {
    await service.close();
  }
});

test('service close stops accepting requests', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-service-'));
  const service = await startServiceServer({ root, host: '127.0.0.1', port: 0, startWorker: false });
  const url = service.url;
  await service.close();

  await assert.rejects(fetch(`${url}/api/health`), /fetch failed/i);
});

async function getJson(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type').includes('application/json'), true);
  return response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(response.headers.get('content-type').includes('application/json'), true);
  return { response, body: await response.json() };
}

async function writeSession(root, sessionId) {
  const paths = resolveSessionPaths({ root, sessionId });
  await fs.mkdir(paths.sessionDir, { recursive: true });
  await fs.writeFile(paths.metadataPath, `${JSON.stringify({
    session_id: sessionId,
    created_at: '2026-06-06T12:00:00.000Z',
    runtime: 'codex',
    working_directory: root,
    original_prompt: 'Review this session.',
    plugin_version: '0.1.0',
  })}\n`);
  await fs.writeFile(paths.eventsPath, `${JSON.stringify({
    id: 'evt_service',
    session_id: sessionId,
    timestamp: '2026-06-06T12:00:00.000Z',
    hook: 'PostToolUse',
    tool: 'Bash',
    summary: 'Bash ran command: node --test',
    paths: [],
    status: 'success',
    signals: [],
    evidence: ['node --test'],
  })}\n`);
}
