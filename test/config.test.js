import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readBypassConfig, normalizeService, shouldExposeViewer } from '../src/core/config.js';

test('readBypassConfig returns safe defaults when config is missing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-config-'));

  const config = await readBypassConfig({ root });

  assert.equal(config.knowledgeTarget, undefined);
  assert.deepEqual(config.viewer, {
    enabled: false,
    openMode: 'url',
    host: '127.0.0.1',
    port: 8765,
    openOnlyWhenSuggestions: true
  });
  assert.deepEqual(config.reviewer, {
    mode: 'rules',
    fallback: 'rules',
    timeoutMs: 120000,
    provider: undefined
  });
  assert.deepEqual(config.service, {
    enabled: true,
    host: '127.0.0.1',
    port: 8765,
    idleTimeoutMs: 1200000,
    healthTimeoutMs: 250,
    openBrowserOnKnowledge: true
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
    },
    reviewer: {
      mode: 'ai',
      fallback: 'none',
      timeoutMs: 45000,
      provider: {
        type: 'openai-compatible',
        baseUrl: 'https://llm.example.test/v1',
        apiKey: 'test-key',
        model: 'memory-reviewer'
      }
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
  assert.deepEqual(config.reviewer, {
    mode: 'ai',
    fallback: 'none',
    timeoutMs: 45000,
    provider: {
      type: 'openai-compatible',
      baseUrl: 'https://llm.example.test/v1',
      apiKey: 'test-key',
      apiKeyEnv: undefined,
      model: 'memory-reviewer'
    }
  });
});

test('readBypassConfig falls back when config json is malformed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-config-'));
  await fs.mkdir(path.join(root, '.bypass'), { recursive: true });
  await fs.writeFile(path.join(root, '.bypass', 'config.json'), '{bad json');

  const config = await readBypassConfig({ root });

  assert.equal(config.knowledgeTarget, undefined);
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
    },
    reviewer: {
      mode: 'magic',
      fallback: 'later',
      timeoutMs: -1,
      provider: {
        type: 'unknown',
        baseUrl: '',
        apiKey: 123,
        apiKeyEnv: 456,
        model: ''
      }
    }
  })}\n`);

  const config = await readBypassConfig({ root });

  assert.equal(config.knowledgeTarget, undefined);
  assert.deepEqual(config.viewer, {
    enabled: false,
    openMode: 'url',
    host: '127.0.0.1',
    port: 8765,
    openOnlyWhenSuggestions: true
  });
  assert.deepEqual(config.reviewer, {
    mode: 'rules',
    fallback: 'rules',
    timeoutMs: 120000,
    provider: undefined
  });
});

test('shouldExposeViewer supports action count while preserving suggestion count compatibility', () => {
  assert.equal(shouldExposeViewer({
    viewer: { enabled: true, openMode: 'url', openOnlyWhenSuggestions: true },
    suggestionCount: 0,
    actionCount: 1
  }), true);
});

test('readBypassConfig normalizes async review service defaults', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-config-'));
  const config = await readBypassConfig({ root });

  assert.equal(config.service.enabled, true);
  assert.equal(config.service.host, '127.0.0.1');
  assert.equal(config.service.port, 8765);
  assert.equal(config.service.idleTimeoutMs, 1200000);
  assert.equal(config.service.healthTimeoutMs, 250);
  assert.equal(config.service.openBrowserOnKnowledge, true);
});

test('normalizeService accepts valid async review service settings', () => {
  assert.deepEqual(normalizeService({
    enabled: false,
    host: 'localhost',
    port: 9012,
    idleTimeoutMs: 5000,
    healthTimeoutMs: 100,
    openBrowserOnKnowledge: false
  }), {
    enabled: false,
    host: 'localhost',
    port: 9012,
    idleTimeoutMs: 5000,
    healthTimeoutMs: 100,
    openBrowserOnKnowledge: false
  });
});

test('normalizeService rejects invalid async review service settings', () => {
  assert.deepEqual(normalizeService({
    enabled: 'yes',
    host: '',
    port: 70000,
    idleTimeoutMs: 0,
    healthTimeoutMs: -1,
    openBrowserOnKnowledge: 'no'
  }), {
    enabled: true,
    host: '127.0.0.1',
    port: 8765,
    idleTimeoutMs: 1200000,
    healthTimeoutMs: 250,
    openBrowserOnKnowledge: true
  });
});
