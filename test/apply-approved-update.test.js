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

test('applyApprovedUpdate falls back to legacy suggestions.json when retrospective is absent', async () => {
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

test('applyApprovedUpdate writes approved update_knowledge findings from retrospective', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const paths = resolveSessionPaths({ root, sessionId: 'sess_apply_retro' });
  await fs.mkdir(paths.sessionDir, { recursive: true });
  await fs.writeFile(paths.retrospectivePath, JSON.stringify({
    session_id: 'sess_apply_retro',
    summary: 'Found one action.',
    retrospective: {
      outcome: 'completed',
      quality: 'minor_issues',
      findings: [{
        id: 'finding_knowledge',
        category: 'knowledge',
        severity: 'medium',
        evidence: ['evt_1'],
        diagnosis: 'Reusable convention.',
        recommendation: 'Save it.',
        action: {
          type: 'update_knowledge',
          confidence: 'high',
          target: paths.defaultKnowledgePath,
          proposed_text: 'Project convention: apply retrospective actions.',
          rationale: 'Future applies should use retrospective actions.'
        }
      }, {
        id: 'finding_code',
        category: 'code',
        severity: 'low',
        evidence: ['evt_2'],
        diagnosis: 'A test failed.',
        recommendation: 'Fix later.',
        action: { type: 'improve_code', confidence: 'low' }
      }]
    }
  }));
  await fs.writeFile(paths.approvalPath, JSON.stringify({
    approved_at: new Date().toISOString(),
    approved_suggestion_ids: ['finding_knowledge'],
    approval_text: 'yes, apply finding_knowledge'
  }));

  const result = await applyApprovedUpdate({ root, sessionId: 'sess_apply_retro' });
  const knowledge = await fs.readFile(paths.defaultKnowledgePath, 'utf8');

  assert.equal(result.applied.length, 1);
  assert.match(knowledge, /apply retrospective actions/);
});

test('applyApprovedUpdate writes edited approval text instead of original proposed text', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const paths = resolveSessionPaths({ root, sessionId: 'sess_apply_edited_approval' });
  await fs.mkdir(paths.sessionDir, { recursive: true });
  await fs.writeFile(paths.suggestionsPath, JSON.stringify({
    session_id: 'sess_apply_edited_approval',
    suggestions: [
      { id: 'sug_1', target: paths.defaultKnowledgePath, proposed_text: 'Original text must not be written.' }
    ]
  }));
  await fs.writeFile(paths.approvalPath, JSON.stringify({
    approved_at: new Date().toISOString(),
    approved_suggestion_ids: ['sug_1'],
    approval_text: 'yes, apply edited sug_1',
    edited_actions: {
      sug_1: { proposed_text: 'Edited legacy approval text.' }
    }
  }));

  const result = await applyApprovedUpdate({ root, sessionId: 'sess_apply_edited_approval' });
  const knowledge = await fs.readFile(paths.defaultKnowledgePath, 'utf8');

  assert.equal(result.applied.length, 1);
  assert.match(knowledge, /Edited legacy approval text/);
  assert.equal(knowledge.includes('Original text must not be written'), false);
});

test('applyApprovedUpdate rejects blank edited approval text without falling back', async () => {
  const { root, paths } = await writeApprovedUpdateFixture({
    sessionId: 'sess_apply_blank_edited',
    approvedSuggestionIds: ['sug_1'],
    approvalExtra: {
      edited_actions: {
        sug_1: { proposed_text: '   ' }
      }
    }
  });

  await assert.rejects(
    applyApprovedUpdate({ root, sessionId: 'sess_apply_blank_edited' }),
    /approved suggestion must include id, safe target, and proposed_text/
  );
  await assert.rejects(fs.stat(paths.defaultKnowledgePath), { code: 'ENOENT' });
});

test('applyApprovedUpdate prefers retrospective findings over legacy suggestions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const paths = resolveSessionPaths({ root, sessionId: 'sess_apply_precedence' });
  await fs.mkdir(paths.sessionDir, { recursive: true });
  await fs.writeFile(paths.retrospectivePath, JSON.stringify({
    session_id: 'sess_apply_precedence',
    summary: 'Found one action.',
    retrospective: {
      outcome: 'completed',
      quality: 'minor_issues',
      findings: [{
        id: 'finding_knowledge',
        category: 'knowledge',
        severity: 'medium',
        evidence: ['evt_1'],
        diagnosis: 'Reusable convention.',
        recommendation: 'Save it.',
        action: {
          type: 'update_knowledge',
          confidence: 'high',
          target: paths.defaultKnowledgePath,
          proposed_text: 'Project convention: use retrospective first.',
          rationale: 'Retrospective is authoritative.'
        }
      }]
    }
  }));
  await fs.writeFile(paths.suggestionsPath, JSON.stringify({
    session_id: 'sess_apply_precedence',
    suggestions: [
      { id: 'sug_legacy', target: paths.defaultKnowledgePath, proposed_text: 'Do not apply legacy.' }
    ]
  }));
  await fs.writeFile(paths.approvalPath, JSON.stringify({
    approved_at: new Date().toISOString(),
    approved_suggestion_ids: ['finding_knowledge'],
    approval_text: 'yes, apply finding_knowledge'
  }));

  const result = await applyApprovedUpdate({ root, sessionId: 'sess_apply_precedence' });
  const knowledge = await fs.readFile(paths.defaultKnowledgePath, 'utf8');

  assert.equal(result.applied.length, 1);
  assert.match(knowledge, /Project convention: use retrospective first/);
  assert.equal(knowledge.includes('Do not apply legacy'), false);
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

test('applyApprovedUpdate rejects relative targets outside root without writing', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-parent-'));
  const root = path.join(parent, 'root');
  const outsidePath = path.join(parent, 'outside.md');
  const paths = resolveSessionPaths({ root, sessionId: 'sess_apply_relative_escape' });
  await fs.mkdir(paths.sessionDir, { recursive: true });
  await fs.writeFile(paths.suggestionsPath, JSON.stringify({
    session_id: 'sess_apply_relative_escape',
    suggestions: [
      { id: 'sug_1', target: '../outside.md', proposed_text: 'Do not write outside root.' }
    ]
  }));
  await fs.writeFile(paths.approvalPath, JSON.stringify({
    approved_at: new Date().toISOString(),
    approved_suggestion_ids: ['sug_1'],
    approval_text: 'yes, apply sug_1'
  }));

  await assert.rejects(
    applyApprovedUpdate({ root, sessionId: 'sess_apply_relative_escape' }),
    /target must stay inside root/
  );
  await assert.rejects(fs.stat(outsidePath), { code: 'ENOENT' });
});

test('applyApprovedUpdate rejects absolute targets outside root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const outsidePath = path.join(path.dirname(root), `outside-${path.basename(root)}.md`);
  const paths = resolveSessionPaths({ root, sessionId: 'sess_apply_absolute_escape' });
  await fs.mkdir(paths.sessionDir, { recursive: true });
  await fs.rm(outsidePath, { force: true });
  await fs.writeFile(paths.suggestionsPath, JSON.stringify({
    session_id: 'sess_apply_absolute_escape',
    suggestions: [
      { id: 'sug_1', target: outsidePath, proposed_text: 'Do not write outside root.' }
    ]
  }));
  await fs.writeFile(paths.approvalPath, JSON.stringify({
    approved_at: new Date().toISOString(),
    approved_suggestion_ids: ['sug_1'],
    approval_text: 'yes, apply sug_1'
  }));

  await assert.rejects(
    applyApprovedUpdate({ root, sessionId: 'sess_apply_absolute_escape' }),
    /target must stay inside root/
  );
  await assert.rejects(fs.stat(outsidePath), { code: 'ENOENT' });
});

test('applyApprovedUpdate validates all approved suggestions before writing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const paths = resolveSessionPaths({ root, sessionId: 'sess_apply_no_partial' });
  await fs.mkdir(paths.sessionDir, { recursive: true });
  await fs.writeFile(paths.suggestionsPath, JSON.stringify({
    session_id: 'sess_apply_no_partial',
    suggestions: [
      { id: 'sug_1', target: paths.defaultKnowledgePath, proposed_text: 'Do not write before validation completes.' },
      { id: 'sug_2', target: paths.defaultKnowledgePath }
    ]
  }));
  await fs.writeFile(paths.approvalPath, JSON.stringify({
    approved_at: new Date().toISOString(),
    approved_suggestion_ids: ['sug_1', 'sug_2'],
    approval_text: 'yes, apply sug_1 and sug_2'
  }));

  await assert.rejects(
    applyApprovedUpdate({ root, sessionId: 'sess_apply_no_partial' }),
    /approved suggestion must include id, safe target, and proposed_text/
  );
  await assert.rejects(fs.stat(paths.defaultKnowledgePath), { code: 'ENOENT' });
  await assert.rejects(fs.stat(paths.appliedPatchPath), { code: 'ENOENT' });
});

test('applyApprovedUpdate preflights existing directory targets before any writes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const paths = resolveSessionPaths({ root, sessionId: 'sess_apply_directory_target' });
  const directoryTarget = path.join(root, 'directory-target');
  await fs.mkdir(paths.sessionDir, { recursive: true });
  await fs.mkdir(directoryTarget, { recursive: true });
  await fs.writeFile(paths.suggestionsPath, JSON.stringify({
    session_id: 'sess_apply_directory_target',
    suggestions: [
      { id: 'sug_1', target: paths.defaultKnowledgePath, proposed_text: 'Must not be partially written.' },
      { id: 'sug_2', target: directoryTarget, proposed_text: 'Directory targets are invalid.' }
    ]
  }));
  await fs.writeFile(paths.approvalPath, JSON.stringify({
    approved_at: new Date().toISOString(),
    approved_suggestion_ids: ['sug_1', 'sug_2'],
    approval_text: 'yes, apply both suggestions'
  }));

  await assert.rejects(
    applyApprovedUpdate({ root, sessionId: 'sess_apply_directory_target' }),
    /target must be a file path/
  );
  await assert.rejects(fs.stat(paths.defaultKnowledgePath), { code: 'ENOENT' });
  await assert.rejects(fs.stat(paths.appliedPatchPath), { code: 'ENOENT' });
});

test('applyApprovedUpdate treats a file parent in target path as validation before writes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const paths = resolveSessionPaths({ root, sessionId: 'sess_apply_file_parent' });
  const fileParent = path.join(root, 'notadir');
  await fs.mkdir(paths.sessionDir, { recursive: true });
  await fs.writeFile(fileParent, 'I am a file, not a directory.\n');
  await fs.writeFile(paths.suggestionsPath, JSON.stringify({
    session_id: 'sess_apply_file_parent',
    suggestions: [
      { id: 'sug_1', target: paths.defaultKnowledgePath, proposed_text: 'Must not be partially written.' },
      { id: 'sug_2', target: path.join(fileParent, 'bad.md'), proposed_text: 'Parent file targets are invalid.' }
    ]
  }));
  await fs.writeFile(paths.approvalPath, JSON.stringify({
    approved_at: new Date().toISOString(),
    approved_suggestion_ids: ['sug_1', 'sug_2'],
    approval_text: 'yes, apply both suggestions'
  }));

  await assert.rejects(
    applyApprovedUpdate({ root, sessionId: 'sess_apply_file_parent' }),
    /target must be a file path/
  );
  await assert.rejects(fs.stat(paths.defaultKnowledgePath), { code: 'ENOENT' });
  await assert.rejects(fs.stat(paths.appliedPatchPath), { code: 'ENOENT' });
});

test('applyApprovedUpdate rejects duplicate approval ids', async () => {
  const { root } = await writeApprovedUpdateFixture({
    sessionId: 'sess_apply_duplicate_ids',
    approvedSuggestionIds: ['sug_1', 'sug_1']
  });

  await assert.rejects(
    applyApprovedUpdate({ root, sessionId: 'sess_apply_duplicate_ids' }),
    /approved_suggestion_ids must not contain duplicates/
  );
});

test('applyApprovedUpdate rejects unknown approval ids', async () => {
  const { root } = await writeApprovedUpdateFixture({
    sessionId: 'sess_apply_unknown_ids',
    approvedSuggestionIds: ['sug_404']
  });

  await assert.rejects(
    applyApprovedUpdate({ root, sessionId: 'sess_apply_unknown_ids' }),
    /approved_suggestion_ids must match suggestions/
  );
});

async function writeApprovedUpdateFixture({ sessionId, approvedSuggestionIds, suggestions, approvalExtra }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const paths = resolveSessionPaths({ root, sessionId });
  await fs.mkdir(paths.sessionDir, { recursive: true });
  await fs.writeFile(paths.suggestionsPath, JSON.stringify({
    session_id: sessionId,
    suggestions: suggestions || [
      { id: 'sug_1', target: paths.defaultKnowledgePath, proposed_text: 'Project convention: use node:test.' }
    ]
  }));
  await fs.writeFile(paths.approvalPath, JSON.stringify({
    approved_at: new Date().toISOString(),
    approved_suggestion_ids: approvedSuggestionIds,
    approval_text: 'yes, apply sug_1',
    ...approvalExtra
  }));

  return { root, paths };
}
