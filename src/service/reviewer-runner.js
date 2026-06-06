import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function runReviewerCli({ root, runtime, prompt, env = process.env, timeoutMs = 180000 }) {
  if (runtime === 'codex') {
    return runCodex({ root, prompt, env, timeoutMs });
  }
  if (runtime === 'claude') {
    return runClaude({ root, prompt, env, timeoutMs });
  }
  throw new Error(`unsupported reviewer runtime: ${runtime}`);
}

async function runCodex({ root, prompt, env, timeoutMs }) {
  const outputPath = path.join(os.tmpdir(), `evo-bypass-review-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const command = env.EVO_BYPASS_CODEX_PATH || 'codex';
  const args = [
    'exec',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--ephemeral',
    '--ignore-rules',
    '--output-last-message',
    outputPath,
    '-'
  ];

  await runProcess({ command, args, input: prompt, cwd: root, env, timeoutMs });
  try {
    return parseReviewerOutput(await fs.readFile(outputPath, 'utf8'));
  } finally {
    await fs.rm(outputPath, { force: true });
  }
}

async function runClaude({ root, prompt, env, timeoutMs }) {
  const command = env.EVO_BYPASS_CLAUDE_PATH || 'claude';
  const args = ['-p', '--output-format', 'json'];
  const output = await runProcess({ command, args, input: prompt, cwd: root, env, timeoutMs });
  return parseReviewerOutput(output.stdout);
}

function parseReviewerOutput(text) {
  try {
    return { parsed: JSON.parse(String(text || '').trim()) };
  } catch {
    throw new Error('Reviewer output was not valid JSON');
  }
}

function runProcess({ command, args, input, cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, {
      cwd,
      env: {
        ...env,
        EVO_BYPASS_INTERNAL: '1',
        CLAUDE_CODE_ENTRYPOINT: 'evo-bypass-reviewer'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      finish(reject, new Error(`Reviewer CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      finish(reject, error);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        finish(reject, new Error(`Reviewer CLI exited ${code}: ${stderr.slice(0, 1000)}`));
        return;
      }
      finish(resolve, { stdout, stderr });
    });

    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') {
        finish(reject, error);
      }
    });
    child.stdin.end(input);

    function finish(callback, value) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      callback(value);
    }
  });
}
