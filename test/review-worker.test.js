import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { enqueueJob, readJob } from '../src/service/job-store.js';
import { runOneReviewJob } from '../src/service/review-worker.js';
import { resolveSessionPaths } from '../src/core/session-paths.js';

test('runOneReviewJob completes review artifacts and notifies for knowledge updates', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-worker-'));
  await fs.writeFile(path.join(root, 'AGENTS.md'), 'Existing knowledge.\n');
  await writeConfig(root, {
    service: { host: '127.0.0.1', port: 9988, openBrowserOnKnowledge: true }
  });
  await writeSession(root, 'sess_notify', {
    metadata: { session_id: 'sess_notify', runtime: 'codex', original_prompt: 'Remember the testing convention.' },
    events: [
      event({
        id: 'evt_1',
        sessionId: 'sess_notify',
        summary: 'Project convention: use node:test for service tests.',
        signals: ['project_convention'],
        paths: ['src/service/review-worker.js']
      })
    ]
  });
  await enqueueJob({ root, sessionId: 'sess_notify', runtime: 'codex' });

  let reviewerCall;
  const notifications = [];
  const result = await runOneReviewJob({
    root,
    reviewer: async (input) => {
      reviewerCall = input;
      const target = input.payload.candidates[0].target;
      return {
        raw: '{"ok":true}',
        parsed: {
          summary: 'Found one durable convention.',
          retrospective: {
            outcome: 'completed',
            quality: 'minor_issues',
            findings: [
              finding({
                evidence: ['evt_1'],
                action: {
                  type: 'update_knowledge',
                  confidence: 'high',
                  target,
                  target_reason: 'Candidate selected by router.',
                  proposed_text: 'Project convention: use node:test for service tests.',
                  rationale: 'Future service tests should follow the same runner.'
                }
              })
            ]
          }
        }
      };
    },
    notify: async (payload) => notifications.push(payload)
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(reviewerCall.root, root);
  assert.equal(reviewerCall.runtime, 'codex');
  assert.match(reviewerCall.prompt, /Session Payload/);
  assert.equal(reviewerCall.payload.session.session_id, 'sess_notify');
  assert.equal(reviewerCall.payload.events.length, 1);
  assert.equal(reviewerCall.payload.config.service.port, 9988);
  assert.equal(reviewerCall.payload.candidates[0].event_id, 'evt_1');
  assert.equal(reviewerCall.payload.candidates[0].target, path.join(root, 'AGENTS.md'));
  assert.equal(reviewerCall.payload.candidates[0].relative_target, 'AGENTS.md');
  assert.equal(reviewerCall.payload.candidates[0].target_exists, true);
  assert.match(reviewerCall.payload.candidates[0].target_preview, /Existing knowledge/);

  const paths = resolveSessionPaths({ root, sessionId: 'sess_notify' });
  const retrospective = JSON.parse(await fs.readFile(paths.retrospectivePath, 'utf8'));
  assert.equal(retrospective.session_id, 'sess_notify');
  assert.equal(retrospective.retrospective.findings[0].action.type, 'update_knowledge');
  assert.match(await fs.readFile(paths.retrospectiveMarkdownPath, 'utf8'), /Session Retrospective/);
  assert.match(await fs.readFile(paths.reviewerLogPath, 'utf8'), /Found one durable convention/);

  const job = await readJob({ root, jobId: 'job_sess_notify' });
  assert.equal(job.status, 'succeeded');
  assert.equal(job.lease_token, '');
  assert.deepEqual(notifications, [{
    root,
    host: '127.0.0.1',
    port: 9988,
    sessionId: 'sess_notify',
    openBrowser: true
  }]);
});

test('runOneReviewJob fails reviewer errors without rules fallback or notification', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-worker-'));
  await writeSession(root, 'sess_fail', {
    events: [event({ id: 'evt_fail', sessionId: 'sess_fail' })]
  });
  await enqueueJob({ root, sessionId: 'sess_fail', runtime: 'claude' });
  const notifications = [];

  const result = await runOneReviewJob({
    root,
    reviewer: async () => {
      throw new Error('reviewer exploded');
    },
    notify: async (payload) => notifications.push(payload)
  });

  assert.equal(result.status, 'failed');
  assert.match(result.error, /reviewer exploded/);
  assert.deepEqual(notifications, []);
  const paths = resolveSessionPaths({ root, sessionId: 'sess_fail' });
  assert.match(await fs.readFile(paths.reviewerLogPath, 'utf8'), /reviewer exploded/);
  await assert.rejects(fs.readFile(paths.retrospectivePath, 'utf8'), { code: 'ENOENT' });
  assert.equal((await readJob({ root, jobId: 'job_sess_fail' })).status, 'failed');
});

test('runOneReviewJob returns nothing when there is no queued job', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-worker-'));

  const result = await runOneReviewJob({
    root,
    reviewer: async () => {
      throw new Error('reviewer should not be called');
    }
  });

  assert.deepEqual(result, { status: 'nothing' });
});

test('runOneReviewJob skips empty-event sessions without reviewer call', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-worker-'));
  await writeSession(root, 'sess_empty', { events: [] });
  await enqueueJob({ root, sessionId: 'sess_empty', runtime: 'codex' });

  const result = await runOneReviewJob({
    root,
    reviewer: async () => {
      throw new Error('reviewer should not be called');
    },
    notify: async () => {
      throw new Error('notify should not be called');
    }
  });

  assert.equal(result.status, 'skipped');
  assert.equal((await readJob({ root, jobId: 'job_sess_empty' })).status, 'skipped');
});

async function writeConfig(root, config) {
  await fs.mkdir(path.join(root, '.bypass'), { recursive: true });
  await fs.writeFile(path.join(root, '.bypass', 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

async function writeSession(root, sessionId, { metadata = {}, events = [] }) {
  const paths = resolveSessionPaths({ root, sessionId });
  await fs.mkdir(paths.sessionDir, { recursive: true });
  await fs.writeFile(paths.metadataPath, `${JSON.stringify({
    session_id: sessionId,
    created_at: '2026-06-06T00:00:00.000Z',
    runtime: 'codex',
    working_directory: root,
    original_prompt: 'Review this session.',
    plugin_version: '0.1.0',
    ...metadata
  }, null, 2)}\n`);
  await fs.writeFile(paths.eventsPath, events.map((item) => JSON.stringify(item)).join('\n') + (events.length ? '\n' : ''));
}

function event({ id, sessionId, summary = 'A useful session event.', signals = [], paths = [] }) {
  return {
    id,
    session_id: sessionId,
    timestamp: '2026-06-06T00:00:01.000Z',
    hook_event_name: 'Stop',
    status: 'success',
    summary,
    signals,
    evidence: [summary],
    paths
  };
}

function finding({ evidence, action }) {
  return {
    id: 'finding_1',
    category: 'knowledge',
    severity: 'medium',
    evidence,
    diagnosis: 'A reusable convention appeared in the session.',
    recommendation: 'Save the convention for future sessions.',
    action
  };
}
