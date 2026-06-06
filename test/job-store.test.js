import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  claimNextJob,
  completeJob,
  enqueueJob,
  failJob,
  listJobs,
  readJob,
  resetStaleRunningJobs,
  skipJob,
} from '../src/service/job-store.js';

test('enqueueJob writes a stable session job and dedupes duplicates', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-jobs-'));

  const first = await enqueueJob({ root, sessionId: 'sess_enqueue', runtime: 'codex' });
  const second = await enqueueJob({ root, sessionId: 'sess_enqueue', runtime: 'claude' });

  assert.equal(first.id, 'job_sess_enqueue');
  assert.equal(first.session_id, 'sess_enqueue');
  assert.equal(first.runtime, 'codex');
  assert.equal(first.root, root);
  assert.equal(first.status, 'queued');
  assert.equal(first.started_at, '');
  assert.equal(first.finished_at, '');
  assert.equal(first.lease_expires_at, '');
  assert.equal(first.error, '');
  assert.equal(second.id, first.id);
  assert.equal(second.runtime, 'codex');

  const fromDisk = JSON.parse(await fs.readFile(path.join(root, '.bypass', 'jobs', 'job_sess_enqueue.json'), 'utf8'));
  assert.deepEqual(fromDisk, first);
});

test('enqueueJob validates safe session path segments', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-jobs-'));

  await assert.rejects(() => enqueueJob({ root, sessionId: '../outside', runtime: 'codex' }), /sessionId must be a safe path segment/);
  await assert.rejects(() => enqueueJob({ root, sessionId: 'a/b', runtime: 'codex' }), /sessionId must be a safe path segment/);
  await assert.rejects(() => enqueueJob({ root, sessionId: 'a\\b', runtime: 'codex' }), /sessionId must be a safe path segment/);
  await assert.rejects(() => enqueueJob({ root, sessionId: '.', runtime: 'codex' }), /sessionId must be a safe path segment/);
  await assert.rejects(() => enqueueJob({ root, sessionId: '..', runtime: 'codex' }), /sessionId must be a safe path segment/);
});

test('claimNextJob claims the oldest queued job and sets a lease', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-jobs-'));
  const older = await enqueueJob({ root, sessionId: 'sess_old', runtime: 'codex' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await enqueueJob({ root, sessionId: 'sess_new', runtime: 'codex' });

  const before = Date.now();
  const claimed = await claimNextJob({ root, leaseMs: 60000 });
  const after = Date.now();

  assert.equal(claimed.id, older.id);
  assert.equal(claimed.status, 'running');
  assert.ok(Date.parse(claimed.started_at) >= before);
  assert.ok(Date.parse(claimed.started_at) <= after);
  assert.ok(Date.parse(claimed.lease_expires_at) >= before + 60000);
  assert.ok(Date.parse(claimed.lease_expires_at) <= after + 60000);
  assert.equal((await readJob({ root, jobId: older.id })).status, 'running');

  const next = await claimNextJob({ root, leaseMs: 60000 });
  assert.equal(next.id, 'job_sess_new');
  assert.equal(await claimNextJob({ root, leaseMs: 60000 }), undefined);
});

test('completeJob and failJob set terminal status and clear leases', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-jobs-'));
  await enqueueJob({ root, sessionId: 'sess_done', runtime: 'codex' });
  await enqueueJob({ root, sessionId: 'sess_fail', runtime: 'codex' });
  const done = await claimNextJob({ root, leaseMs: 60000 });
  const failed = await claimNextJob({ root, leaseMs: 60000 });

  const completed = await completeJob({ root, jobId: done.id });
  const errored = await failJob({ root, jobId: failed.id, error: 'bad json' });

  assert.equal(completed.status, 'succeeded');
  assert.notEqual(completed.finished_at, '');
  assert.equal(completed.lease_expires_at, '');
  assert.equal(completed.error, '');
  assert.equal(errored.status, 'failed');
  assert.notEqual(errored.finished_at, '');
  assert.equal(errored.lease_expires_at, '');
  assert.equal(errored.error, 'bad json');
});

test('skipJob sets skipped status and listJobs returns readable jobs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-jobs-'));
  const job = await enqueueJob({ root, sessionId: 'sess_skip', runtime: 'claude' });
  await fs.writeFile(path.join(root, '.bypass', 'jobs', 'not-json.json'), '{bad json');

  const skipped = await skipJob({ root, jobId: job.id, error: 'no events' });
  const jobs = await listJobs({ root });

  assert.equal(skipped.status, 'skipped');
  assert.notEqual(skipped.finished_at, '');
  assert.equal(skipped.lease_expires_at, '');
  assert.equal(skipped.error, 'no events');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, job.id);
});

test('readJob validates safe job path segments', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-jobs-'));

  await assert.rejects(() => readJob({ root, jobId: '../outside' }), /jobId must be a safe path segment/);
  await assert.rejects(() => readJob({ root, jobId: 'job_a/b' }), /jobId must be a safe path segment/);
  await assert.rejects(() => readJob({ root, jobId: 'sess_no_prefix' }), /jobId must be a safe path segment/);
});

test('resetStaleRunningJobs returns expired running jobs to queued', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-jobs-'));
  const stale = await enqueueJob({ root, sessionId: 'sess_stale', runtime: 'codex' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const fresh = await enqueueJob({ root, sessionId: 'sess_fresh', runtime: 'codex' });
  await claimNextJob({ root, leaseMs: 1 });
  await claimNextJob({ root, leaseMs: 60000 });
  await new Promise((resolve) => setTimeout(resolve, 5));

  const reset = await resetStaleRunningJobs({ root, now: new Date() });

  assert.deepEqual(reset.map((job) => job.id), [stale.id]);
  assert.equal((await readJob({ root, jobId: stale.id })).status, 'queued');
  assert.equal((await readJob({ root, jobId: stale.id })).started_at, '');
  assert.equal((await readJob({ root, jobId: stale.id })).lease_expires_at, '');
  assert.equal((await readJob({ root, jobId: fresh.id })).status, 'running');
});
