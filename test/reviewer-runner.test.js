import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runReviewerCli } from '../src/service/reviewer-runner.js';

test('runReviewerCli invokes codex-compatible command with internal guard', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-runner-'));
  const fake = path.join(root, 'fake-codex.js');
  const seen = path.join(root, 'seen.json');
  await fs.writeFile(fake, `#!/usr/bin/env node
import fs from 'node:fs';
const outputIndex = process.argv.indexOf('--output-last-message');
let stdin = '';
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({
    args: process.argv.slice(2),
    entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
    internal: process.env.EVO_BYPASS_INTERNAL,
    stdin
  }));
  fs.writeFileSync(process.argv[outputIndex + 1], JSON.stringify({
    summary: 'ok',
    retrospective: { outcome: 'completed', quality: 'smooth', findings: [] }
  }));
});
`);
  await fs.chmod(fake, 0o755);

  const result = await runReviewerCli({
    root,
    runtime: 'codex',
    prompt: 'review this',
    env: { ...process.env, EVO_BYPASS_CODEX_PATH: fake },
    timeoutMs: 5000
  });

  const logged = JSON.parse(await fs.readFile(seen, 'utf8'));
  assert.equal(result.parsed.retrospective.quality, 'smooth');
  assert.equal(logged.internal, '1');
  assert.equal(logged.entrypoint, 'evo-bypass-reviewer');
  assert.equal(logged.stdin, 'review this');
  assert.deepEqual(logged.args, [
    'exec',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--ephemeral',
    '--ignore-rules',
    '--output-last-message',
    logged.args[7],
    '-'
  ]);
});

test('runReviewerCli invokes claude-compatible command with internal guard', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-runner-'));
  const fake = path.join(root, 'fake-claude.js');
  const seen = path.join(root, 'seen.json');
  await fs.writeFile(fake, `#!/usr/bin/env node
import fs from 'node:fs';
let stdin = '';
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({
    args: process.argv.slice(2),
    entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
    internal: process.env.EVO_BYPASS_INTERNAL,
    stdin
  }));
  console.log(JSON.stringify({
    summary: 'ok',
    retrospective: { outcome: 'completed', quality: 'smooth', findings: [] }
  }));
});
`);
  await fs.chmod(fake, 0o755);

  const result = await runReviewerCli({
    root,
    runtime: 'claude',
    prompt: 'review this',
    env: { ...process.env, EVO_BYPASS_CLAUDE_PATH: fake },
    timeoutMs: 5000
  });

  const logged = JSON.parse(await fs.readFile(seen, 'utf8'));
  assert.equal(result.parsed.retrospective.quality, 'smooth');
  assert.equal(logged.internal, '1');
  assert.equal(logged.entrypoint, 'evo-bypass-reviewer');
  assert.equal(logged.stdin, 'review this');
  assert.deepEqual(logged.args, [
    '-p',
    '--output-format',
    'json',
    '--input-format',
    'text',
    '--bare',
    '--no-session-persistence',
    '--no-chrome',
    '--permission-mode',
    'dontAsk',
    '--tools',
    '',
    '--disallowed-tools',
    'Bash,Edit,MultiEdit,Write,NotebookEdit,WebFetch,WebSearch,Task',
    '--strict-mcp-config',
    '--mcp-config',
    '{}'
  ]);
});

test('runReviewerCli parses Claude result envelopes with JSON model text', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-runner-'));
  const fake = path.join(root, 'fake-claude-envelope.js');
  await fs.writeFile(fake, `#!/usr/bin/env node
console.log(JSON.stringify({
  type: 'result',
  subtype: 'success',
  result: JSON.stringify({
    summary: 'ok',
    retrospective: { outcome: 'completed', quality: 'smooth', findings: [] }
  })
}));
`);
  await fs.chmod(fake, 0o755);

  const result = await runReviewerCli({
    root,
    runtime: 'claude',
    prompt: 'review this',
    env: { ...process.env, EVO_BYPASS_CLAUDE_PATH: fake },
    timeoutMs: 5000
  });

  assert.equal(result.parsed.retrospective.quality, 'smooth');
});

test('runReviewerCli parses Claude content envelopes with JSON text blocks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-runner-'));
  const fake = path.join(root, 'fake-claude-content.js');
  await fs.writeFile(fake, `#!/usr/bin/env node
console.log(JSON.stringify({
  content: [{
    type: 'text',
    text: JSON.stringify({
      summary: 'ok',
      retrospective: { outcome: 'completed', quality: 'smooth', findings: [] }
    })
  }]
}));
`);
  await fs.chmod(fake, 0o755);

  const result = await runReviewerCli({
    root,
    runtime: 'claude',
    prompt: 'review this',
    env: { ...process.env, EVO_BYPASS_CLAUDE_PATH: fake },
    timeoutMs: 5000
  });

  assert.equal(result.parsed.retrospective.quality, 'smooth');
});

test('runReviewerCli fails on non-json output', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-runner-'));
  const fake = path.join(root, 'fake-claude.js');
  await fs.writeFile(fake, `#!/usr/bin/env node
console.log('not json');
`);
  await fs.chmod(fake, 0o755);

  await assert.rejects(
    runReviewerCli({
      root,
      runtime: 'claude',
      prompt: 'review this',
      env: { ...process.env, EVO_BYPASS_CLAUDE_PATH: fake },
      timeoutMs: 5000
    }),
    /Reviewer output was not valid JSON/
  );
});

test('runReviewerCli rejects unsupported runtimes', async () => {
  await assert.rejects(
    runReviewerCli({
      root: process.cwd(),
      runtime: 'openai-compatible',
      prompt: 'review this'
    }),
    /unsupported reviewer runtime/
  );
});
