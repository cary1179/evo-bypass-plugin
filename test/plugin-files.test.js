import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const repoRoot = process.cwd();

test('plugin manifest and hooks are valid JSON with expected lifecycle hooks', async () => {
  const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
  const manifest = JSON.parse(await fs.readFile('.claude-plugin/plugin.json', 'utf8'));
  const claudeHooks = JSON.parse(await fs.readFile('hooks/claude-hooks.json', 'utf8'));
  const codexHooks = JSON.parse(await fs.readFile('hooks/codex-hooks.json', 'utf8'));

  assert.equal(pkg.scripts['install:claude'], 'node scripts/install-hooks.js --runtime claude');
  assert.equal(pkg.scripts['install:codex'], 'node scripts/install-hooks.js --runtime codex');
  assert.equal(manifest.name, 'evo-bypass');
  assert.equal(manifest.version, '0.1.0');
  assert.ok(claudeHooks.hooks.UserPromptSubmit);
  assert.ok(claudeHooks.hooks.PostToolUse);
  assert.ok(claudeHooks.hooks.PostToolUseFailure);
  assert.ok(claudeHooks.hooks.Stop);
  assert.ok(codexHooks.hooks.UserPromptSubmit);
  assert.ok(codexHooks.hooks.PostToolUse);
  assert.ok(codexHooks.hooks.Stop);
  assert.ok(codexHooks.hooks.SessionStart);
  assert.match(JSON.stringify(claudeHooks), /\$EVO_BYPASS_HOME\/scripts\//);
  assert.match(JSON.stringify(codexHooks), /\$EVO_BYPASS_HOME\/scripts\//);
  assert.doesNotMatch(JSON.stringify(claudeHooks), /node scripts\//);
  assert.doesNotMatch(JSON.stringify(codexHooks), /node scripts\//);
  assert.doesNotMatch(JSON.stringify(claudeHooks), /CLAUDE_SESSION_ID/);
  assert.match(JSON.stringify(codexHooks), /--runtime codex/);
});

test('retrospective schema is shipped with package files', async () => {
  const schema = JSON.parse(await fs.readFile(path.join(repoRoot, 'schemas', 'retrospective.schema.json'), 'utf8'));

  assert.equal(schema.title, 'Evo Bypass Task Retrospective');
  assert.equal(schema.properties.retrospective.properties.findings.items.properties.action.properties.type.enum.includes('update_knowledge'), true);
  assert.equal(schema.properties.retrospective.properties.findings.items.properties.action.if.properties.type.const, 'update_knowledge');
  assert.equal(schema.properties.retrospective.properties.findings.items.properties.action.then.required.includes('target'), true);
  assert.equal(schema.properties.retrospective.properties.findings.items.properties.action.then.required.includes('proposed_text'), true);
});
