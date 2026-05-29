import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectEvent } from '../src/collect-event.js';
import { reviewSession } from '../src/review-session.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const reviewCliPath = path.join(repoRoot, 'scripts', 'review-session.js');

test('reviewSession suggests durable knowledge from convention evidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  await collectEvent({ root, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess_review', prompt: 'Use Node only' } });
  await collectEvent({
    root,
    payload: {
      hook_event_name: 'PostToolUse',
      session_id: 'sess_review',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { exit_code: 0, output: 'Project convention: use node:test and avoid runtime dependencies.' }
    }
  });

  const result = await reviewSession({ root, sessionId: 'sess_review' });
  assert.equal(result.session_id, 'sess_review');
  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].kind, 'project_convention');
  assert.equal(result.suggestions[0].target.endsWith('.bypass/knowledge.md'), true);
});

test('reviewSession emits no suggestions without durable signals', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  await collectEvent({ root, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess_empty', prompt: 'hello' } });

  const result = await reviewSession({ root, sessionId: 'sess_empty' });
  assert.deepEqual(result.suggestions, []);
});

test('review-session CLI prints a report for an existing session', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  await collectEvent({ root, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess_cli', prompt: 'hello' } });

  const result = spawnSync(process.execPath, [reviewCliPath, 'sess_cli'], {
    cwd: root,
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Knowledge Update Suggestions/);
});

test('review-session CLI ignores malformed stdin JSON when a session arg is present', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  await collectEvent({ root, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess_bad_stdin', prompt: 'hello' } });

  const result = spawnSync(process.execPath, [reviewCliPath, 'sess_bad_stdin'], {
    cwd: root,
    input: '{bad json',
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stderr, /SyntaxError|stack|at /);
});

test('reviewSession skips malformed JSONL lines and suggests from valid events', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  await collectEvent({ root, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess_malformed', prompt: 'hello' } });
  await appendRawEvent(root, 'sess_malformed', '{bad json');
  await collectEvent({
    root,
    payload: {
      hook_event_name: 'PostToolUse',
      session_id: 'sess_malformed',
      tool_name: 'Bash',
      tool_response: { exit_code: 0, output: 'Project convention: keep review notes short.' }
    }
  });

  const result = await reviewSession({ root, sessionId: 'sess_malformed' });

  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].proposed_text, 'Project convention: keep review notes short.');
});

test('reviewSession falls back when configured knowledge target escapes root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  await fs.mkdir(path.join(root, '.bypass'), { recursive: true });
  await fs.writeFile(path.join(root, '.bypass', 'config.json'), `${JSON.stringify({ knowledgeTarget: '../outside.md' })}\n`);
  await collectEvent({
    root,
    payload: {
      hook_event_name: 'PostToolUse',
      session_id: 'sess_bad_target',
      tool_name: 'Bash',
      tool_response: { exit_code: 0, output: 'Project convention: use repository-local notes.' }
    }
  });

  const result = await reviewSession({ root, sessionId: 'sess_bad_target' });

  assert.equal(result.suggestions[0].target, path.join(root, '.bypass', 'knowledge.md'));
});

test('reviewSession falls back when reviewer config is malformed JSON', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  await fs.mkdir(path.join(root, '.bypass'), { recursive: true });
  await fs.writeFile(path.join(root, '.bypass', 'config.json'), '{bad json');
  await collectEvent({
    root,
    payload: {
      hook_event_name: 'PostToolUse',
      session_id: 'sess_bad_config_json',
      tool_name: 'Bash',
      tool_response: { exit_code: 0, output: 'Project convention: tolerate malformed local config.' }
    }
  });

  const result = await reviewSession({ root, sessionId: 'sess_bad_config_json' });

  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].target.endsWith('.bypass/knowledge.md'), true);
});

test('reviewSession ignores project_convention signals without actionable text', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  await writeRawEvent(root, 'sess_weak_signal', {
    id: 'evt_weak',
    session_id: 'sess_weak_signal',
    timestamp: new Date().toISOString(),
    hook: 'PostToolUse',
    tool: 'Bash',
    summary: 'Bash ran command: npm test',
    paths: [],
    status: 'success',
    signals: ['project_convention'],
    evidence: ['The word convention appeared, but no reusable rule was stated.']
  });

  const result = await reviewSession({ root, sessionId: 'sess_weak_signal' });

  assert.deepEqual(result.suggestions, []);
});

test('reviewSession deduplicates repeated convention suggestions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  await collectEvent({
    root,
    payload: {
      hook_event_name: 'PostToolUse',
      session_id: 'sess_dupes',
      tool_name: 'Bash',
      tool_response: { exit_code: 0, output: 'Project convention: use node:test.' }
    }
  });
  await collectEvent({
    root,
    payload: {
      hook_event_name: 'PostToolUse',
      session_id: 'sess_dupes',
      tool_name: 'Bash',
      tool_response: { exit_code: 0, output: 'Project convention: use node:test.' }
    }
  });

  const result = await reviewSession({ root, sessionId: 'sess_dupes' });

  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].proposed_text, 'Project convention: use node:test.');
});

async function writeRawEvent(root, sessionId, event) {
  const sessionDir = path.join(root, '.bypass', 'sessions', sessionId);
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, 'events.jsonl'), `${JSON.stringify(event)}\n`);
}

async function appendRawEvent(root, sessionId, line) {
  const sessionDir = path.join(root, '.bypass', 'sessions', sessionId);
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.appendFile(path.join(sessionDir, 'events.jsonl'), `${line}\n`);
}
