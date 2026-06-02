import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveSessionPaths } from '../src/core/session-paths.js';

test('resolveSessionPaths returns stable repository-local artifact paths', () => {
  const root = path.join(process.cwd(), 'fixture-root');
  const paths = resolveSessionPaths({ root, sessionId: 'sess_123' });

  assert.equal(paths.root, root);
  assert.equal(paths.bypassDir, path.join(root, '.bypass'));
  assert.equal(paths.configPath, path.join(root, '.bypass', 'config.json'));
  assert.equal(paths.sessionDir, path.join(root, '.bypass', 'sessions', 'sess_123'));
  assert.equal(paths.metadataPath, path.join(paths.sessionDir, 'metadata.json'));
  assert.equal(paths.eventsPath, path.join(paths.sessionDir, 'events.jsonl'));
  assert.equal(paths.suggestionsPath, path.join(paths.sessionDir, 'suggestions.json'));
  assert.equal(paths.approvalPath, path.join(paths.sessionDir, 'approval.json'));
  assert.equal(paths.appliedPatchPath, path.join(paths.sessionDir, 'applied.patch'));
  assert.equal(paths.reviewerLogPath, path.join(paths.sessionDir, 'reviewer.log'));
  assert.equal(paths.defaultKnowledgePath, path.join(root, 'AGENTS.md'));
});

test('resolveSessionPaths requires a string sessionId', () => {
  assert.throws(() => resolveSessionPaths({}), /sessionId is required/);
  assert.throws(() => resolveSessionPaths({ sessionId: '' }), /sessionId is required/);
  assert.throws(() => resolveSessionPaths({ sessionId: 123 }), /sessionId is required/);
});

test('resolveSessionPaths rejects unsafe sessionId path segments', () => {
  assert.throws(() => resolveSessionPaths({ sessionId: '../outside' }), /sessionId must be a safe path segment/);
  assert.throws(() => resolveSessionPaths({ sessionId: 'a/b' }), /sessionId must be a safe path segment/);
  assert.throws(() => resolveSessionPaths({ sessionId: 'a\\b' }), /sessionId must be a safe path segment/);
  assert.throws(() => resolveSessionPaths({ sessionId: '.' }), /sessionId must be a safe path segment/);
  assert.throws(() => resolveSessionPaths({ sessionId: '..' }), /sessionId must be a safe path segment/);
});
