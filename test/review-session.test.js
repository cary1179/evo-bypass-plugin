import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectEvent } from '../src/collect-event.js';
import { reviewSession } from '../src/review-session.js';

test('reviewSession suggests durable knowledge from convention evidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  await collectEvent({ root, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess_review', prompt: 'Use Node only' } });
  await collectEvent({
    root,
    payload: {
      hook_event_name: 'PostToolUse',
      session_id: 'sess_review',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { exit_code: 0, output: 'Project convention: use node:test and avoid runtime dependencies.' }
    }
  });

  const result = await reviewSession({ root, sessionId: 'sess_review' });
  assert.equal(result.session_id, 'sess_review');
  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].kind, 'project_convention');
  assert.equal(result.suggestions[0].target.endsWith('.bypass/knowledge.md'), true);
});

test('reviewSession emits no suggestions without durable signals', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  await collectEvent({ root, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess_empty', prompt: 'hello' } });

  const result = await reviewSession({ root, sessionId: 'sess_empty' });
  assert.deepEqual(result.suggestions, []);
});
