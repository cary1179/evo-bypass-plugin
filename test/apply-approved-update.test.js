import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveSessionPaths } from '../src/core/session-paths.js';
import { applyApprovedUpdate } from '../src/apply-approved-update.js';

test('applyApprovedUpdate refuses to write without approval', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const paths = resolveSessionPaths({ root, sessionId: 'sess_apply' });
  await fs.mkdir(paths.sessionDir, { recursive: true });
  await fs.writeFile(paths.suggestionsPath, JSON.stringify({
    session_id: 'sess_apply',
    suggestions: [{ id: 'sug_1', target: paths.defaultKnowledgePath, proposed_text: 'Remember this.' }]
  }));

  await assert.rejects(
    applyApprovedUpdate({ root, sessionId: 'sess_apply' }),
    /approval.json is required/
  );
});

test('applyApprovedUpdate writes only approved suggestions and records patch', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const paths = resolveSessionPaths({ root, sessionId: 'sess_apply_ok' });
  await fs.mkdir(paths.sessionDir, { recursive: true });
  await fs.writeFile(paths.suggestionsPath, JSON.stringify({
    session_id: 'sess_apply_ok',
    suggestions: [
      { id: 'sug_1', target: paths.defaultKnowledgePath, proposed_text: 'Project convention: use node:test.' },
      { id: 'sug_2', target: paths.defaultKnowledgePath, proposed_text: 'Do not write me.' }
    ]
  }));
  await fs.writeFile(paths.approvalPath, JSON.stringify({
    approved_at: new Date().toISOString(),
    approved_suggestion_ids: ['sug_1'],
    approval_text: 'yes, apply sug_1'
  }));

  const result = await applyApprovedUpdate({ root, sessionId: 'sess_apply_ok' });
  const knowledge = await fs.readFile(paths.defaultKnowledgePath, 'utf8');
  const patch = await fs.readFile(paths.appliedPatchPath, 'utf8');

  assert.equal(result.applied.length, 1);
  assert.match(knowledge, /Project convention: use node:test/);
  assert.equal(knowledge.includes('Do not write me'), false);
  assert.match(patch, /sug_1/);
});
