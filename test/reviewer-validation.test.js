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

test('validateReviewerResult accepts job-provided session id for async reviewer output', () => {
  const result = validateReviewerResult({
    root: '/tmp/repo',
    sessionId: 'sess_from_job',
    parsed: {
      summary: 'No durable findings.',
      retrospective: {
        outcome: 'completed',
        quality: 'smooth',
        findings: []
      }
    },
    events: [],
    candidates: []
  });

  assert.equal(result.session_id, 'sess_from_job');
  assert.equal(result.summary, 'No durable findings.');
  assert.deepEqual(result.retrospective.findings, []);
});

test('validateReviewerResult rejects missing required top-level fields', () => {
  assert.throws(() => validateReviewerResult({
    root: '/tmp/repo',
    sessionId: 'sess_review',
    parsed: {
      retrospective: { findings: [] }
    },
    events: [],
    candidates: []
  }), /summary is required/);
});

test('validateReviewerResult rejects missing required retrospective enums', () => {
  assert.throws(() => validateReviewerResult({
    root: '/tmp/repo',
    parsed: {
      session_id: 'sess_review',
      summary: 'No durable findings.',
      retrospective: {
        quality: 'smooth',
        findings: []
      }
    },
    events: [],
    candidates: []
  }), /retrospective outcome is required/);

  assert.throws(() => validateReviewerResult({
    root: '/tmp/repo',
    parsed: {
      session_id: 'sess_review',
      summary: 'No durable findings.',
      retrospective: {
        outcome: 'completed',
        findings: []
      }
    },
    events: [],
    candidates: []
  }), /retrospective quality is required/);
});

test('validateReviewerResult rejects missing session id unless supplied by caller', () => {
  assert.throws(() => validateReviewerResult({
    root: '/tmp/repo',
    parsed: {
      summary: 'No durable findings.',
      retrospective: {
        outcome: 'completed',
        quality: 'smooth',
        findings: []
      }
    },
    events: [],
    candidates: []
  }), /sessionId is required/);
});

test('validateReviewerResult rejects unknown evidence ids', () => {
  assert.throws(() => validateReviewerResult({
    root: '/tmp/repo',
    parsed: {
      session_id: 'sess_review',
      summary: 'Malformed reviewer result.',
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
      summary: 'Malformed reviewer result.',
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
      summary: 'Malformed reviewer result.',
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

test('validateReviewerResult rejects findings missing required strings', () => {
  assert.throws(() => validateReviewerResult({
    root: '/tmp/repo',
    parsed: {
      session_id: 'sess_review',
      summary: 'Malformed reviewer result.',
      retrospective: {
        outcome: 'completed',
        quality: 'minor_issues',
        findings: [{
          id: 'finding_missing_diagnosis',
          category: 'knowledge',
          severity: 'medium',
          evidence: ['evt_1'],
          diagnosis: '',
          recommendation: 'Save it.',
          action: { type: 'no_action', confidence: 'low' }
        }]
      }
    },
    events: [{ id: 'evt_1' }],
    candidates: []
  }), /finding diagnosis is required/);
});

test('validateReviewerResult rejects findings missing ids before normalization', () => {
  assert.throws(() => validateReviewerResult({
    root: '/tmp/repo',
    parsed: {
      session_id: 'sess_review',
      summary: 'Malformed reviewer result.',
      retrospective: {
        outcome: 'completed',
        quality: 'minor_issues',
        findings: [{
          category: 'knowledge',
          severity: 'medium',
          evidence: ['evt_1'],
          diagnosis: 'Reusable convention.',
          recommendation: 'Save it.',
          action: { type: 'no_action', confidence: 'low' }
        }]
      }
    },
    events: [{ id: 'evt_1' }],
    candidates: []
  }), /finding id is required/);
});
