import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRetrospectiveResult, extractKnowledgeActions } from '../src/core/retrospective-schema.js';

test('normalizeRetrospectiveResult creates a smooth empty retrospective', () => {
  const result = normalizeRetrospectiveResult({ sessionId: 'sess_empty', findings: [] });

  assert.equal(result.session_id, 'sess_empty');
  assert.equal(result.retrospective.outcome, 'completed');
  assert.equal(result.retrospective.quality, 'smooth');
  assert.deepEqual(result.retrospective.findings, []);
  assert.match(result.summary, /No retrospective actions/);
});

test('normalizeRetrospectiveResult keeps valid update_knowledge action fields', () => {
  const result = normalizeRetrospectiveResult({
    sessionId: 'sess_knowledge',
    outcome: 'partial',
    quality: 'minor_issues',
    findings: [{
      id: 'finding_knowledge',
      category: 'knowledge',
      severity: 'medium',
      evidence: ['evt_1'],
      diagnosis: 'A durable convention was observed.',
      recommendation: 'Ask whether to save it.',
      action: {
        type: 'update_knowledge',
        confidence: 'high',
        target: '/tmp/project/AGENTS.md',
        target_reason: 'Repository-level convention.',
        proposed_text: 'Project convention: use node:test.',
        rationale: 'Future tests should follow this.'
      }
    }]
  });

  assert.equal(result.retrospective.findings[0].action.type, 'update_knowledge');
  assert.equal(result.retrospective.findings[0].action.proposed_text, 'Project convention: use node:test.');
  assert.equal(extractKnowledgeActions(result).length, 1);
});

test('normalizeRetrospectiveResult drops invalid findings', () => {
  const result = normalizeRetrospectiveResult({
    sessionId: 'sess_invalid',
    findings: [{
      id: 'finding_bad',
      category: 'unknown',
      severity: 'medium',
      evidence: ['evt_1'],
      diagnosis: 'Bad category.',
      recommendation: 'Drop this.',
      action: { type: 'no_action' }
    }]
  });

  assert.deepEqual(result.retrospective.findings, []);
});
