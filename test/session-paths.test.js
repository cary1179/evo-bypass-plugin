import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveSessionPaths } from '../src/core/session-paths.js';

test('resolveSessionPaths returns stable repository-local artifact paths', () => {
  const root = path.join(process.cwd(), 'fixture-root');
  const paths = resolveSessionPaths({ root, sessionId: 'sess_123' });

  assert.equal(paths.root, root);
  assert.equal(paths.bypassDir, path.join(root, '.bypass'));
  assert.equal(paths.sessionDir, path.join(root, '.bypass', 'sessions', 'sess_123'));
  assert.equal(paths.metadataPath, path.join(paths.sessionDir, 'metadata.json'));
  assert.equal(paths.eventsPath, path.join(paths.sessionDir, 'events.jsonl'));
  assert.equal(paths.suggestionsPath, path.join(paths.sessionDir, 'suggestions.json'));
  assert.equal(paths.approvalPath, path.join(paths.sessionDir, 'approval.json'));
  assert.equal(paths.appliedPatchPath, path.join(paths.sessionDir, 'applied.patch'));
  assert.equal(paths.defaultKnowledgePath, path.join(root, '.bypass', 'knowledge.md'));
});
