import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
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
  const bypassDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-home-'));
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

  const result = await reviewSession({ root, sessionId: 'sess_review', bypassDir });
  assert.equal(result.session_id, 'sess_review');
  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].kind, 'project_convention');
  assert.equal(result.suggestions[0].target.endsWith('.bypass/knowledge.md'), true);
  assert.equal(result.suggestion_report_path, path.join(bypassDir, 'suggestion', 'sess_review.md'));
  const report = await fs.readFile(result.suggestion_report_path, 'utf8');
  assert.match(report, /Project convention: use node:test and avoid runtime dependencies\./);
});

test('reviewSession emits no suggestions without durable signals', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const bypassDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-home-'));
  await collectEvent({ root, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess_empty', prompt: 'hello' } });

  const result = await reviewSession({ root, sessionId: 'sess_empty', bypassDir });
  assert.deepEqual(result.suggestions, []);
  assert.equal(result.suggestion_report_path, undefined);
  await assert.rejects(fs.stat(path.join(bypassDir, 'suggestion', 'sess_empty.md')), { code: 'ENOENT' });
});

test('review-session CLI prints a report for an existing session', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const bypassDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-home-'));
  await collectEvent({ root, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess_cli', prompt: 'hello' } });
  await collectEvent({
    root,
    payload: {
      hook_event_name: 'PostToolUse',
      session_id: 'sess_cli',
      tool_name: 'Bash',
      tool_response: { exit_code: 0, output: 'Project convention: keep report details in markdown.' }
    }
  });

  const result = spawnSync(process.execPath, [reviewCliPath, 'sess_cli'], {
    cwd: root,
    env: { ...process.env, EVO_BYPASS_DIR: bypassDir },
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  const reportPath = path.join(bypassDir, 'suggestion', 'sess_cli.md');
  assert.match(result.stdout, new RegExp(`请阅读 ${escapeRegExp(reportPath)} 文件`));
  const report = await fs.readFile(reportPath, 'utf8');
  assert.match(report, /Project convention: keep report details in markdown\./);
});

test('review-session CLI prints valid Codex stop hook JSON output', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const bypassDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-home-'));
  await collectEvent({ root, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess_codex_cli', prompt: 'hello' } });
  await collectEvent({
    root,
    payload: {
      hook_event_name: 'PostToolUse',
      session_id: 'sess_codex_cli',
      tool_name: 'Bash',
      tool_response: { exit_code: 0, output: 'Project convention: keep hook reports readable.' }
    }
  });

  const result = spawnSync(process.execPath, [reviewCliPath, '--runtime', 'codex'], {
    cwd: root,
    input: JSON.stringify({ session_id: 'sess_codex_cli', cwd: root }),
    env: { ...process.env, EVO_BYPASS_DIR: bypassDir },
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /^\{\n/);
  const output = JSON.parse(result.stdout);
  assert.equal(output.continue, false);
  assert.equal(output.suppressOutput, false);
  const reportPath = path.join(bypassDir, 'suggestion', 'sess_codex_cli.md');
  assert.match(output.systemMessage, new RegExp(`请阅读 ${escapeRegExp(reportPath)} 文件`));
  assert.match(output.systemMessage, /请告知用户/);
  assert.doesNotMatch(output.systemMessage, /Project convention: keep hook reports readable\./);
  const report = await fs.readFile(reportPath, 'utf8');
  assert.match(report, /Project convention: keep hook reports readable\./);
});

test('review-session CLI does not write markdown when there are no suggestions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const bypassDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-home-'));
  await collectEvent({ root, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess_codex_empty', prompt: 'hello' } });

  const result = spawnSync(process.execPath, [reviewCliPath, '--runtime', 'codex'], {
    cwd: root,
    input: JSON.stringify({ session_id: 'sess_codex_empty', cwd: root }),
    env: { ...process.env, EVO_BYPASS_DIR: bypassDir },
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.continue, true);
  assert.equal(output.systemMessage, '本次任务无待更新知识。');
  await assert.rejects(fs.stat(path.join(bypassDir, 'suggestion', 'sess_codex_empty.md')), { code: 'ENOENT' });
});

test('review-session CLI includes viewer URL when configured and suggestions exist', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const bypassDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-home-'));
  const port = await freePort();
  await fs.mkdir(path.join(root, '.bypass'), { recursive: true });
  await fs.writeFile(path.join(root, '.bypass', 'config.json'), `${JSON.stringify({
    viewer: { enabled: true, openMode: 'url', port }
  })}\n`);
  await collectEvent({ root, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess_viewer_url', prompt: 'hello' } });
  await collectEvent({
    root,
    payload: {
      hook_event_name: 'PostToolUse',
      session_id: 'sess_viewer_url',
      tool_name: 'Bash',
      tool_response: { exit_code: 0, output: 'Project convention: open viewer only when useful.' }
    }
  });

  const result = spawnSync(process.execPath, [reviewCliPath, '--runtime', 'codex'], {
    cwd: root,
    input: JSON.stringify({ session_id: 'sess_viewer_url', cwd: root }),
    env: { ...process.env, EVO_BYPASS_DIR: bypassDir, EVO_BYPASS_VIEWER_ONCE: '1' },
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.continue, false);
  assert.match(output.systemMessage, /http:\/\/127\.0\.0\.1:\d+\/sessions\/sess_viewer_url/);
});

test('review-session CLI skips viewer URL when configured but no suggestions exist', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const bypassDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-home-'));
  const port = await freePort();
  await fs.mkdir(path.join(root, '.bypass'), { recursive: true });
  await fs.writeFile(path.join(root, '.bypass', 'config.json'), `${JSON.stringify({
    viewer: { enabled: true, openMode: 'url', port, openOnlyWhenSuggestions: true }
  })}\n`);
  await collectEvent({ root, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess_viewer_empty', prompt: 'hello' } });

  const result = spawnSync(process.execPath, [reviewCliPath, '--runtime', 'codex'], {
    cwd: root,
    input: JSON.stringify({ session_id: 'sess_viewer_empty', cwd: root }),
    env: { ...process.env, EVO_BYPASS_DIR: bypassDir, EVO_BYPASS_VIEWER_ONCE: '1' },
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.continue, true);
  assert.doesNotMatch(output.systemMessage, /\/sessions\/sess_viewer_empty/);
});

test('review-session CLI keeps valid output when viewer startup fails', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const bypassDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-home-'));
  await fs.mkdir(path.join(root, '.bypass'), { recursive: true });
  await fs.writeFile(path.join(root, '.bypass', 'config.json'), `${JSON.stringify({
    viewer: { enabled: true, openMode: 'url', port: 8765 }
  })}\n`);
  await collectEvent({
    root,
    payload: {
      hook_event_name: 'PostToolUse',
      session_id: 'sess_viewer_fail',
      tool_name: 'Bash',
      tool_response: { exit_code: 0, output: 'Project convention: viewer failures are non-blocking.' }
    }
  });

  const result = spawnSync(process.execPath, [reviewCliPath, '--runtime', 'codex'], {
    cwd: root,
    input: JSON.stringify({ session_id: 'sess_viewer_fail', cwd: root }),
    env: {
      ...process.env,
      EVO_BYPASS_DIR: bypassDir,
      EVO_BYPASS_VIEWER_ONCE: '1',
      EVO_BYPASS_VIEWER_SCRIPT: path.join(root, 'missing-viewer.js')
    },
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.continue, false);
  assert.match(output.systemMessage, /无法启动会话查看器/);
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

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
