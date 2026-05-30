import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { installHooks, mergeHookConfig } from '../scripts/install-hooks.js';

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();

test('mergeHookConfig preserves existing hooks and appends incoming commands once', () => {
  const existing = {
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              command: 'node "/existing/user-prompt.js"',
            },
          ],
        },
      ],
    },
  };
  const incoming = {
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              command: 'node "/repo/scripts/collect-event.js"',
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: 'node "/repo/scripts/review-session.js"',
            },
          ],
        },
      ],
    },
  };

  const once = mergeHookConfig(existing, incoming);
  const twice = mergeHookConfig(once, incoming);

  assert.deepEqual(
    twice.hooks.UserPromptSubmit[0].hooks.map((hook) => hook.command),
    ['node "/existing/user-prompt.js"', 'node "/repo/scripts/collect-event.js"'],
  );
  assert.deepEqual(
    twice.hooks.Stop[0].hooks.map((hook) => hook.command),
    ['node "/repo/scripts/review-session.js"'],
  );
  assert.deepEqual(existing.hooks.UserPromptSubmit[0].hooks, [
    {
      type: 'command',
      command: 'node "/existing/user-prompt.js"',
    },
  ]);
});

test('installHooks uses Codex env target, replaces repo placeholder, and is idempotent', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-codex-hooks-'));
  const targetPath = path.join(tmpDir, 'nested', 'hooks.json');
  const previousTarget = process.env.EVO_BYPASS_CODEX_HOOKS_PATH;
  process.env.EVO_BYPASS_CODEX_HOOKS_PATH = targetPath;
  try {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(
      targetPath,
      `${JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: 'node "/existing/codex-hook.js"',
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );

    await installHooks({ runtime: 'codex', repoRoot });
    await installHooks({ runtime: 'codex', repoRoot });

    const installed = JSON.parse(await fs.readFile(targetPath, 'utf8'));
    const serialized = JSON.stringify(installed);
    const collectCommand = `node "${repoRoot}/scripts/collect-event.js" --runtime codex`;

    assert.match(serialized, new RegExp(escapeRegExp(repoRoot)));
    assert.doesNotMatch(serialized, /\$EVO_BYPASS_HOME/);
    assert.equal(countCommands(installed, collectCommand), 3);
    assert.equal(countCommands(installed, 'node "/existing/codex-hook.js"'), 1);
    assert.equal((await fs.readFile(targetPath, 'utf8')).endsWith('\n'), true);
  } finally {
    restoreEnv('EVO_BYPASS_CODEX_HOOKS_PATH', previousTarget);
  }
});

test('CLI uses Claude env target path and creates missing parent directory', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-claude-hooks-'));
  const targetPath = path.join(tmpDir, 'missing', 'settings.json');

  await execFileAsync(process.execPath, ['scripts/install-hooks.js', '--runtime', 'claude'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      EVO_BYPASS_CLAUDE_HOOKS_PATH: targetPath,
    },
  });

  const installed = JSON.parse(await fs.readFile(targetPath, 'utf8'));
  const serialized = JSON.stringify(installed);

  assert.ok(installed.hooks.Stop);
  assert.match(serialized, new RegExp(escapeRegExp(repoRoot)));
  assert.doesNotMatch(serialized, /\$EVO_BYPASS_HOME/);
});

test('installHooks starts from an empty config when target is missing', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-missing-hooks-'));
  const targetPath = path.join(tmpDir, 'hooks.json');

  await installHooks({ runtime: 'codex', repoRoot, targetPath });

  const installed = JSON.parse(await fs.readFile(targetPath, 'utf8'));
  assert.ok(installed.hooks.SessionStart);
  assert.ok(installed.hooks.UserPromptSubmit);
});

test('installHooks rejects invalid JSON without overwriting the target', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-invalid-hooks-'));
  const targetPath = path.join(tmpDir, 'hooks.json');
  await fs.writeFile(targetPath, '{ invalid json\n');

  await assert.rejects(
    installHooks({ runtime: 'codex', repoRoot, targetPath }),
    /Invalid JSON in existing hook config/,
  );
  assert.equal(await fs.readFile(targetPath, 'utf8'), '{ invalid json\n');
});

function countCommands(config, command) {
  let count = 0;
  for (const groups of Object.values(config.hooks ?? {})) {
    if (!Array.isArray(groups)) {
      continue;
    }
    for (const group of groups) {
      for (const hook of group.hooks ?? []) {
        if (hook.command === command) {
          count += 1;
        }
      }
    }
  }
  return count;
}

function restoreEnv(name, previousValue) {
  if (previousValue === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previousValue;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
