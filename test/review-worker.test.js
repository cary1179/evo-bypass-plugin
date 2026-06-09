import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveServicePaths } from '../src/core/service-paths.js';
import { enqueueJob, readJob } from '../src/service/job-store.js';
import { runOneReviewJob } from '../src/service/review-worker.js';
import { resolveSessionPaths } from '../src/core/session-paths.js';

test('runOneReviewJob completes review artifacts without immediate browser notification', async () => {
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
  assert.equal(reviewerCall.timeoutMs, 120000);
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
  assert.deepEqual(notifications, []);
});

test('runOneReviewJob uses job session id when reviewer returns a conflicting session id', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-worker-'));
  await writeSession(root, 'sess_claimed', {
    events: [event({ id: 'evt_claimed', sessionId: 'sess_claimed' })]
  });
  await enqueueJob({ root, sessionId: 'sess_claimed', runtime: 'codex' });

  const result = await runOneReviewJob({
    root,
    reviewer: async () => ({
      raw: '{"session_id":"wrong"}',
      parsed: {
        session_id: 'sess_wrong',
        sessionId: 'sess_wrong_camel',
        summary: 'No action needed.',
        retrospective: { outcome: 'completed', quality: 'smooth', findings: [] }
      }
    })
  });

  assert.equal(result.status, 'succeeded');
  const paths = resolveSessionPaths({ root, sessionId: 'sess_claimed' });
  const retrospective = JSON.parse(await fs.readFile(paths.retrospectivePath, 'utf8'));
  assert.equal(retrospective.session_id, 'sess_claimed');
  await assert.rejects(
    fs.readFile(resolveSessionPaths({ root, sessionId: 'sess_wrong' }).retrospectivePath, 'utf8'),
    { code: 'ENOENT' }
  );
});

test('runOneReviewJob uses rules fallback when reviewer result shape is malformed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-worker-'));
  await fs.writeFile(path.join(root, 'AGENTS.md'), 'Existing knowledge.\n');
  await writeSession(root, 'sess_malformed_fallback', {
    events: [
      event({
        id: 'evt_malformed',
        sessionId: 'sess_malformed_fallback',
        summary: 'Project convention: recover async review jobs with rules fallback.',
        signals: ['project_convention'],
        paths: ['src/service/review-worker.js']
      })
    ]
  });
  await enqueueJob({ root, sessionId: 'sess_malformed_fallback', runtime: 'codex' });

  const notifications = [];
  const result = await runOneReviewJob({
    root,
    reviewer: async () => ({
      raw: '{"retrospective":{"findings":"bad"}}',
      parsed: {
        summary: 'Malformed reviewer result.',
        retrospective: { findings: 'bad' }
      }
    }),
    notify: async (payload) => notifications.push(payload)
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.result.retrospective.findings.length, 1);
  assert.equal(result.result.retrospective.findings[0].action.type, 'update_knowledge');
  assert.equal(
    result.result.retrospective.findings[0].action.proposed_text,
    'Project convention: recover async review jobs with rules fallback.'
  );
  assert.deepEqual(notifications, []);

  const paths = resolveSessionPaths({ root, sessionId: 'sess_malformed_fallback' });
  assert.match(await fs.readFile(paths.reviewerLogPath, 'utf8'), /Rules fallback reason:/);
  assert.equal((await readJob({ root, jobId: 'job_sess_malformed_fallback' })).status, 'succeeded');
});

test('runOneReviewJob uses rules fallback when reviewer CLI fails', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-worker-'));
  await fs.writeFile(path.join(root, 'AGENTS.md'), 'Existing knowledge.\n');
  await writeSession(root, 'sess_cli_fallback', {
    events: [
      event({
        id: 'evt_cli_fallback',
        sessionId: 'sess_cli_fallback',
        summary: 'Project convention: recover failed reviewer CLI jobs with rules fallback.',
        signals: ['project_convention'],
        paths: ['src/service/review-worker.js']
      })
    ]
  });
  await enqueueJob({ root, sessionId: 'sess_cli_fallback', runtime: 'codex' });

  const result = await runOneReviewJob({
    root,
    reviewer: async () => {
      throw new Error('Reviewer CLI timed out after 180000ms');
    }
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.result.retrospective.findings.length, 1);
  assert.equal(result.result.retrospective.findings[0].action.type, 'update_knowledge');
  assert.equal(
    result.result.retrospective.findings[0].action.proposed_text,
    'Project convention: recover failed reviewer CLI jobs with rules fallback.'
  );

  const paths = resolveSessionPaths({ root, sessionId: 'sess_cli_fallback' });
  assert.match(await fs.readFile(paths.reviewerLogPath, 'utf8'), /Rules fallback reason: Reviewer CLI timed out/);
  assert.equal((await readJob({ root, jobId: 'job_sess_cli_fallback' })).status, 'succeeded');
});

test('runOneReviewJob does not notify even when running service url differs from config', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-worker-'));
  await fs.writeFile(path.join(root, 'AGENTS.md'), 'Existing knowledge.\n');
  await writeConfig(root, {
    service: { host: '127.0.0.1', port: 1111, openBrowserOnKnowledge: true }
  });
  const servicePaths = resolveServicePaths({ root });
  await fs.mkdir(servicePaths.serviceDir, { recursive: true });
  await fs.writeFile(servicePaths.serviceUrlPath, 'http://127.0.0.1:2222\n');
  await writeSession(root, 'sess_live_url', {
    events: [event({ id: 'evt_live_url', sessionId: 'sess_live_url', signals: ['project_convention'] })]
  });
  await enqueueJob({ root, sessionId: 'sess_live_url', runtime: 'codex' });
  const notifications = [];

  await runOneReviewJob({
    root,
    reviewer: knowledgeReviewer('evt_live_url'),
    notify: async (payload) => notifications.push(payload)
  });

  assert.deepEqual(notifications, []);
});

test('runOneReviewJob keeps valid events when JSONL contains malformed lines', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-worker-'));
  await fs.writeFile(path.join(root, 'AGENTS.md'), 'Existing knowledge.\n');
  const paths = await writeSession(root, 'sess_malformed', {
    events: [event({ id: 'evt_valid', sessionId: 'sess_malformed', signals: ['project_convention'] })]
  });
  await fs.appendFile(paths.eventsPath, '{bad json\n');
  await enqueueJob({ root, sessionId: 'sess_malformed', runtime: 'codex' });

  const result = await runOneReviewJob({
    root,
    reviewer: knowledgeReviewer('evt_valid')
  });

  assert.equal(result.status, 'succeeded');
  assert.match(await fs.readFile(paths.reviewerLogPath, 'utf8'), /Malformed event line count: 1/);
});

test('runOneReviewJob omits symlink candidates outside root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-worker-'));
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-outside-'));
  const outsideTarget = path.join(outsideDir, 'AGENTS.md');
  await fs.writeFile(outsideTarget, 'SECRET OUTSIDE KNOWLEDGE\n');
  await fs.symlink(outsideTarget, path.join(root, 'AGENTS.md'));
  await writeSession(root, 'sess_symlink', {
    events: [event({ id: 'evt_symlink', sessionId: 'sess_symlink' })]
  });
  await enqueueJob({ root, sessionId: 'sess_symlink', runtime: 'codex' });
  let candidates;

  await runOneReviewJob({
    root,
    reviewer: async ({ payload }) => {
      candidates = payload.candidates;
      return {
        raw: '{}',
        parsed: {
          summary: 'No action needed.',
          retrospective: { outcome: 'completed', quality: 'smooth', findings: [] }
        }
      };
    }
  });

  assert.deepEqual(candidates, []);
});

test('runOneReviewJob rejects update_knowledge for outside symlink targets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-worker-'));
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-outside-'));
  const outsideTarget = path.join(outsideDir, 'AGENTS.md');
  await fs.writeFile(outsideTarget, 'SECRET OUTSIDE KNOWLEDGE\n');
  await fs.symlink(outsideTarget, path.join(root, 'AGENTS.md'));
  await writeSession(root, 'sess_symlink_update', {
    events: [event({ id: 'evt_symlink_update', sessionId: 'sess_symlink_update' })]
  });
  await enqueueJob({ root, sessionId: 'sess_symlink_update', runtime: 'codex' });

  const result = await runOneReviewJob({
    root,
    reviewer: async () => ({
      raw: '{}',
      parsed: {
        summary: 'Unsafe update target.',
        retrospective: {
          outcome: 'completed',
          quality: 'minor_issues',
          findings: [
            finding({
              evidence: ['evt_symlink_update'],
              action: {
                type: 'update_knowledge',
                confidence: 'high',
                target: path.join(root, 'AGENTS.md'),
                proposed_text: 'Project convention: do not leak symlink targets.'
              }
            })
          ]
        }
      }
    })
  });

  assert.equal(result.status, 'failed');
  assert.match(result.error, /update_knowledge target must match a candidate/);
  const paths = resolveSessionPaths({ root, sessionId: 'sess_symlink_update' });
  await assert.rejects(fs.readFile(paths.retrospectivePath, 'utf8'), { code: 'ENOENT' });
});

test('runOneReviewJob keeps missing in-root scoped AGENTS.md candidates updateable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-worker-'));
  await fs.mkdir(path.join(root, 'pkg'));
  await writeSession(root, 'sess_missing_in_root', {
    events: [
      event({
        id: 'evt_missing_in_root',
        sessionId: 'sess_missing_in_root',
        paths: ['pkg/file.js'],
        signals: ['project_convention']
      })
    ]
  });
  await enqueueJob({ root, sessionId: 'sess_missing_in_root', runtime: 'codex' });
  let candidate;

  const result = await runOneReviewJob({
    root,
    reviewer: async ({ payload }) => {
      candidate = payload.candidates[0];
      return {
        raw: '{}',
        parsed: {
          summary: 'Found scoped convention.',
          retrospective: {
            outcome: 'completed',
            quality: 'minor_issues',
            findings: [
              finding({
                evidence: ['evt_missing_in_root'],
                action: {
                  type: 'update_knowledge',
                  confidence: 'high',
                  target: candidate.target,
                  proposed_text: 'Project convention: keep scoped knowledge local.'
                }
              })
            ]
          }
        }
      };
    }
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(candidate.target, path.join(root, 'pkg', 'AGENTS.md'));
  assert.equal(candidate.relative_target, path.join('pkg', 'AGENTS.md'));
  assert.equal(candidate.target_exists, false);
  const paths = resolveSessionPaths({ root, sessionId: 'sess_missing_in_root' });
  const retrospective = JSON.parse(await fs.readFile(paths.retrospectivePath, 'utf8'));
  assert.equal(retrospective.retrospective.findings[0].action.target, path.join(root, 'pkg', 'AGENTS.md'));
});

test('runOneReviewJob omits missing AGENTS.md under symlinked outside directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-worker-'));
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-outside-'));
  await fs.symlink(outsideDir, path.join(root, 'linked'));
  const unsafeTarget = path.join(root, 'linked', 'AGENTS.md');
  await writeSession(root, 'sess_missing_symlink_parent', {
    events: [
      event({
        id: 'evt_missing_symlink_parent',
        sessionId: 'sess_missing_symlink_parent',
        paths: ['linked/file.js'],
        signals: ['project_convention']
      })
    ]
  });
  await enqueueJob({ root, sessionId: 'sess_missing_symlink_parent', runtime: 'codex' });
  let candidates;

  const result = await runOneReviewJob({
    root,
    reviewer: async ({ payload }) => {
      candidates = payload.candidates;
      return {
        raw: '{}',
        parsed: {
          summary: 'Unsafe scoped target.',
          retrospective: {
            outcome: 'completed',
            quality: 'minor_issues',
            findings: [
              finding({
                evidence: ['evt_missing_symlink_parent'],
                action: {
                  type: 'update_knowledge',
                  confidence: 'high',
                  target: unsafeTarget,
                  proposed_text: 'Project convention: do not write through symlink parents.'
                }
              })
            ]
          }
        }
      };
    }
  });

  assert.deepEqual(candidates, []);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /update_knowledge target must match a candidate/);
  const paths = resolveSessionPaths({ root, sessionId: 'sess_missing_symlink_parent' });
  await assert.rejects(fs.readFile(paths.retrospectivePath, 'utf8'), { code: 'ENOENT' });
});

test('runOneReviewJob does not write retrospective artifacts after losing its lease', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-worker-'));
  await writeSession(root, 'sess_stale', {
    events: [event({ id: 'evt_stale', sessionId: 'sess_stale' })]
  });
  await enqueueJob({ root, sessionId: 'sess_stale', runtime: 'codex' });
  const servicePaths = resolveServicePaths({ root });

  const result = await runOneReviewJob({
    root,
    reviewer: async () => {
      const jobPath = path.join(servicePaths.jobsDir, 'job_sess_stale.json');
      const job = JSON.parse(await fs.readFile(jobPath, 'utf8'));
      await fs.writeFile(jobPath, `${JSON.stringify({
        ...job,
        lease_token: 'new-owner-token',
        lease_expires_at: new Date(Date.now() + 60000).toISOString()
      }, null, 2)}\n`);
      return {
        raw: '{}',
        parsed: {
          summary: 'No action needed.',
          retrospective: { outcome: 'completed', quality: 'smooth', findings: [] }
        }
      };
    }
  });

  assert.equal(result.status, 'failed');
  assert.match(result.error, /stale job lease/);
  const paths = resolveSessionPaths({ root, sessionId: 'sess_stale' });
  await assert.rejects(fs.readFile(paths.retrospectivePath, 'utf8'), { code: 'ENOENT' });
  await assert.rejects(fs.readFile(paths.retrospectiveMarkdownPath, 'utf8'), { code: 'ENOENT' });
});

test('runOneReviewJob fails reviewer errors without rules fallback or notification', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-worker-'));
  await writeConfig(root, { reviewer: { mode: 'ai', fallback: 'none' } });
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

test('runOneReviewJob marks failed when reviewer.log cannot be written', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-worker-'));
  await writeConfig(root, { reviewer: { mode: 'ai', fallback: 'none' } });
  const paths = await writeSession(root, 'sess_unwritable_log', {
    events: [event({ id: 'evt_unwritable_log', sessionId: 'sess_unwritable_log' })]
  });
  await fs.rm(paths.reviewerLogPath, { force: true, recursive: true });
  await fs.mkdir(paths.reviewerLogPath);
  await enqueueJob({ root, sessionId: 'sess_unwritable_log', runtime: 'codex' });

  const result = await runOneReviewJob({
    root,
    reviewer: async () => {
      throw new Error('reviewer exploded before log');
    }
  });

  assert.equal(result.status, 'failed');
  assert.match(result.error, /reviewer exploded before log/);
  const job = await readJob({ root, jobId: 'job_sess_unwritable_log' });
  assert.equal(job.status, 'failed');
  assert.equal(job.lease_token, '');
});

test('runOneReviewJob does not write failure artifacts after losing its lease', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-worker-'));
  await writeConfig(root, { reviewer: { mode: 'ai', fallback: 'none' } });
  await writeSession(root, 'sess_stale_failure', {
    events: [event({ id: 'evt_stale_failure', sessionId: 'sess_stale_failure' })]
  });
  await enqueueJob({ root, sessionId: 'sess_stale_failure', runtime: 'codex' });
  const servicePaths = resolveServicePaths({ root });

  const result = await runOneReviewJob({
    root,
    reviewer: async () => {
      const jobPath = path.join(servicePaths.jobsDir, 'job_sess_stale_failure.json');
      const job = JSON.parse(await fs.readFile(jobPath, 'utf8'));
      await fs.writeFile(jobPath, `${JSON.stringify({
        ...job,
        lease_token: 'new-owner-token',
        lease_expires_at: new Date(Date.now() + 60000).toISOString()
      }, null, 2)}\n`);
      throw new Error('stale reviewer exploded');
    }
  });

  assert.equal(result.status, 'failed');
  assert.match(result.error, /stale reviewer exploded/);
  const paths = resolveSessionPaths({ root, sessionId: 'sess_stale_failure' });
  await assert.rejects(fs.readFile(paths.reviewerLogPath, 'utf8'), { code: 'ENOENT' });
  await assert.rejects(fs.readFile(paths.retrospectivePath, 'utf8'), { code: 'ENOENT' });
  await assert.rejects(fs.readFile(paths.retrospectiveMarkdownPath, 'utf8'), { code: 'ENOENT' });
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

test('runOneReviewJob skips sessions marked skip_review without reviewer call', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-worker-'));
  await writeSession(root, 'sess_skip_review', {
    metadata: { skip_review: true, skip_reason: 'codex_suggestions_prompt' },
    events: [event({ id: 'evt_skip_review', sessionId: 'sess_skip_review' })]
  });
  await enqueueJob({ root, sessionId: 'sess_skip_review', runtime: 'codex' });

  const result = await runOneReviewJob({
    root,
    reviewer: async () => {
      throw new Error('reviewer should not be called');
    }
  });

  assert.equal(result.status, 'skipped');
  const job = await readJob({ root, jobId: 'job_sess_skip_review' });
  assert.equal(job.status, 'skipped');
  assert.equal(job.error, 'codex_suggestions_prompt');
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
  return paths;
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

function knowledgeReviewer(eventId) {
  return async ({ payload }) => ({
    raw: '{}',
    parsed: {
      summary: 'Found one durable convention.',
      retrospective: {
        outcome: 'completed',
        quality: 'minor_issues',
        findings: [
          finding({
            evidence: [eventId],
            action: {
              type: 'update_knowledge',
              confidence: 'high',
              target: payload.candidates[0].target,
              target_reason: payload.candidates[0].target_reason,
              proposed_text: 'Project convention: keep async review tests focused.',
              rationale: 'Future service work should keep tests focused.'
            }
          })
        ]
      }
    }
  });
}
