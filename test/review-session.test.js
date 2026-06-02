import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectEvent } from '../src/collect-event.js';
import { reviewSession } from '../src/review-session.js';
import { resolveSessionPaths } from '../src/core/session-paths.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const reviewCliPath = path.join(repoRoot, 'scripts', 'review-session.js');

test('reviewSession converts convention evidence into update_knowledge finding', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const bypassDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-home-'));
  await collectEvent({ root, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess_retro_knowledge', prompt: 'Use Node only' } });
  await collectEvent({
    root,
    payload: {
      hook_event_name: 'PostToolUse',
      session_id: 'sess_retro_knowledge',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { exit_code: 0, output: 'Project convention: use node:test and avoid runtime dependencies.' }
    }
  });

  const result = await reviewSession({ root, sessionId: 'sess_retro_knowledge', bypassDir });
  const paths = resolveSessionPaths({ root, sessionId: 'sess_retro_knowledge' });
  const finding = result.retrospective.findings[0];
  const legacySuggestions = JSON.parse(await fs.readFile(paths.suggestionsPath, 'utf8'));

  assert.equal(finding.category, 'knowledge');
  assert.equal(finding.action.type, 'update_knowledge');
  assert.equal(finding.action.target, path.join(root, 'AGENTS.md'));
  assert.match(finding.action.target_reason, /root AGENTS\.md/);
  assert.match(finding.action.proposed_text, /use node:test/);
  assert.equal(result.suggestions[0].target, path.join(root, 'AGENTS.md'));
  assert.match(result.suggestions[0].proposed_text, /use node:test/);
  assert.equal(legacySuggestions.suggestions[0].target, path.join(root, 'AGENTS.md'));
  assert.match(legacySuggestions.suggestions[0].proposed_text, /use node:test/);
});

test('reviewSession converts test failure into code retrospective finding', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const bypassDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-home-'));
  await collectEvent({ root, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess_retro_test_failure', prompt: 'fix tests' } });
  await collectEvent({
    root,
    payload: {
      hook_event_name: 'PostToolUse',
      session_id: 'sess_retro_test_failure',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { exit_code: 1, output: 'not ok 1 test failed' }
    }
  });

  const result = await reviewSession({ root, sessionId: 'sess_retro_test_failure', bypassDir });
  const finding = result.retrospective.findings[0];

  assert.equal(finding.category, 'code');
  assert.equal(finding.action.type, 'improve_code');
  assert.match(finding.diagnosis, /test failure/i);
});

test('reviewSession writes a smooth retrospective without durable signals', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const bypassDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-home-'));
  await collectEvent({ root, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess_empty', prompt: 'hello' } });

  const result = await reviewSession({ root, sessionId: 'sess_empty', bypassDir });
  const paths = resolveSessionPaths({ root, sessionId: 'sess_empty' });

  assert.equal(result.session_id, 'sess_empty');
  assert.equal(result.retrospective.quality, 'smooth');
  assert.deepEqual(result.retrospective.findings, []);
  assert.equal(result.retrospective_report_path, path.join(bypassDir, 'retrospective', 'sess_empty.md'));
  assert.match(await fs.readFile(paths.retrospectivePath, 'utf8'), /"quality": "smooth"/);
  assert.match(await fs.readFile(paths.retrospectiveMarkdownPath, 'utf8'), /No significant failures/);
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
  const reportPath = path.join(bypassDir, 'retrospective', 'sess_cli.md');
  assert.match(result.stdout, new RegExp(`请阅读 ${escapeRegExp(reportPath)} 文件`));
  const report = await fs.readFile(reportPath, 'utf8');
  assert.match(report, /Project convention: keep report details in markdown\./);
});

test('review-session CLI resolves Claude session id from stdin payload without env var', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const bypassDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-home-'));
  await collectEvent({ root, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess_claude_stdin', prompt: 'hello' } });
  await collectEvent({
    root,
    payload: {
      hook_event_name: 'PostToolUse',
      session_id: 'sess_claude_stdin',
      tool_name: 'Bash',
      tool_response: { exit_code: 0, output: 'Project convention: resolve Claude stop session from stdin.' }
    }
  });

  const env = { ...process.env, EVO_BYPASS_DIR: bypassDir };
  delete env.CLAUDE_SESSION_ID;
  const result = spawnSync(process.execPath, [reviewCliPath], {
    cwd: root,
    input: JSON.stringify({ session_id: 'sess_claude_stdin', cwd: root, hook_event_name: 'Stop' }),
    env,
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  const reportPath = path.join(bypassDir, 'retrospective', 'sess_claude_stdin.md');
  assert.match(result.stdout, new RegExp(`请阅读 ${escapeRegExp(reportPath)} 文件`));
  const report = await fs.readFile(reportPath, 'utf8');
  assert.match(report, /Project convention: resolve Claude stop session from stdin\./);
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
  const reportPath = path.join(bypassDir, 'retrospective', 'sess_codex_cli.md');
  assert.match(output.systemMessage, new RegExp(`请阅读 ${escapeRegExp(reportPath)} 文件`));
  assert.match(output.systemMessage, /请告知用户/);
  assert.doesNotMatch(output.systemMessage, /Project convention: keep hook reports readable\./);
  const report = await fs.readFile(reportPath, 'utf8');
  assert.match(report, /Project convention: keep hook reports readable\./);
});

test('review-session CLI appends stop hook execution log', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const bypassDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-home-'));
  await collectEvent({ root, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess_stop_log', prompt: 'hello' } });
  await collectEvent({
    root,
    payload: {
      hook_event_name: 'PostToolUse',
      session_id: 'sess_stop_log',
      tool_name: 'Bash',
      tool_response: { exit_code: 0, output: 'Project convention: log stop hook execution.' }
    }
  });

  const result = spawnSync(process.execPath, [reviewCliPath, '--runtime', 'codex'], {
    cwd: root,
    input: JSON.stringify({ session_id: 'sess_stop_log', cwd: root }),
    env: { ...process.env, EVO_BYPASS_DIR: bypassDir },
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  const lines = (await fs.readFile(path.join(root, '.bypass', 'stop-hook.log'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].event, 'stop_hook_start');
  assert.equal(lines[0].runtime, 'codex');
  assert.equal(lines[0].cwd, root);
  assert.equal(lines[0].sessionId, 'sess_stop_log');
  assert.equal(lines[1].event, 'stop_hook_finish');
  assert.equal(lines[1].runtime, 'codex');
  assert.equal(lines[1].cwd, root);
  assert.equal(lines[1].sessionId, 'sess_stop_log');
  assert.equal(lines[1].suggestionCount, 1);
  assert.match(lines[1].reportPath, /sess_stop_log\.md$/);
});

test('review-session CLI prints valid Codex JSON for clean retrospective', async () => {
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
  assert.match(output.systemMessage, /本次任务复盘无待处理动作/);
  assert.match(await fs.readFile(path.join(bypassDir, 'retrospective', 'sess_codex_empty.md'), 'utf8'), /Task Retrospective|Session Retrospective/);
});

test('review-session CLI links retrospective without forcing confirmation for non-knowledge findings', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const bypassDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-home-'));
  await collectEvent({ root, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess_codex_failure', prompt: 'fix tests' } });
  await collectEvent({
    root,
    payload: {
      hook_event_name: 'PostToolUse',
      session_id: 'sess_codex_failure',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { exit_code: 1, output: 'not ok 1 test failed' }
    }
  });

  const result = spawnSync(process.execPath, [reviewCliPath, '--runtime', 'codex'], {
    cwd: root,
    input: JSON.stringify({ session_id: 'sess_codex_failure', cwd: root }),
    env: { ...process.env, EVO_BYPASS_DIR: bypassDir },
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.continue, true);
  assert.match(output.systemMessage, /任务复盘报告/);
  assert.doesNotMatch(output.systemMessage, /是否应用/);
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

  assert.equal(result.retrospective.findings.length, 1);
  assert.equal(result.retrospective.findings[0].action.proposed_text, 'Project convention: keep review notes short.');
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

  assert.equal(result.retrospective.findings[0].action.target, path.join(root, 'AGENTS.md'));
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

  assert.equal(result.retrospective.findings.length, 1);
  assert.equal(result.retrospective.findings[0].action.target, path.join(root, 'AGENTS.md'));
});

test('reviewSession routes path scoped knowledge to nearest directory AGENTS file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  await fs.mkdir(path.join(root, 'src', 'viewer'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'AGENTS.md'), '# src guidance\n');
  await fs.writeFile(path.join(root, 'src', 'viewer', 'AGENTS.md'), '# viewer guidance\n');
  await collectEvent({
    root,
    payload: {
      hook_event_name: 'PostToolUse',
      session_id: 'sess_path_route',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/viewer/server.js' },
      tool_response: { exit_code: 0, output: 'Project convention: keep viewer routes read-only.' }
    }
  });

  const result = await reviewSession({ root, sessionId: 'sess_path_route' });

  assert.equal(result.retrospective.findings.length, 1);
  assert.equal(result.retrospective.findings[0].action.target, path.join(root, 'src', 'viewer', 'AGENTS.md'));
  assert.match(result.retrospective.findings[0].action.target_reason, /nearest existing AGENTS\.md/);
});

test('reviewSession proposes a missing scoped AGENTS file for path specific knowledge', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  await collectEvent({
    root,
    payload: {
      hook_event_name: 'PostToolUse',
      session_id: 'sess_missing_route',
      tool_name: 'Edit',
      tool_input: { file_path: 'packages/api/server.js' },
      tool_response: { exit_code: 0, output: 'Project convention: prefer contract tests for API changes.' }
    }
  });

  const result = await reviewSession({ root, sessionId: 'sess_missing_route' });

  assert.equal(result.retrospective.findings.length, 1);
  assert.equal(result.retrospective.findings[0].action.target, path.join(root, 'packages', 'api', 'AGENTS.md'));
  assert.match(result.retrospective.findings[0].action.target_reason, /missing scoped AGENTS\.md/);
});

test('reviewSession AI reviewer accepts valid retrospective findings', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  await fs.mkdir(path.join(root, '.bypass'), { recursive: true });
  const requests = [];
  const server = await startAiReviewServer(async ({ body }) => {
    requests.push(body);
    return {
      retrospective: {
        outcome: 'completed',
        quality: 'minor_issues',
        findings: [{
          id: 'finding_ai_knowledge',
          category: 'knowledge',
          severity: 'medium',
          evidence: ['evt_ai'],
          diagnosis: 'AI found a reusable convention.',
          recommendation: 'Ask whether to save it.',
          action: {
            type: 'update_knowledge',
            confidence: 'high',
            target: 'AGENTS.md',
            proposed_text: 'Project convention: keep AI review JSON strict.',
            rationale: 'Future reviewer changes need strict schemas.'
          }
        }]
      }
    };
  });

  try {
    await fs.writeFile(path.join(root, '.bypass', 'config.json'), `${JSON.stringify({
      reviewer: {
        mode: 'ai',
        fallback: 'none',
        provider: {
          type: 'openai-compatible',
          baseUrl: server.baseUrl,
          apiKey: 'test-api-key',
          model: 'memory-reviewer'
        }
      }
    })}\n`);
    await writeRawEvent(root, 'sess_ai_review', {
      id: 'evt_ai',
      session_id: 'sess_ai_review',
      timestamp: new Date().toISOString(),
      hook: 'PostToolUse',
      tool: 'Edit',
      summary: 'Edit completed PostToolUse',
      paths: [],
      status: 'success',
      signals: [],
      evidence: ['The API package should prefer contract tests for endpoint behavior.']
    });

    const result = await reviewSession({ root, sessionId: 'sess_ai_review' });
    const finding = result.retrospective.findings[0];

    assert.equal(requests.length, 1);
    assert.equal(result.retrospective.findings.length, 1);
    assert.equal(finding.action.type, 'update_knowledge');
    assert.equal(finding.action.target, path.join(root, 'AGENTS.md'));
  } finally {
    await server.close();
  }
});

test('reviewSession AI reviewer drops findings with unknown evidence ids', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  await fs.mkdir(path.join(root, '.bypass'), { recursive: true });
  const server = await startAiReviewServer(async () => ({
    retrospective: {
      outcome: 'completed',
      quality: 'minor_issues',
      findings: [{
        id: 'finding_missing_evidence',
        category: 'knowledge',
        severity: 'medium',
        evidence: ['evt_missing'],
        diagnosis: 'AI found a reusable convention.',
        recommendation: 'Ask whether to save it.',
        action: {
          type: 'update_knowledge',
          confidence: 'high',
          target: 'AGENTS.md',
          proposed_text: 'Project convention: keep AI review JSON strict.',
          rationale: 'Future reviewer changes need strict schemas.'
        }
      }]
    }
  }));

  try {
    await fs.writeFile(path.join(root, '.bypass', 'config.json'), `${JSON.stringify({
      reviewer: {
        mode: 'ai',
        fallback: 'none',
        provider: {
          type: 'openai-compatible',
          baseUrl: server.baseUrl,
          apiKey: 'test-api-key',
          model: 'memory-reviewer'
        }
      }
    })}\n`);
    await collectEvent({
      root,
      payload: {
        hook_event_name: 'PostToolUse',
        session_id: 'sess_ai_fallback',
        tool_name: 'Bash',
        tool_response: { exit_code: 0, output: 'Project convention: keep AI review fallback deterministic.' }
      }
    });

    const result = await reviewSession({ root, sessionId: 'sess_ai_fallback' });

    assert.deepEqual(result.retrospective.findings, []);
  } finally {
    await server.close();
  }
});

test('reviewSession uses rules fallback when AI retrospective shape is malformed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  await fs.mkdir(path.join(root, '.bypass'), { recursive: true });
  const server = await startAiReviewServer(async () => ({
    retrospective: {
      findings: 'bad'
    }
  }));

  try {
    await fs.writeFile(path.join(root, '.bypass', 'config.json'), `${JSON.stringify({
      reviewer: {
        mode: 'ai',
        fallback: 'rules',
        provider: {
          type: 'openai-compatible',
          baseUrl: server.baseUrl,
          apiKey: 'test-api-key',
          model: 'memory-reviewer'
        }
      }
    })}\n`);
    await collectEvent({
      root,
      payload: {
        hook_event_name: 'PostToolUse',
        session_id: 'sess_ai_malformed_fallback',
        tool_name: 'Bash',
        tool_response: { exit_code: 0, output: 'Project convention: reject malformed AI retrospectives.' }
      }
    });

    const result = await reviewSession({ root, sessionId: 'sess_ai_malformed_fallback' });

    assert.equal(result.retrospective.findings.length, 1);
    assert.equal(result.retrospective.findings[0].action.type, 'update_knowledge');
    assert.equal(result.retrospective.findings[0].action.proposed_text, 'Project convention: reject malformed AI retrospectives.');
  } finally {
    await server.close();
  }
});

test('reviewSession AI reviewer drops update_knowledge findings with unsafe relative targets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  await fs.mkdir(path.join(root, '.bypass'), { recursive: true });
  const server = await startAiReviewServer(async () => ({
    retrospective: {
      outcome: 'completed',
      quality: 'minor_issues',
      findings: [{
        id: 'finding_unsafe_target',
        category: 'knowledge',
        severity: 'medium',
        evidence: ['evt_ai_unsafe_target'],
        diagnosis: 'AI found a reusable convention.',
        recommendation: 'Ask whether to save it.',
        action: {
          type: 'update_knowledge',
          confidence: 'high',
          target: '../outside.md',
          proposed_text: 'Project convention: keep AI targets inside candidates.',
          rationale: 'Future reviewer changes need strict target validation.'
        }
      }]
    }
  }));

  try {
    await writeAiReviewerConfig({ root, server });
    await writeRawEvent(root, 'sess_ai_unsafe_target', {
      id: 'evt_ai_unsafe_target',
      session_id: 'sess_ai_unsafe_target',
      timestamp: new Date().toISOString(),
      hook: 'PostToolUse',
      tool: 'Edit',
      summary: 'Edit completed PostToolUse',
      paths: [],
      status: 'success',
      signals: [],
      evidence: ['Project convention: keep AI targets inside candidates.']
    });

    const result = await reviewSession({ root, sessionId: 'sess_ai_unsafe_target' });

    assert.deepEqual(result.retrospective.findings, []);
  } finally {
    await server.close();
  }
});

test('reviewSession AI reviewer drops absolute in-root targets that are not candidates', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  await fs.mkdir(path.join(root, '.bypass'), { recursive: true });
  const server = await startAiReviewServer(async () => ({
    retrospective: {
      outcome: 'completed',
      quality: 'minor_issues',
      findings: [{
        id: 'finding_non_candidate_target',
        category: 'knowledge',
        severity: 'medium',
        evidence: ['evt_ai_non_candidate_target'],
        diagnosis: 'AI found a reusable convention.',
        recommendation: 'Ask whether to save it.',
        action: {
          type: 'update_knowledge',
          confidence: 'high',
          target: path.join(root, 'NOT_A_CANDIDATE.md'),
          proposed_text: 'Project convention: keep AI targets candidate-bound.',
          rationale: 'Future reviewer changes need strict target validation.'
        }
      }]
    }
  }));

  try {
    await writeAiReviewerConfig({ root, server });
    await writeRawEvent(root, 'sess_ai_non_candidate_target', {
      id: 'evt_ai_non_candidate_target',
      session_id: 'sess_ai_non_candidate_target',
      timestamp: new Date().toISOString(),
      hook: 'PostToolUse',
      tool: 'Edit',
      summary: 'Edit completed PostToolUse',
      paths: [],
      status: 'success',
      signals: [],
      evidence: ['Project convention: keep AI targets candidate-bound.']
    });

    const result = await reviewSession({ root, sessionId: 'sess_ai_non_candidate_target' });

    assert.deepEqual(result.retrospective.findings, []);
  } finally {
    await server.close();
  }
});

test('reviewSession AI reviewer accepts absolute candidate targets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  await fs.mkdir(path.join(root, '.bypass'), { recursive: true });
  const candidateTarget = path.join(root, 'AGENTS.md');
  const server = await startAiReviewServer(async () => ({
    retrospective: {
      outcome: 'completed',
      quality: 'minor_issues',
      findings: [{
        id: 'finding_absolute_candidate_target',
        category: 'knowledge',
        severity: 'medium',
        evidence: ['evt_ai_absolute_candidate_target'],
        diagnosis: 'AI found a reusable convention.',
        recommendation: 'Ask whether to save it.',
        action: {
          type: 'update_knowledge',
          confidence: 'high',
          target: candidateTarget,
          proposed_text: 'Project convention: accept absolute candidate targets.',
          rationale: 'Future reviewer changes need strict target validation.'
        }
      }]
    }
  }));

  try {
    await writeAiReviewerConfig({ root, server });
    await writeRawEvent(root, 'sess_ai_absolute_candidate_target', {
      id: 'evt_ai_absolute_candidate_target',
      session_id: 'sess_ai_absolute_candidate_target',
      timestamp: new Date().toISOString(),
      hook: 'PostToolUse',
      tool: 'Edit',
      summary: 'Edit completed PostToolUse',
      paths: [],
      status: 'success',
      signals: [],
      evidence: ['Project convention: accept absolute candidate targets.']
    });

    const result = await reviewSession({ root, sessionId: 'sess_ai_absolute_candidate_target' });

    assert.equal(result.retrospective.findings.length, 1);
    assert.equal(result.retrospective.findings[0].action.target, candidateTarget);
  } finally {
    await server.close();
  }
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

  assert.deepEqual(result.retrospective.findings, []);
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

  assert.equal(result.retrospective.findings.length, 1);
  assert.equal(result.retrospective.findings[0].action.proposed_text, 'Project convention: use node:test.');
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

async function writeAiReviewerConfig({ root, server }) {
  await fs.writeFile(path.join(root, '.bypass', 'config.json'), `${JSON.stringify({
    reviewer: {
      mode: 'ai',
      fallback: 'none',
      provider: {
        type: 'openai-compatible',
        baseUrl: server.baseUrl,
        apiKey: 'test-api-key',
        model: 'memory-reviewer'
      }
    }
  })}\n`);
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

async function startAiReviewServer(handler) {
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    body.headers = {
      authorization: request.headers.authorization
    };
    const content = await handler({ request, body });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      choices: [
        {
          message: {
            content: typeof content === 'string' ? content : JSON.stringify(content)
          }
        }
      ]
    }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
