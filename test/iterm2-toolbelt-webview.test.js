import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const scriptPath = 'scripts/iterm2-toolbelt-webview.py';

test('iTerm2 Toolbelt WebView launcher has default registration settings', async () => {
  const script = await fs.readFile(scriptPath, 'utf8');

  assert.match(script, /^#!\/usr\/bin\/env python3/);
  assert.match(script, /DEFAULT_URL = 'https:\/\/www\.google\.com'/);
  assert.match(script, /DEFAULT_DISPLAY_NAME = 'Agent MD Review'/);
  assert.match(script, /DEFAULT_IDENTIFIER = 'com\.example\.agent-md-review'/);
  assert.match(script, /iterm2\.async_register_web_view_tool/);
  assert.doesNotMatch(script, /iterm2\.Tool/);
  assert.match(script, /reveal_if_already_registered=True/);
});
