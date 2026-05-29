import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectEvent } from '../src/collect-event.js';
import { normalizeHookPayload } from '../src/adapters/hook-payload.js';

test('normalizeHookPayload accepts Codex-style hook payloads', () => {
  const normalized = normalizeHookPayload({
    runtime: 'codex',
    hook: 'PostToolUse',
    session_id: 'codex_sess',
    tool_name: 'exec_command',
    input: { cmd: 'npm test' },
    response: { exit_code: 0, stdout: 'ok' },
    cwd: '/tmp/project'
  });

  assert.equal(normalized.runtime, 'codex');
  assert.equal(normalized.hook, 'PostToolUse');
  assert.equal(normalized.sessionId, 'codex_sess');
  assert.equal(normalized.tool, 'exec_command');
  assert.equal(normalized.root, '/tmp/project');
  assert.equal(normalized.command, 'npm test');
});

test('normalizeHookPayload accepts top-level command output and exit code fields', () => {
  const normalized = normalizeHookPayload({
    hook: 'PostToolUse',
    session_id: 'codex_top',
    tool_name: 'exec_command',
    cmd: 'npm test',
    stdout: 'ok',
    exit_code: 0
  });

  assert.equal(normalized.command, 'npm test');
  assert.equal(normalized.output, 'ok');
  assert.equal(normalized.exitCode, 0);
});

test('collectEvent creates metadata on UserPromptSubmit', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const result = await collectEvent({
    root,
    payload: {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'sess_meta',
      prompt: 'Build the plugin'
    }
  });

  const metadata = JSON.parse(await fs.readFile(result.paths.metadataPath, 'utf8'));
  assert.equal(metadata.session_id, 'sess_meta');
  assert.equal(metadata.original_prompt, 'Build the plugin');
  assert.equal(metadata.working_directory, root);
});

test('collectEvent appends redacted PostToolUse events', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  await collectEvent({
    root,
    payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess_events', prompt: 'Run tests' }
  });

  const result = await collectEvent({
    root,
    payload: {
      hook_event_name: 'PostToolUse',
      session_id: 'sess_events',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { exit_code: 1, output: 'API_TOKEN=secretsecretsecretsecretsecretsecret failed' }
    }
  });

  const lines = (await fs.readFile(result.paths.eventsPath, 'utf8')).trim().split('\n');
  const event = JSON.parse(lines.at(-1));
  assert.equal(event.session_id, 'sess_events');
  assert.equal(event.tool, 'Bash');
  assert.equal(event.status, 'failure');
  assert.deepEqual(event.signals, ['test_failure']);
  assert.equal(JSON.stringify(event).includes('secretsecret'), false);
});

test('collectEvent detects top-level command failures', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const result = await collectEvent({
    root,
    payload: {
      hook_event_name: 'PostToolUse',
      session_id: 'sess_top_failure',
      tool_name: 'exec_command',
      cmd: 'npm test',
      stderr: 'test failed',
      exit_code: 1
    }
  });

  const lines = (await fs.readFile(result.paths.eventsPath, 'utf8')).trim().split('\n');
  const event = JSON.parse(lines.at(-1));
  assert.equal(event.status, 'failure');
  assert.deepEqual(event.signals, ['test_failure']);
});
