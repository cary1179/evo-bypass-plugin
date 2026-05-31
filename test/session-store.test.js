import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listSessions, getSessionDetail } from '../src/viewer/session-store.js';
import { resolveSessionPaths } from '../src/core/session-paths.js';

test('listSessions returns compact summaries newest first', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-store-'));
  await writeSession(root, 'sess_old', {
    metadata: {
      session_id: 'sess_old',
      created_at: '2026-05-30T09:00:00.000Z',
      runtime: 'codex',
      working_directory: root,
      original_prompt: 'Use Node only for project scripts.',
      plugin_version: '0.1.0'
    },
    events: [
      event({ id: 'evt_old_1', sessionId: 'sess_old', status: 'success', signals: ['project_convention'] }),
      event({ id: 'evt_old_2', sessionId: 'sess_old', status: 'failure', signals: ['test_failure'] })
    ],
    suggestions: {
      session_id: 'sess_old',
      summary: 'Found 1 possible knowledge update(s).',
      suggestions: [{ id: 'sug_1', proposed_text: 'Project convention: use node:test.' }],
      suggestion_report_path: '/tmp/report.md'
    }
  });
  await writeSession(root, 'sess_new', {
    metadata: {
      session_id: 'sess_new',
      created_at: '2026-05-31T09:00:00.000Z',
      runtime: 'claude',
      working_directory: root,
      original_prompt: 'A newer prompt that should be first.',
      plugin_version: '0.1.0'
    },
    events: [event({ id: 'evt_new_1', sessionId: 'sess_new', status: 'unknown', signals: [] })],
    suggestions: { session_id: 'sess_new', summary: 'No durable knowledge updates suggested for this session.', suggestions: [] }
  });

  const result = await listSessions({ root });

  assert.equal(result.root, root);
  assert.deepEqual(result.sessions.map((session) => session.session_id), ['sess_new', 'sess_old']);
  assert.equal(result.sessions[1].event_count, 2);
  assert.equal(result.sessions[1].failure_count, 1);
  assert.deepEqual(result.sessions[1].signals, ['project_convention', 'test_failure']);
  assert.equal(result.sessions[1].suggestion_count, 1);
  assert.equal(result.sessions[1].has_suggestion_report, true);
  assert.match(result.sessions[1].prompt_preview, /Use Node only/);
});

test('getSessionDetail returns parsed artifacts and malformed event count', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-store-'));
  await writeSession(root, 'sess_detail', {
    metadata: {
      session_id: 'sess_detail',
      created_at: '2026-05-31T10:00:00.000Z',
      runtime: 'codex',
      working_directory: root,
      original_prompt: 'Inspect this session.',
      plugin_version: '0.1.0'
    },
    events: [event({ id: 'evt_detail', sessionId: 'sess_detail', status: 'success', signals: ['project_convention'] })],
    rawEventLines: ['{bad json'],
    suggestions: {
      session_id: 'sess_detail',
      summary: 'Found 1 possible knowledge update(s).',
      suggestions: [{ id: 'sug_detail', proposed_text: 'Project convention: keep reports short.' }]
    },
    reviewerLog: 'Found 1 possible knowledge update(s).\n'
  });

  const detail = await getSessionDetail({ root, sessionId: 'sess_detail' });

  assert.equal(detail.session_id, 'sess_detail');
  assert.equal(detail.metadata.original_prompt, 'Inspect this session.');
  assert.equal(detail.events.length, 1);
  assert.equal(detail.events[0].id, 'evt_detail');
  assert.equal(detail.malformedEventCount, 1);
  assert.equal(detail.suggestions.suggestions.length, 1);
  assert.equal(detail.reviewerLog, 'Found 1 possible knowledge update(s).\n');
});

test('getSessionDetail rejects unsafe session ids', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-store-'));

  await assert.rejects(
    getSessionDetail({ root, sessionId: '../outside' }),
    /sessionId must be a safe path segment/
  );
});

test('session store degrades missing optional artifacts to empty values', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-store-'));
  const paths = resolveSessionPaths({ root, sessionId: 'sess_sparse' });
  await fs.mkdir(paths.sessionDir, { recursive: true });
  await fs.writeFile(paths.metadataPath, `${JSON.stringify({
    session_id: 'sess_sparse',
    created_at: '2026-05-31T11:00:00.000Z',
    runtime: 'codex',
    original_prompt: 'Sparse session'
  })}\n`);

  const [summary] = (await listSessions({ root })).sessions;
  const detail = await getSessionDetail({ root, sessionId: 'sess_sparse' });

  assert.equal(summary.event_count, 0);
  assert.equal(summary.suggestion_count, 0);
  assert.deepEqual(detail.events, []);
  assert.deepEqual(detail.suggestions, {
    session_id: 'sess_sparse',
    summary: 'No suggestions file found for this session.',
    suggestions: []
  });
  assert.equal(detail.reviewerLog, '');
});

function event({ id, sessionId, status, signals }) {
  return {
    id,
    session_id: sessionId,
    timestamp: '2026-05-31T10:00:00.000Z',
    hook: 'PostToolUse',
    tool: 'Bash',
    summary: 'Bash ran command: npm test',
    paths: [],
    status,
    signals,
    evidence: ['npm test']
  };
}

async function writeSession(root, sessionId, { metadata, events, rawEventLines = [], suggestions, reviewerLog = '' }) {
  const paths = resolveSessionPaths({ root, sessionId });
  await fs.mkdir(paths.sessionDir, { recursive: true });
  await fs.writeFile(paths.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  await fs.writeFile(paths.eventsPath, `${events.map((item) => JSON.stringify(item)).concat(rawEventLines).join('\n')}\n`);
  await fs.writeFile(paths.suggestionsPath, `${JSON.stringify(suggestions, null, 2)}\n`);
  await fs.writeFile(paths.reviewerLogPath, reviewerLog);
}
