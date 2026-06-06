import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveServicePaths } from '../core/service-paths.js';

export async function enqueueJob({ root = process.cwd(), sessionId, runtime }) {
  validateSessionId(sessionId);
  const paths = resolveServicePaths({ root });
  await fs.mkdir(paths.jobsDir, { recursive: true });

  const jobId = `job_${sessionId}`;
  const jobPath = jobFile(paths.jobsDir, jobId);
  try {
    return JSON.parse(await fs.readFile(jobPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const now = new Date().toISOString();
  const job = {
    id: jobId,
    session_id: sessionId,
    runtime,
    root,
    status: 'queued',
    created_at: now,
    started_at: '',
    finished_at: '',
    lease_expires_at: '',
    error: '',
  };
  await writeJob(paths.jobsDir, job);
  return job;
}

export async function claimNextJob({ root = process.cwd(), leaseMs = 180000 } = {}) {
  const paths = resolveServicePaths({ root });
  await fs.mkdir(paths.jobsDir, { recursive: true });

  const queued = (await listJobs({ root }))
    .filter((job) => job.status === 'queued')
    .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
  const job = queued[0];
  if (!job) return undefined;

  const now = new Date();
  const claimed = {
    ...job,
    status: 'running',
    started_at: now.toISOString(),
    lease_expires_at: new Date(now.getTime() + leaseMs).toISOString(),
    error: '',
  };
  await writeJob(paths.jobsDir, claimed);
  return claimed;
}

export async function completeJob({ root = process.cwd(), jobId }) {
  return updateJob({
    root,
    jobId,
    patch: { status: 'succeeded', finished_at: new Date().toISOString(), error: '' },
  });
}

export async function skipJob({ root = process.cwd(), jobId, error }) {
  return updateJob({
    root,
    jobId,
    patch: { status: 'skipped', finished_at: new Date().toISOString(), error: error || '' },
  });
}

export async function failJob({ root = process.cwd(), jobId, error }) {
  return updateJob({
    root,
    jobId,
    patch: { status: 'failed', finished_at: new Date().toISOString(), error: error || '' },
  });
}

export async function readJob({ root = process.cwd(), jobId }) {
  const paths = resolveServicePaths({ root });
  return JSON.parse(await fs.readFile(jobFile(paths.jobsDir, jobId), 'utf8'));
}

export async function listJobs({ root = process.cwd() } = {}) {
  const paths = resolveServicePaths({ root });
  let entries;
  try {
    entries = await fs.readdir(paths.jobsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const jobs = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      jobs.push(JSON.parse(await fs.readFile(path.join(paths.jobsDir, entry.name), 'utf8')));
    } catch {
      // Ignore malformed job files so one bad artifact does not block the queue.
    }
  }
  return jobs;
}

export async function resetStaleRunningJobs({ root = process.cwd(), now = new Date() } = {}) {
  const paths = resolveServicePaths({ root });
  const reset = [];

  for (const job of await listJobs({ root })) {
    if (job.status !== 'running') continue;
    if (!job.lease_expires_at || Date.parse(job.lease_expires_at) > now.getTime()) continue;

    const queued = {
      ...job,
      status: 'queued',
      started_at: '',
      lease_expires_at: '',
    };
    reset.push(queued);
    await writeJob(paths.jobsDir, queued);
  }

  return reset;
}

async function updateJob({ root, jobId, patch }) {
  const paths = resolveServicePaths({ root });
  const job = await readJob({ root, jobId });
  const updated = { ...job, ...patch, lease_expires_at: '' };
  await writeJob(paths.jobsDir, updated);
  return updated;
}

async function writeJob(jobsDir, job) {
  await fs.mkdir(jobsDir, { recursive: true });
  await fs.writeFile(jobFile(jobsDir, job.id), `${JSON.stringify(job, null, 2)}\n`);
}

function jobFile(jobsDir, jobId) {
  validateJobId(jobId);
  return path.join(jobsDir, `${jobId}.json`);
}

function validateSessionId(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('sessionId is required');
  }
  if (!isSafePathSegment(sessionId)) {
    throw new Error('sessionId must be a safe path segment');
  }
}

function validateJobId(jobId) {
  if (!jobId || typeof jobId !== 'string' || !jobId.startsWith('job_') || !isSafePathSegment(jobId)) {
    throw new Error('jobId must be a safe path segment');
  }
}

function isSafePathSegment(value) {
  return value !== '.' && value !== '..' && /^[A-Za-z0-9_.-]+$/.test(value);
}
