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

test('applyApprovedUpdate rejects approval ids that are not an array', async () => {
  const { root } = await writeApprovedUpdateFixture({
    sessionId: 'sess_apply_string_ids',
    approvedSuggestionIds: 'sug_1'
  });

  await assert.rejects(
    applyApprovedUpdate({ root, sessionId: 'sess_apply_string_ids' }),
    /approval must include approved_suggestion_ids and approval_text/
  );
});

test('applyApprovedUpdate rejects approval ids that are empty', async () => {
  const { root } = await writeApprovedUpdateFixture({
    sessionId: 'sess_apply_empty_ids',
    approvedSuggestionIds: []
  });

  await assert.rejects(
    applyApprovedUpdate({ root, sessionId: 'sess_apply_empty_ids' }),
    /approval must include approved_suggestion_ids and approval_text/
  );
});

test('applyApprovedUpdate rejects blank approval ids', async () => {
  const { root } = await writeApprovedUpdateFixture({
    sessionId: 'sess_apply_blank_ids',
    approvedSuggestionIds: ['']
  });

  await assert.rejects(
    applyApprovedUpdate({ root, sessionId: 'sess_apply_blank_ids' }),
    /approval must include approved_suggestion_ids and approval_text/
  );
});

async function writeApprovedUpdateFixture({ sessionId, approvedSuggestionIds }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const paths = resolveSessionPaths({ root, sessionId });
  await fs.mkdir(paths.sessionDir, { recursive: true });
  await fs.writeFile(paths.suggestionsPath, JSON.stringify({
    session_id: sessionId,
    suggestions: [
      { id: 'sug_1', target: paths.defaultKnowledgePath, proposed_text: 'Project convention: use node:test.' }
    ]
  }));
  await fs.writeFile(paths.approvalPath, JSON.stringify({
    approved_at: new Date().toISOString(),
    approved_suggestion_ids: approvedSuggestionIds,
    approval_text: 'yes, apply sug_1'
  }));

  return { root, paths };
}
