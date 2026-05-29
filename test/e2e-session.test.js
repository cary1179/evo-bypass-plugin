import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectEvent } from '../src/collect-event.js';
import { reviewSession } from '../src/review-session.js';
import { applyApprovedUpdate } from '../src/apply-approved-update.js';
import { resolveSessionPaths } from '../src/core/session-paths.js';

test('full bypass flow records, reviews, requires approval, and applies approved update', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const sessionId = 'sess_e2e';
  const paths = resolveSessionPaths({ root, sessionId });

  await collectEvent({ root, payload: { hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: 'Capture project convention' } });
  await collectEvent({
    root,
    payload: {
      hook_event_name: 'PostToolUse',
      session_id: sessionId,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { exit_code: 0, output: 'Project convention: ask before updating local knowledge.' }
    }
  });

  const review = await reviewSession({ root, sessionId });
  assert.equal(review.suggestions.length, 1);

  await assert.rejects(
    applyApprovedUpdate({ root, sessionId }),
    /approval.json is required/
  );

  await fs.writeFile(paths.approvalPath, JSON.stringify({
    approved_at: new Date().toISOString(),
    approved_suggestion_ids: [review.suggestions[0].id],
    approval_text: 'confirmed by user'
  }));

  const apply = await applyApprovedUpdate({ root, sessionId });
  const knowledge = await fs.readFile(paths.defaultKnowledgePath, 'utf8');

  assert.equal(apply.applied.length, 1);
  assert.match(knowledge, /ask before updating local knowledge/);
});
