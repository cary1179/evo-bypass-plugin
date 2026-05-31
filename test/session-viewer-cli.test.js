import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = path.join(repoRoot, 'scripts', 'session-viewer.js');

test('session-viewer CLI starts, verifies health, prints URL, and exits in once mode', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-viewer-cli-'));

  const result = spawnSync(process.execPath, [cliPath, '--root', root, '--port', '0', '--once'], {
    cwd: repoRoot,
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /http:\/\/127\.0\.0\.1:\d+\/sessions/);
  assert.doesNotMatch(result.stderr, /Error|stack|at /);
});
