import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateReviewerResult } from '../src/service/reviewer-validation.js';

test('validateReviewerResult accepts update_knowledge with known evidence and candidate target', () => {
  const root = '/tmp/repo';
  const target = path.join(root, 'AGENTS.md');
  const result = validateReviewerResult({
    root,
    parsed: {
      session_id: 'sess_review',
      summary: 'Found convention.',
      retrospective: {
        outcome: 'completed',
        quality: 'minor_issues',
        findings: [{
          id: 'finding_evt_1',
          category: 'knowledge',
          severity: 'medium',
          evidence: ['evt_1'],
          diagnosis: 'Reusable convention.',
          recommendation: 'Save it.',
          action: {
            type: 'update_knowledge',
            confidence: 'high',
            target,
            target_reason: 'Repository root',
            proposed_text: 'Project convention: use node --test.',
            rationale: 'Future test runs should reuse it.'
          }
        }]
      }
    },
    events: [{ id: 'evt_1' }],
    candidates: [{ target }]
  });

  assert.equal(result.session_id, 'sess_review');
  assert.equal(result.retrospective.findings.length, 1);
  assert.equal(result.retrospective.findings[0].action.target, target);
});

test('validateReviewerResult rejects unknown evidence ids', () => {
  assert.throws(() => validateReviewerResult({
    root: '/tmp/repo',
    parsed: {
      session_id: 'sess_review',
      retrospective: {
        outcome: 'completed',
        quality: 'minor_issues',
        findings: [{
          id: 'finding_bad',
          category: 'knowledge',
          severity: 'medium',
          evidence: ['evt_missing'],
          diagnosis: 'No evidence.',
          recommendation: 'No.',
          action: { type: 'no_action', confidence: 'low' }
        }]
      }
    },
    events: [{ id: 'evt_1' }],
    candidates: []
  }), /unknown evidence id/);
});

test('validateReviewerResult rejects update targets outside candidates', () => {
  assert.throws(() => validateReviewerResult({
    root: '/tmp/repo',
    parsed: {
      session_id: 'sess_review',
      retrospective: {
        outcome: 'completed',
        quality: 'minor_issues',
        findings: [{
          id: 'finding_escape',
          category: 'knowledge',
          severity: 'medium',
          evidence: ['evt_1'],
          diagnosis: 'Bad target.',
          recommendation: 'No.',
          action: {
            type: 'update_knowledge',
            confidence: 'high',
            target: '/tmp/outside.md',
            proposed_text: 'Do not write.'
          }
        }]
      }
    },
    events: [{ id: 'evt_1' }],
    candidates: [{ target: '/tmp/repo/AGENTS.md' }]
  }), /target must match a candidate/);
});

test('validateReviewerResult rejects invalid enum values', () => {
  assert.throws(() => validateReviewerResult({
    root: '/tmp/repo',
    parsed: {
      session_id: 'sess_review',
      retrospective: {
        outcome: 'done',
        quality: 'smooth',
        findings: []
      }
    },
    events: [],
    candidates: []
  }), /invalid retrospective outcome/);
});
