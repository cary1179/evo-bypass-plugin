import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveSessionPaths } from '../src/core/session-paths.js';
import { applyEditedApprovedUpdate } from '../src/service/apply-edited-update.js';

test('applyEditedApprovedUpdate applies edited text from retrospective update_knowledge finding', async () => {
  const { root, paths } = await writeRetrospectiveFixture({ sessionId: 'sess_edited_apply' });

  const result = await applyEditedApprovedUpdate({
    root,
    sessionId: 'sess_edited_apply',
    approved_suggestion_ids: ['finding_1'],
    edits: {
      finding_1: 'Edited project convention: prefer node --test for focused checks.'
    }
  });
  const knowledge = await fs.readFile(paths.defaultKnowledgePath, 'utf8');
  const approval = JSON.parse(await fs.readFile(paths.approvalPath, 'utf8'));
  const patch = await fs.readFile(paths.appliedPatchPath, 'utf8');

  assert.equal(result.applied_count, 1);
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].id, 'finding_1');
  assert.equal(result.applied[0].target, paths.defaultKnowledgePath);
  assert.match(knowledge, /Edited project convention: prefer node --test/);
  assert.equal(knowledge.includes('Original project convention'), false);
  assert.deepEqual(approval.approved_suggestion_ids, ['finding_1']);
  assert.equal(approval.edits.finding_1, 'Edited project convention: prefer node --test for focused checks.');
  assert.match(patch, /finding_1/);
});

test('applyEditedApprovedUpdate accepts approvals array text shape', async () => {
  const { root, paths } = await writeRetrospectiveFixture({ sessionId: 'sess_edited_approvals_array' });

  const result = await applyEditedApprovedUpdate({
    root,
    sessionId: 'sess_edited_approvals_array',
    approvals: [{ id: 'finding_1', text: 'Edited via approvals array.' }]
  });
  const knowledge = await fs.readFile(paths.defaultKnowledgePath, 'utf8');

  assert.equal(result.applied_count, 1);
  assert.match(knowledge, /Edited via approvals array/);
});

test('applyEditedApprovedUpdate rejects empty edited text', async () => {
  const { root, paths } = await writeRetrospectiveFixture({ sessionId: 'sess_edited_empty' });

  await assert.rejects(
    applyEditedApprovedUpdate({
      root,
      sessionId: 'sess_edited_empty',
      approved_suggestion_ids: ['finding_1'],
      edits: { finding_1: '   ' }
    }),
    /approved update text must be non-empty/
  );
  await assert.rejects(fs.stat(paths.defaultKnowledgePath), { code: 'ENOENT' });
});

test('applyEditedApprovedUpdate rejects unknown approved id', async () => {
  const { root, paths } = await writeRetrospectiveFixture({ sessionId: 'sess_edited_unknown' });

  await assert.rejects(
    applyEditedApprovedUpdate({
      root,
      sessionId: 'sess_edited_unknown',
      approved_suggestion_ids: ['finding_404']
    }),
    /approved_suggestion_ids must match suggestions/
  );
  await assert.rejects(fs.stat(paths.defaultKnowledgePath), { code: 'ENOENT' });
});

test('applyEditedApprovedUpdate rejects outside target escape', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-parent-'));
  const root = path.join(parent, 'root');
  const outsidePath = path.join(parent, 'outside.md');
  const { paths } = await writeRetrospectiveFixture({
    root,
    sessionId: 'sess_edited_outside',
    target: '../outside.md'
  });

  await assert.rejects(
    applyEditedApprovedUpdate({
      root,
      sessionId: 'sess_edited_outside',
      approved_suggestion_ids: ['finding_1']
    }),
    /target must stay inside root/
  );
  await assert.rejects(fs.stat(outsidePath), { code: 'ENOENT' });
  await assert.rejects(fs.stat(paths.appliedPatchPath), { code: 'ENOENT' });
});

test('applyEditedApprovedUpdate rejects missing file under symlinked outside parent', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-parent-'));
  const root = path.join(parent, 'root');
  const outside = path.join(parent, 'outside');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.symlink(outside, path.join(root, 'linked-outside'));
  const target = 'linked-outside/missing.md';
  const { paths } = await writeRetrospectiveFixture({
    root,
    sessionId: 'sess_edited_symlink_parent',
    target
  });

  await assert.rejects(
    applyEditedApprovedUpdate({
      root,
      sessionId: 'sess_edited_symlink_parent',
      approved_suggestion_ids: ['finding_1']
    }),
    /target must stay inside root/
  );
  await assert.rejects(fs.stat(path.join(outside, 'missing.md')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(paths.appliedPatchPath), { code: 'ENOENT' });
});

async function writeRetrospectiveFixture({
  root,
  sessionId,
  target,
  proposedText = 'Original project convention: use node:test.'
}) {
  root ??= await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const paths = resolveSessionPaths({ root, sessionId });
  await fs.mkdir(paths.sessionDir, { recursive: true });
  await fs.writeFile(paths.retrospectivePath, `${JSON.stringify({
    session_id: sessionId,
    summary: 'Found one action.',
    retrospective: {
      outcome: 'completed',
      quality: 'minor_issues',
      findings: [{
        id: 'finding_1',
        category: 'knowledge',
        severity: 'medium',
        evidence: ['evt_1'],
        diagnosis: 'Reusable convention.',
        recommendation: 'Save it.',
        action: {
          type: 'update_knowledge',
          confidence: 'high',
          target: target || paths.defaultKnowledgePath,
          proposed_text: proposedText,
          rationale: 'Future sessions should remember this.'
        }
      }]
    }
  })}\n`);
  return { root, paths };
}
