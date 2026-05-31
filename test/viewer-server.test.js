import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startViewerServer, viewerUrl } from '../src/viewer/server.js';
import { resolveSessionPaths } from '../src/core/session-paths.js';

test('viewer server exposes health, JSON APIs, and UI routes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-viewer-'));
  await writeSession(root, 'sess_viewer');
  const viewer = await startViewerServer({ root, host: '127.0.0.1', port: 0 });
  try {
    const base = viewer.url;
    const health = await getJson(`${base}/api/health`);
    assert.equal(health.name, 'evo-bypass-session-viewer');
    assert.equal(health.root, root);
    assert.equal(health.version, '0.1.0');

    const list = await getJson(`${base}/api/sessions`);
    assert.equal(list.root, root);
    assert.equal(list.sessions.length, 1);
    assert.equal(list.sessions[0].session_id, 'sess_viewer');

    const detail = await getJson(`${base}/api/sessions/sess_viewer`);
    assert.equal(detail.session_id, 'sess_viewer');
    assert.equal(detail.metadata.runtime, 'codex');
    assert.equal(detail.events.length, 1);

    const missing = await fetch(`${base}/api/nope`);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('content-type').includes('application/json'), true);

    const listHtml = await fetch(`${base}/sessions`);
    assert.equal(listHtml.status, 200);
    assert.match(await listHtml.text(), /Evo Bypass Session Reviewer/);

    const detailHtml = await fetch(`${base}/sessions/sess_viewer`);
    assert.equal(detailHtml.status, 200);
    assert.match(await detailHtml.text(), /Evo Bypass Session Reviewer/);
  } finally {
    await viewer.close();
  }
});

test('viewerUrl points to the detail route when session id is provided', () => {
  assert.equal(
    viewerUrl({ host: '127.0.0.1', port: 8765, sessionId: 'sess_123' }),
    'http://127.0.0.1:8765/sessions/sess_123'
  );
  assert.equal(
    viewerUrl({ host: '127.0.0.1', port: 8765 }),
    'http://127.0.0.1:8765/sessions'
  );
});

async function getJson(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type').includes('application/json'), true);
  return response.json();
}

async function writeSession(root, sessionId) {
  const paths = resolveSessionPaths({ root, sessionId });
  await fs.mkdir(paths.sessionDir, { recursive: true });
  await fs.writeFile(paths.metadataPath, `${JSON.stringify({
    session_id: sessionId,
    created_at: '2026-05-31T12:00:00.000Z',
    runtime: 'codex',
    working_directory: root,
    original_prompt: 'Open the viewer.',
    plugin_version: '0.1.0'
  })}\n`);
  await fs.writeFile(paths.eventsPath, `${JSON.stringify({
    id: 'evt_viewer',
    session_id: sessionId,
    timestamp: '2026-05-31T12:00:00.000Z',
    hook: 'PostToolUse',
    tool: 'Bash',
    summary: 'Bash ran command: npm test',
    paths: [],
    status: 'success',
    signals: [],
    evidence: ['npm test']
  })}\n`);
  await fs.writeFile(paths.suggestionsPath, `${JSON.stringify({
    session_id: sessionId,
    summary: 'No durable knowledge updates suggested for this session.',
    suggestions: []
  })}\n`);
}
