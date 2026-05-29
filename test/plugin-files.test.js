import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('plugin manifest and hooks are valid JSON with expected lifecycle hooks', async () => {
  const manifest = JSON.parse(await fs.readFile('.claude-plugin/plugin.json', 'utf8'));
  const claudeHooks = JSON.parse(await fs.readFile('hooks/claude-hooks.json', 'utf8'));
  const codexHooks = JSON.parse(await fs.readFile('hooks/codex-hooks.json', 'utf8'));

  assert.equal(manifest.name, 'evo-bypass');
  assert.equal(manifest.version, '0.1.0');
  assert.ok(claudeHooks.hooks.UserPromptSubmit);
  assert.ok(claudeHooks.hooks.PostToolUse);
  assert.ok(claudeHooks.hooks.Stop);
  assert.ok(codexHooks.hooks.UserPromptSubmit);
  assert.ok(codexHooks.hooks.PostToolUse);
  assert.ok(codexHooks.hooks.Stop);
  assert.ok(codexHooks.hooks.SessionStart);
  assert.match(JSON.stringify(claudeHooks), /collect-event\.js/);
  assert.match(JSON.stringify(codexHooks), /--runtime codex/);
});
