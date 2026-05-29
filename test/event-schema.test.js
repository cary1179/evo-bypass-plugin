import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../src/core/redact.js';
import { normalizeEvent } from '../src/core/event-schema.js';

test('redactSecrets removes obvious secret values', () => {
  const input = 'TOKEN=abc123456789012345678901234567890 password: hunter2 api_key="sk-live-123"';
  const output = redactSecrets(input);

  assert.equal(output.includes('abc123456789012345678901234567890'), false);
  assert.equal(output.includes('hunter2'), false);
  assert.equal(output.includes('sk-live-123'), false);
  assert.match(output, /\[REDACTED\]/);
});

test('redactSecrets removes JSON-style secret values', () => {
  const output = redactSecrets('{"password": "hunter2", "token": "abc123"}');

  assert.equal(output.includes('hunter2'), false);
  assert.equal(output.includes('abc123'), false);
  assert.match(output, /\[REDACTED\]/);
});

test('normalizeEvent produces stable fields and redacted evidence', () => {
  const event = normalizeEvent({
    sessionId: 'sess_1',
    hook: 'PostToolUse',
    tool: 'Bash',
    summary: 'ran tests',
    paths: ['test/example.test.js'],
    status: 'failure',
    signals: ['test_failure'],
    evidence: ['API_TOKEN=secretsecretsecretsecretsecretsecret failed']
  });

  assert.equal(event.session_id, 'sess_1');
  assert.equal(event.hook, 'PostToolUse');
  assert.equal(event.tool, 'Bash');
  assert.equal(event.status, 'failure');
  assert.deepEqual(event.paths, ['test/example.test.js']);
  assert.deepEqual(event.signals, ['test_failure']);
  assert.equal(event.evidence[0].includes('secretsecret'), false);
  assert.match(event.id, /^evt_/);
  assert.match(event.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test('normalizeEvent normalizes malformed identity fields and object summary', () => {
  const event = normalizeEvent({
    id: { invalid: true },
    sessionId: 'sess_2',
    timestamp: { invalid: true },
    summary: { password: 'hunter2' }
  });

  assert.equal(typeof event.id, 'string');
  assert.match(event.id, /^evt_/);
  assert.equal(typeof event.timestamp, 'string');
  assert.match(event.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof event.summary, 'string');
  assert.equal(event.summary.includes('hunter2'), false);
  assert.match(event.summary, /\[REDACTED\]/);
});
