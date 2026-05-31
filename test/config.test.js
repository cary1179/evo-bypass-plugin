import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readBypassConfig } from '../src/core/config.js';

test('readBypassConfig returns safe defaults when config is missing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-config-'));

  const config = await readBypassConfig({ root });

  assert.equal(config.knowledgeTarget, path.join(root, '.bypass', 'knowledge.md'));
  assert.deepEqual(config.viewer, {
    enabled: false,
    openMode: 'url',
    host: '127.0.0.1',
    port: 8765,
    openOnlyWhenSuggestions: true
  });
  assert.equal(config.configError, undefined);
});

test('readBypassConfig accepts repository-local knowledge and viewer settings', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-config-'));
  await fs.mkdir(path.join(root, '.bypass'), { recursive: true });
  await fs.writeFile(path.join(root, '.bypass', 'config.json'), `${JSON.stringify({
    knowledgeTarget: 'docs/agent-knowledge.md',
    viewer: {
      enabled: true,
      openMode: 'browser',
      host: 'localhost',
      port: 9012,
      openOnlyWhenSuggestions: false
    }
  })}\n`);

  const config = await readBypassConfig({ root });

  assert.equal(config.knowledgeTarget, path.join(root, 'docs', 'agent-knowledge.md'));
  assert.deepEqual(config.viewer, {
    enabled: true,
    openMode: 'browser',
    host: 'localhost',
    port: 9012,
    openOnlyWhenSuggestions: false
  });
});

test('readBypassConfig falls back when config json is malformed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-config-'));
  await fs.mkdir(path.join(root, '.bypass'), { recursive: true });
  await fs.writeFile(path.join(root, '.bypass', 'config.json'), '{bad json');

  const config = await readBypassConfig({ root });

  assert.equal(config.knowledgeTarget, path.join(root, '.bypass', 'knowledge.md'));
  assert.equal(config.viewer.enabled, false);
  assert.match(config.configError.message, /Invalid JSON/);
});

test('readBypassConfig rejects unsafe or invalid config values', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-config-'));
  await fs.mkdir(path.join(root, '.bypass'), { recursive: true });
  await fs.writeFile(path.join(root, '.bypass', 'config.json'), `${JSON.stringify({
    knowledgeTarget: '../outside.md',
    viewer: {
      enabled: 'yes',
      openMode: 'popup',
      host: '',
      port: 70000,
      openOnlyWhenSuggestions: 'no'
    }
  })}\n`);

  const config = await readBypassConfig({ root });

  assert.equal(config.knowledgeTarget, path.join(root, '.bypass', 'knowledge.md'));
  assert.deepEqual(config.viewer, {
    enabled: false,
    openMode: 'url',
    host: '127.0.0.1',
    port: 8765,
    openOnlyWhenSuggestions: true
  });
});
