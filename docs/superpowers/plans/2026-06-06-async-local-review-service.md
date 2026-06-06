# Async Local Review Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a session-scoped local service that asynchronously reviews Evo Bypass sessions, opens the Web UI only for approval-needed knowledge updates, and applies user-edited approved knowledge text.

**Architecture:** `SessionStart` starts `evo-bypassd` only when health is unavailable. `Stop` only enqueues a review job when service health is good and never runs reviewer logic inline. The service owns file-backed jobs, runtime-specific CLI reviewer execution, validation, notification, Web APIs, and edited apply.

**Tech Stack:** Node.js ESM, `node:test`, file-backed JSON/JSONL storage, existing HTTP server style, `codex exec`, `claude -p`, existing `.bypass/sessions` artifact model.

---

## File Structure

- Create `src/core/service-paths.js`: resolves `.bypass/service` and `.bypass/jobs` paths.
- Modify `src/core/config.js`: add service config defaults and normalize service settings.
- Modify `src/collect-event.js`: skip collection when `EVO_BYPASS_INTERNAL=1`.
- Create `src/service/service-client.js`: health check, service start, job enqueue helpers for hooks.
- Create `src/service/job-store.js`: file-backed job creation, claim, completion, failure, stale lease reset.
- Create `src/service/reviewer-prompt.js`: async reviewer system prompt and payload builder.
- Create `src/service/reviewer-runner.js`: invoke `codex exec` or `claude -p`, parse output.
- Create `src/service/reviewer-validation.js`: validate reviewer JSON against event ids and candidate targets.
- Create `src/service/review-worker.js`: claim jobs, build candidates, run reviewer, write artifacts, notify.
- Create `src/service/notifier.js`: open browser for `update_knowledge` actions.
- Create `src/service/apply-edited-update.js`: apply edited approved text.
- Create `src/service/server.js`: local service HTTP API and static UI serving.
- Create `scripts/evo-bypassd.js`: service CLI entrypoint.
- Create `scripts/session-start-service.js`: `SessionStart` hook service starter.
- Create `scripts/enqueue-review-job.js`: `Stop` hook enqueue-only client.
- Modify `hooks/codex-hooks.json` and `hooks/claude-hooks.json`: use session start service script and enqueue Stop script.
- Modify `src/viewer/session-store.js`: include job status in session detail/summary.
- Modify `src/viewer/static/index.html`: evolve the prototype UI into the real viewer UI.
- Modify `src/apply-approved-update.js`: support edited action text from `approval.json`.
- Add tests under `test/service-*.test.js` plus updates to existing apply/viewer tests.

---

### Task 1: Service Paths, Config, and Internal Guard

**Files:**
- Create: `src/core/service-paths.js`
- Modify: `src/core/config.js`
- Modify: `src/collect-event.js`
- Test: `test/service-paths.test.js`
- Test: `test/collect-event.test.js`

- [ ] **Step 1: Write failing tests for service paths and config**

Add `test/service-paths.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveServicePaths } from '../src/core/service-paths.js';

test('resolveServicePaths returns service and jobs paths under .bypass', () => {
  const root = '/tmp/evo-root';
  const paths = resolveServicePaths({ root });

  assert.equal(paths.root, root);
  assert.equal(paths.bypassDir, path.join(root, '.bypass'));
  assert.equal(paths.serviceDir, path.join(root, '.bypass', 'service'));
  assert.equal(paths.jobsDir, path.join(root, '.bypass', 'jobs'));
  assert.equal(paths.serviceUrlPath, path.join(root, '.bypass', 'service', 'service-url'));
  assert.equal(paths.servicePidPath, path.join(root, '.bypass', 'service', 'service.pid'));
  assert.equal(paths.serviceLogPath, path.join(root, '.bypass', 'service', 'service.log'));
});
```

Append to `test/config.test.js`:

```js
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
```

Append to `test/collect-event.test.js`:

```js
test('collectEvent skips internal reviewer invocations', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-internal-'));
  const result = await collectEvent({
    root,
    payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess_internal', prompt: 'review logs' },
    env: { EVO_BYPASS_INTERNAL: '1' }
  });

  assert.equal(result.skipped, true);
  await assert.rejects(
    fs.stat(path.join(root, '.bypass', 'sessions', 'sess_internal', 'events.jsonl')),
    { code: 'ENOENT' }
  );
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
node --test test/service-paths.test.js test/config.test.js test/collect-event.test.js
```

Expected: failures for missing `service-paths.js`, missing `config.service`, and `collectEvent` not accepting `env`.

- [ ] **Step 3: Implement service paths**

Create `src/core/service-paths.js`:

```js
import path from 'node:path';

export function resolveServicePaths({ root = process.cwd() } = {}) {
  const bypassDir = path.join(root, '.bypass');
  const serviceDir = path.join(bypassDir, 'service');
  const jobsDir = path.join(bypassDir, 'jobs');

  return {
    root,
    bypassDir,
    serviceDir,
    jobsDir,
    servicePidPath: path.join(serviceDir, 'service.pid'),
    serviceUrlPath: path.join(serviceDir, 'service-url'),
    serviceLogPath: path.join(serviceDir, 'service.log')
  };
}
```

- [ ] **Step 4: Add service config normalization**

Modify `src/core/config.js`:

```js
const DEFAULT_SERVICE = Object.freeze({
  enabled: true,
  host: '127.0.0.1',
  port: 8765,
  idleTimeoutMs: 20 * 60 * 1000,
  healthTimeoutMs: 250,
  openBrowserOnKnowledge: true
});
```

Add to `readBypassConfig` return object:

```js
service: normalizeService(rawConfig.service),
```

Add function:

```js
export function normalizeService(input) {
  const service = isObject(input) ? input : {};
  return {
    enabled: typeof service.enabled === 'boolean' ? service.enabled : DEFAULT_SERVICE.enabled,
    host: typeof service.host === 'string' && service.host.trim() ? service.host : DEFAULT_SERVICE.host,
    port: Number.isInteger(service.port) && service.port > 0 && service.port <= 65535 ? service.port : DEFAULT_SERVICE.port,
    idleTimeoutMs: Number.isInteger(service.idleTimeoutMs) && service.idleTimeoutMs > 0
      ? service.idleTimeoutMs
      : DEFAULT_SERVICE.idleTimeoutMs,
    healthTimeoutMs: Number.isInteger(service.healthTimeoutMs) && service.healthTimeoutMs > 0
      ? service.healthTimeoutMs
      : DEFAULT_SERVICE.healthTimeoutMs,
    openBrowserOnKnowledge: typeof service.openBrowserOnKnowledge === 'boolean'
      ? service.openBrowserOnKnowledge
      : DEFAULT_SERVICE.openBrowserOnKnowledge
  };
}
```

- [ ] **Step 5: Add internal guard to collector**

Modify `src/collect-event.js` signature:

```js
export async function collectEvent({ root = process.cwd(), payload, env = process.env }) {
  if (env.EVO_BYPASS_INTERNAL === '1') {
    return { skipped: true, reason: 'internal_invocation' };
  }
  // existing implementation continues here
}
```

- [ ] **Step 6: Run tests and verify they pass**

Run:

```bash
node --test test/service-paths.test.js test/config.test.js test/collect-event.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/service-paths.js src/core/config.js src/collect-event.js test/service-paths.test.js test/config.test.js test/collect-event.test.js
git commit -m "feat: add async service foundations"
```

---

### Task 2: Hook Service Client and Hook Entrypoints

**Files:**
- Create: `src/service/service-client.js`
- Create: `scripts/session-start-service.js`
- Create: `scripts/enqueue-review-job.js`
- Modify: `hooks/codex-hooks.json`
- Modify: `hooks/claude-hooks.json`
- Test: `test/service-client.test.js`
- Test: `test/service-hook-cli.test.js`

- [ ] **Step 1: Write failing service client tests**

Create `test/service-client.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkServiceHealth, enqueueReviewJob } from '../src/service/service-client.js';

test('checkServiceHealth returns healthy for service health response', async () => {
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/api/health');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ name: 'evo-bypassd', ok: true }));
  });
  await listen(server);
  try {
    const { port } = server.address();
    const result = await checkServiceHealth({ url: `http://127.0.0.1:${port}`, timeoutMs: 500 });
    assert.equal(result.healthy, true);
  } finally {
    await close(server);
  }
});

test('checkServiceHealth returns unhealthy on connection failure', async () => {
  const result = await checkServiceHealth({ url: 'http://127.0.0.1:9', timeoutMs: 50 });
  assert.equal(result.healthy, false);
  assert.match(result.error, /fetch failed|bad port|ECONNREFUSED/i);
});

test('enqueueReviewJob posts small job payload', async () => {
  const received = [];
  const server = http.createServer(async (request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/api/jobs');
    let body = '';
    for await (const chunk of request) body += chunk;
    received.push(JSON.parse(body));
    response.writeHead(202, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'job_sess_1', status: 'queued' }));
  });
  await listen(server);
  try {
    const { port } = server.address();
    const result = await enqueueReviewJob({
      url: `http://127.0.0.1:${port}`,
      job: { session_id: 'sess_1', runtime: 'codex', root: '/tmp/repo' },
      timeoutMs: 500
    });
    assert.equal(result.enqueued, true);
    assert.deepEqual(received[0], { session_id: 'sess_1', runtime: 'codex', root: '/tmp/repo' });
  } finally {
    await close(server);
  }
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
```

- [ ] **Step 2: Write failing CLI tests**

Create `test/service-hook-cli.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const enqueueCli = path.join(repoRoot, 'scripts', 'enqueue-review-job.js');

test('enqueue-review-job skips when service health is unavailable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-hook-'));
  const result = spawnSync(process.execPath, [enqueueCli, '--runtime', 'codex'], {
    cwd: root,
    input: JSON.stringify({ session_id: 'sess_skip', cwd: root }),
    env: { ...process.env, EVO_BYPASS_SERVICE_URL: 'http://127.0.0.1:9' },
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.continue, true);
  const log = await fs.readFile(path.join(root, '.bypass', 'stop-hook.log'), 'utf8');
  assert.match(log, /service_unhealthy/);
});

test('enqueue-review-job posts job when service is healthy', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-hook-'));
  const jobs = [];
  const server = http.createServer(async (request, response) => {
    if (request.url === '/api/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ name: 'evo-bypassd', ok: true }));
      return;
    }
    if (request.url === '/api/jobs') {
      let body = '';
      for await (const chunk of request) body += chunk;
      jobs.push(JSON.parse(body));
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'job_sess_ok', status: 'queued' }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const result = spawnSync(process.execPath, [enqueueCli, '--runtime', 'codex'], {
      cwd: root,
      input: JSON.stringify({ session_id: 'sess_ok', cwd: root }),
      env: { ...process.env, EVO_BYPASS_SERVICE_URL: `http://127.0.0.1:${port}` },
      encoding: 'utf8'
    });

    assert.equal(result.status, 0);
    assert.deepEqual(jobs[0], { session_id: 'sess_ok', runtime: 'codex', root });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
```

- [ ] **Step 3: Run tests and verify they fail**

Run:

```bash
node --test test/service-client.test.js test/service-hook-cli.test.js
```

Expected: missing modules/scripts.

- [ ] **Step 4: Implement service client**

Create `src/service/service-client.js`:

```js
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveServicePaths } from '../core/service-paths.js';

export function serviceUrl({ host = '127.0.0.1', port = 8765 } = {}) {
  return `http://${host}:${port}`;
}

export async function readServiceUrl({ root, fallbackUrl }) {
  if (process.env.EVO_BYPASS_SERVICE_URL) return process.env.EVO_BYPASS_SERVICE_URL;
  const paths = resolveServicePaths({ root });
  try {
    const text = await fs.readFile(paths.serviceUrlPath, 'utf8');
    return text.trim() || fallbackUrl;
  } catch (error) {
    if (error.code === 'ENOENT') return fallbackUrl;
    throw error;
  }
}

export async function checkServiceHealth({ url, timeoutMs = 250 }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}/api/health`, { signal: controller.signal });
    if (!response.ok) return { healthy: false, error: `health returned ${response.status}` };
    const body = await response.json();
    return { healthy: body?.name === 'evo-bypassd', body };
  } catch (error) {
    return { healthy: false, error: error.message || String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function enqueueReviewJob({ url, job, timeoutMs = 500 }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(job),
      signal: controller.signal
    });
    if (!response.ok) return { enqueued: false, error: `enqueue returned ${response.status}` };
    return { enqueued: true, body: await response.json() };
  } catch (error) {
    return { enqueued: false, error: error.message || String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function appendHookLog({ root, file = 'stop-hook.log', entry }) {
  const logPath = path.join(root, '.bypass', file);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, `${JSON.stringify({ timestamp: new Date().toISOString(), cwd: root, ...entry })}\n`);
}

export function startServiceDetached({ root, scriptPath, env = process.env }) {
  const child = spawn(process.execPath, [scriptPath, '--root', root], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    env
  });
  child.unref();
  return child.pid;
}
```

- [ ] **Step 5: Implement enqueue hook script**

Create `scripts/enqueue-review-job.js`:

```js
#!/usr/bin/env node
import { readBypassConfig } from '../src/core/config.js';
import { checkServiceHealth, enqueueReviewJob, readServiceUrl, serviceUrl, appendHookLog } from '../src/service/service-client.js';

const payload = await readPayload();
const runtime = runtimeArg() || payload.runtime || 'claude';
const sessionId = payload.session_id || payload.sessionId || payload.conversation_id || payload.thread_id || process.env.CLAUDE_SESSION_ID || process.env.CODEX_SESSION_ID;
const root = payload.cwd || payload.working_directory || payload.workspace || process.cwd();

try {
  if (!sessionId) {
    await appendHookLog({ root, entry: { event: 'enqueue_skipped', reason: 'missing_session_id', runtime } });
    emitContinue();
    process.exit(0);
  }

  const config = await readBypassConfig({ root });
  const url = await readServiceUrl({ root, fallbackUrl: serviceUrl(config.service) });
  const health = await checkServiceHealth({ url, timeoutMs: config.service.healthTimeoutMs });
  if (!health.healthy) {
    await appendHookLog({ root, entry: { event: 'service_unhealthy', runtime, sessionId, error: health.error || '' } });
    emitContinue();
    process.exit(0);
  }

  const result = await enqueueReviewJob({
    url,
    job: { session_id: sessionId, runtime, root },
    timeoutMs: config.service.healthTimeoutMs * 2
  });
  await appendHookLog({ root, entry: { event: result.enqueued ? 'job_enqueued' : 'enqueue_failed', runtime, sessionId, error: result.error || '' } });
  emitContinue();
} catch (error) {
  await appendHookLog({ root, entry: { event: 'enqueue_error', runtime, sessionId, error: error.message || String(error) } }).catch(() => {});
  emitContinue();
}

async function readPayload() {
  if (process.stdin.isTTY) return {};
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  try {
    const parsed = input ? JSON.parse(input) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function runtimeArg() {
  const index = process.argv.indexOf('--runtime');
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function emitContinue() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}
```

- [ ] **Step 6: Implement session start script**

Create `scripts/session-start-service.js`:

```js
#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBypassConfig } from '../src/core/config.js';
import { checkServiceHealth, readServiceUrl, serviceUrl, startServiceDetached, appendHookLog } from '../src/service/service-client.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const payload = await readPayload();
const root = payload.cwd || payload.working_directory || payload.workspace || process.cwd();
const runtime = runtimeArg() || payload.runtime || 'claude';

try {
  const config = await readBypassConfig({ root });
  if (!config.service.enabled) {
    emitContinue();
    process.exit(0);
  }
  const url = await readServiceUrl({ root, fallbackUrl: serviceUrl(config.service) });
  const health = await checkServiceHealth({ url, timeoutMs: config.service.healthTimeoutMs });
  if (health.healthy) {
    emitContinue();
    process.exit(0);
  }
  const pid = startServiceDetached({
    root,
    scriptPath: path.join(repoRoot, 'scripts', 'evo-bypassd.js'),
    env: { ...process.env, EVO_BYPASS_STARTED_BY: 'SessionStart', EVO_BYPASS_RUNTIME: runtime }
  });
  await appendHookLog({ root, file: 'service/session-start.log', entry: { event: 'service_start_requested', runtime, pid } });
  emitContinue();
} catch (error) {
  await appendHookLog({ root, file: 'service/session-start.log', entry: { event: 'service_start_error', runtime, error: error.message || String(error) } }).catch(() => {});
  emitContinue();
}

async function readPayload() {
  if (process.stdin.isTTY) return {};
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  try {
    const parsed = input ? JSON.parse(input) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function runtimeArg() {
  const index = process.argv.indexOf('--runtime');
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function emitContinue() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}
```

- [ ] **Step 7: Update hook configs**

Modify `hooks/codex-hooks.json`:

```json
"SessionStart": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "node \"$EVO_BYPASS_HOME/scripts/collect-event.js\" --runtime codex",
        "timeout": 5
      },
      {
        "type": "command",
        "command": "node \"$EVO_BYPASS_HOME/scripts/session-start-service.js\" --runtime codex",
        "timeout": 5
      }
    ]
  }
],
"Stop": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "node \"$EVO_BYPASS_HOME/scripts/enqueue-review-job.js\" --runtime codex",
        "timeout": 5
      }
    ]
  }
]
```

Make the equivalent change in `hooks/claude-hooks.json`: keep existing collection hooks, add `session-start-service.js --runtime claude` at session start if the file has a matching lifecycle, and replace synchronous Stop review with `enqueue-review-job.js --runtime claude`.

- [ ] **Step 8: Run tests**

Run:

```bash
node --test test/service-client.test.js test/service-hook-cli.test.js
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/service/service-client.js scripts/session-start-service.js scripts/enqueue-review-job.js hooks/codex-hooks.json hooks/claude-hooks.json test/service-client.test.js test/service-hook-cli.test.js
git commit -m "feat: enqueue async review jobs from hooks"
```

---

### Task 3: File-Backed Job Store

**Files:**
- Create: `src/service/job-store.js`
- Test: `test/job-store.test.js`

- [ ] **Step 1: Write failing job store tests**

Create `test/job-store.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  enqueueJob,
  claimNextJob,
  completeJob,
  failJob,
  resetStaleRunningJobs,
  readJob
} from '../src/service/job-store.js';

test('enqueueJob creates stable job and dedupes duplicate session', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-jobs-'));
  const first = await enqueueJob({ root, sessionId: 'sess_a', runtime: 'codex' });
  const second = await enqueueJob({ root, sessionId: 'sess_a', runtime: 'codex' });

  assert.equal(first.id, 'job_sess_a');
  assert.equal(first.status, 'queued');
  assert.equal(second.id, first.id);
  assert.equal(second.status, 'queued');
});

test('claimNextJob marks queued job running with lease', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-jobs-'));
  await enqueueJob({ root, sessionId: 'sess_claim', runtime: 'claude' });

  const claimed = await claimNextJob({ root, leaseMs: 60000 });
  assert.equal(claimed.session_id, 'sess_claim');
  assert.equal(claimed.status, 'running');
  assert.match(claimed.started_at, /^20/);
  assert.match(claimed.lease_expires_at, /^20/);
});

test('completeJob and failJob persist terminal states', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-jobs-'));
  const job = await enqueueJob({ root, sessionId: 'sess_done', runtime: 'codex' });
  await completeJob({ root, jobId: job.id });
  assert.equal((await readJob({ root, jobId: job.id })).status, 'succeeded');

  const failed = await enqueueJob({ root, sessionId: 'sess_fail', runtime: 'codex' });
  await failJob({ root, jobId: failed.id, error: 'bad json' });
  const read = await readJob({ root, jobId: failed.id });
  assert.equal(read.status, 'failed');
  assert.equal(read.error, 'bad json');
});

test('resetStaleRunningJobs returns expired running jobs to queued', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-jobs-'));
  const job = await enqueueJob({ root, sessionId: 'sess_stale', runtime: 'codex' });
  const claimed = await claimNextJob({ root, leaseMs: 1 });
  assert.equal(claimed.id, job.id);
  await new Promise((resolve) => setTimeout(resolve, 5));

  const reset = await resetStaleRunningJobs({ root, now: new Date() });
  assert.equal(reset.length, 1);
  assert.equal((await readJob({ root, jobId: job.id })).status, 'queued');
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
node --test test/job-store.test.js
```

Expected: missing `job-store.js`.

- [ ] **Step 3: Implement job store**

Create `src/service/job-store.js`:

```js
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveServicePaths } from '../core/service-paths.js';

export async function enqueueJob({ root = process.cwd(), sessionId, runtime }) {
  if (!sessionId || typeof sessionId !== 'string') throw new Error('sessionId is required');
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
    error: ''
  };
  await writeJob(paths.jobsDir, job);
  return job;
}

export async function claimNextJob({ root = process.cwd(), leaseMs = 180000 } = {}) {
  const paths = resolveServicePaths({ root });
  await fs.mkdir(paths.jobsDir, { recursive: true });
  const jobs = await listJobs({ root });
  const queued = jobs.filter((job) => job.status === 'queued')
    .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
  const job = queued[0];
  if (!job) return undefined;
  const now = new Date();
  job.status = 'running';
  job.started_at = now.toISOString();
  job.lease_expires_at = new Date(now.getTime() + leaseMs).toISOString();
  job.error = '';
  await writeJob(paths.jobsDir, job);
  return job;
}

export async function completeJob({ root = process.cwd(), jobId }) {
  return updateJob({ root, jobId, patch: { status: 'succeeded', finished_at: new Date().toISOString(), error: '' } });
}

export async function skipJob({ root = process.cwd(), jobId, error }) {
  return updateJob({ root, jobId, patch: { status: 'skipped', finished_at: new Date().toISOString(), error: error || '' } });
}

export async function failJob({ root = process.cwd(), jobId, error }) {
  return updateJob({ root, jobId, patch: { status: 'failed', finished_at: new Date().toISOString(), error: error || '' } });
}

export async function readJob({ root = process.cwd(), jobId }) {
  const paths = resolveServicePaths({ root });
  return JSON.parse(await fs.readFile(jobFile(paths.jobsDir, jobId), 'utf8'));
}

export async function listJobs({ root = process.cwd() } = {}) {
  const paths = resolveServicePaths({ root });
  let entries = [];
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
      // Ignore malformed job files; service log will handle worker failures elsewhere.
    }
  }
  return jobs;
}

export async function resetStaleRunningJobs({ root = process.cwd(), now = new Date() } = {}) {
  const paths = resolveServicePaths({ root });
  const jobs = await listJobs({ root });
  const reset = [];
  for (const job of jobs) {
    if (job.status !== 'running') continue;
    if (!job.lease_expires_at || new Date(job.lease_expires_at) > now) continue;
    job.status = 'queued';
    job.started_at = '';
    job.lease_expires_at = '';
    reset.push(job);
    await writeJob(paths.jobsDir, job);
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
  if (!/^job_[A-Za-z0-9_.-]+$/.test(jobId)) throw new Error('jobId must be safe');
  return path.join(jobsDir, `${jobId}.json`);
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
node --test test/job-store.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/service/job-store.js test/job-store.test.js
git commit -m "feat: add async review job store"
```

---

### Task 4: Reviewer Prompt, Runner, and Validation

**Files:**
- Create: `src/service/reviewer-prompt.js`
- Create: `src/service/reviewer-runner.js`
- Create: `src/service/reviewer-validation.js`
- Test: `test/reviewer-runner.test.js`
- Test: `test/reviewer-validation.test.js`

- [ ] **Step 1: Write validation tests**

Create `test/reviewer-validation.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateReviewerResult } from '../src/service/reviewer-validation.js';

test('validateReviewerResult accepts update_knowledge with known evidence and candidate target', () => {
  const root = '/tmp/repo';
  const target = path.join(root, 'AGENTS.md');
  const result = validateReviewerResult({
    root,
    parsed: {
      summary: 'Found convention.',
      retrospective: {
        outcome: 'completed',
        quality: 'minor_issues',
        findings: [{
          id: 'finding_evt_1',
          category: 'knowledge',
          severity: 'medium',
          evidence: ['evt_1'],
          diagnosis: 'Reusable convention.',
          recommendation: 'Save it.',
          action: {
            type: 'update_knowledge',
            confidence: 'high',
            target,
            target_reason: 'Repository root',
            proposed_text: 'Project convention: use node --test.',
            rationale: 'Future test runs should reuse it.'
          }
        }]
      }
    },
    events: [{ id: 'evt_1' }],
    candidates: [{ target }]
  });

  assert.equal(result.retrospective.findings.length, 1);
});

test('validateReviewerResult rejects unknown evidence ids', () => {
  assert.throws(() => validateReviewerResult({
    root: '/tmp/repo',
    parsed: {
      retrospective: {
        outcome: 'completed',
        quality: 'minor_issues',
        findings: [{
          id: 'finding_bad',
          category: 'knowledge',
          severity: 'medium',
          evidence: ['evt_missing'],
          diagnosis: 'No evidence.',
          recommendation: 'No.',
          action: { type: 'no_action', confidence: 'low' }
        }]
      }
    },
    events: [{ id: 'evt_1' }],
    candidates: []
  }), /unknown evidence id/);
});

test('validateReviewerResult rejects update targets outside candidates', () => {
  assert.throws(() => validateReviewerResult({
    root: '/tmp/repo',
    parsed: {
      retrospective: {
        outcome: 'completed',
        quality: 'minor_issues',
        findings: [{
          id: 'finding_escape',
          category: 'knowledge',
          severity: 'medium',
          evidence: ['evt_1'],
          diagnosis: 'Bad target.',
          recommendation: 'No.',
          action: {
            type: 'update_knowledge',
            confidence: 'high',
            target: '/tmp/outside.md',
            proposed_text: 'Do not write.'
          }
        }]
      }
    },
    events: [{ id: 'evt_1' }],
    candidates: [{ target: '/tmp/repo/AGENTS.md' }]
  }), /target must match a candidate/);
});
```

- [ ] **Step 2: Write runner tests with fake CLI**

Create `test/reviewer-runner.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runReviewerCli } from '../src/service/reviewer-runner.js';

test('runReviewerCli invokes codex-compatible command with internal guard', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-runner-'));
  const fake = path.join(root, 'fake-codex.js');
  const seen = path.join(root, 'seen.json');
  await fs.writeFile(fake, `#!/usr/bin/env node
import fs from 'node:fs';
const outputIndex = process.argv.indexOf('--output-last-message');
fs.writeFileSync('${seen}', JSON.stringify({ args: process.argv.slice(2), internal: process.env.EVO_BYPASS_INTERNAL }));
fs.writeFileSync(process.argv[outputIndex + 1], JSON.stringify({ summary: 'ok', retrospective: { outcome: 'completed', quality: 'smooth', findings: [] } }));
`);
  await fs.chmod(fake, 0o755);

  const result = await runReviewerCli({
    root,
    runtime: 'codex',
    prompt: 'review this',
    env: { ...process.env, EVO_BYPASS_CODEX_PATH: fake },
    timeoutMs: 5000
  });

  const logged = JSON.parse(await fs.readFile(seen, 'utf8'));
  assert.equal(result.parsed.retrospective.quality, 'smooth');
  assert.equal(logged.internal, '1');
  assert.equal(logged.args.includes('exec'), true);
});

test('runReviewerCli fails on non-json output', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-runner-'));
  const fake = path.join(root, 'fake-claude.js');
  await fs.writeFile(fake, `#!/usr/bin/env node
console.log('not json');
`);
  await fs.chmod(fake, 0o755);

  await assert.rejects(
    runReviewerCli({
      root,
      runtime: 'claude',
      prompt: 'review this',
      env: { ...process.env, EVO_BYPASS_CLAUDE_PATH: fake },
      timeoutMs: 5000
    }),
    /Reviewer output was not valid JSON/
  );
});
```

- [ ] **Step 3: Run tests and verify they fail**

Run:

```bash
node --test test/reviewer-validation.test.js test/reviewer-runner.test.js
```

Expected: missing modules.

- [ ] **Step 4: Implement reviewer prompt**

Create `src/service/reviewer-prompt.js`:

```js
export const ASYNC_REVIEWER_SYSTEM_PROMPT = `# Evo Bypass Async Session Reviewer

You are a background reviewer for Evo Bypass. Review one completed coding-agent session and produce a structured retrospective.

You are not the main agent. Do not continue the user's task. Do not write files. Do not run tools. Do not ask the user questions. Your only job is to analyze the provided session artifacts and return JSON.

Return JSON only.

Use only evidence ids present in events. For update_knowledge, use only target paths present in candidates. Prefer no findings over weak findings.`;

export function buildReviewerPrompt(payload) {
  return `${ASYNC_REVIEWER_SYSTEM_PROMPT}

## Session Payload

\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\`
`;
}
```

- [ ] **Step 5: Implement reviewer validation**

Create `src/service/reviewer-validation.js`:

```js
import path from 'node:path';
import { normalizeRetrospectiveResult } from '../core/retrospective-schema.js';

const OUTCOMES = new Set(['completed', 'partial', 'failed', 'unknown']);
const QUALITIES = new Set(['smooth', 'minor_issues', 'significant_issues']);
const CATEGORIES = new Set(['knowledge', 'skill', 'code', 'agent_usage', 'environment']);
const SEVERITIES = new Set(['low', 'medium', 'high']);
const ACTION_TYPES = new Set(['update_knowledge', 'create_skill', 'improve_code', 'adjust_agent_usage', 'fix_environment', 'no_action']);
const CONFIDENCES = new Set(['low', 'medium', 'high']);

export function validateReviewerResult({ root, parsed, events, candidates }) {
  if (!Array.isArray(parsed?.retrospective?.findings)) {
    throw new Error('reviewer result must include retrospective.findings array');
  }
  const eventIds = new Set(events.map((event) => event.id));
  const candidateTargets = new Set(candidates.map((candidate) => path.resolve(candidate.target)));
  const normalizedFindings = parsed.retrospective.findings.map((finding) => {
    validateFinding({ root, finding, eventIds, candidateTargets });
    return finding;
  });

  return normalizeRetrospectiveResult({
    sessionId: parsed.session_id,
    summary: parsed.summary,
    outcome: enumOrDefault(parsed.retrospective.outcome, OUTCOMES, 'unknown'),
    quality: enumOrDefault(parsed.retrospective.quality, QUALITIES, 'smooth'),
    findings: normalizedFindings
  });
}

function validateFinding({ root, finding, eventIds, candidateTargets }) {
  if (!finding || typeof finding !== 'object') throw new Error('finding must be an object');
  if (!CATEGORIES.has(finding.category)) throw new Error('invalid finding category');
  if (!SEVERITIES.has(finding.severity)) throw new Error('invalid finding severity');
  if (!Array.isArray(finding.evidence) || finding.evidence.length === 0) throw new Error('finding evidence is required');
  for (const id of finding.evidence) {
    if (!eventIds.has(id)) throw new Error(`unknown evidence id: ${id}`);
  }
  const action = finding.action || {};
  if (!ACTION_TYPES.has(action.type)) throw new Error('invalid action type');
  if (!CONFIDENCES.has(action.confidence)) throw new Error('invalid action confidence');
  if (action.type === 'update_knowledge') {
    if (typeof action.proposed_text !== 'string' || action.proposed_text.trim() === '') {
      throw new Error('update_knowledge proposed_text is required');
    }
    const target = path.resolve(root, action.target || '');
    if (!candidateTargets.has(target)) throw new Error('update_knowledge target must match a candidate');
    const relative = path.relative(path.resolve(root), target);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('update_knowledge target must stay inside root');
    }
    action.target = target;
  }
}

function enumOrDefault(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback;
}
```

- [ ] **Step 6: Implement reviewer runner**

Create `src/service/reviewer-runner.js`:

```js
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export async function runReviewerCli({ root, runtime, prompt, env = process.env, timeoutMs = 180000 }) {
  if (runtime === 'codex') return runCodex({ root, prompt, env, timeoutMs });
  if (runtime === 'claude') return runClaude({ root, prompt, env, timeoutMs });
  throw new Error(`unsupported reviewer runtime: ${runtime}`);
}

async function runCodex({ root, prompt, env, timeoutMs }) {
  const outputPath = path.join(os.tmpdir(), `evo-bypass-review-${process.pid}-${Date.now()}.json`);
  const command = env.EVO_BYPASS_CODEX_PATH || 'codex';
  const args = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--ignore-rules', '--output-last-message', outputPath, '-'];
  await runProcess({ command, args, input: prompt, cwd: root, env, timeoutMs });
  try {
    return parseReviewerOutput(await fs.readFile(outputPath, 'utf8'));
  } finally {
    await fs.rm(outputPath, { force: true });
  }
}

async function runClaude({ root, prompt, env, timeoutMs }) {
  const command = env.EVO_BYPASS_CLAUDE_PATH || 'claude';
  const args = ['-p', '--output-format', 'json'];
  const output = await runProcess({ command, args, input: prompt, cwd: root, env, timeoutMs });
  return parseReviewerOutput(output.stdout);
}

function parseReviewerOutput(text) {
  try {
    return { parsed: JSON.parse(String(text || '').trim()) };
  } catch {
    throw new Error('Reviewer output was not valid JSON');
  }
}

function runProcess({ command, args, input, cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...env, EVO_BYPASS_INTERNAL: '1', CLAUDE_CODE_ENTRYPOINT: 'evo-bypass-reviewer' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Reviewer CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Reviewer CLI exited ${code}: ${stderr.slice(0, 1000)}`));
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.end(input);
  });
}
```

- [ ] **Step 7: Run tests**

Run:

```bash
node --test test/reviewer-validation.test.js test/reviewer-runner.test.js
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/service/reviewer-prompt.js src/service/reviewer-runner.js src/service/reviewer-validation.js test/reviewer-runner.test.js test/reviewer-validation.test.js
git commit -m "feat: add async reviewer runner"
```

---

### Task 5: Review Worker and Notification

**Files:**
- Create: `src/service/review-worker.js`
- Create: `src/service/notifier.js`
- Test: `test/review-worker.test.js`

- [ ] **Step 1: Write failing worker test**

Create `test/review-worker.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectEvent } from '../src/collect-event.js';
import { enqueueJob, readJob } from '../src/service/job-store.js';
import { runOneReviewJob } from '../src/service/review-worker.js';
import { resolveSessionPaths } from '../src/core/session-paths.js';

test('runOneReviewJob writes retrospective and notifies for knowledge actions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-worker-'));
  await collectEvent({ root, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess_worker', prompt: 'remember test command' } });
  await collectEvent({
    root,
    payload: {
      hook_event_name: 'PostToolUse',
      session_id: 'sess_worker',
      tool_name: 'Bash',
      tool_input: { command: 'node --test' },
      tool_response: { exit_code: 0, output: 'Project convention: use node --test.' }
    }
  });
  const job = await enqueueJob({ root, sessionId: 'sess_worker', runtime: 'codex' });
  const notified = [];
  const result = await runOneReviewJob({
    root,
    reviewer: async () => ({
      parsed: {
        summary: 'Found convention.',
        retrospective: {
          outcome: 'completed',
          quality: 'minor_issues',
          findings: [{
            id: 'finding_evt_2',
            category: 'knowledge',
            severity: 'medium',
            evidence: ['evt_0002'],
            diagnosis: 'Reusable test convention.',
            recommendation: 'Save it.',
            action: {
              type: 'update_knowledge',
              confidence: 'high',
              target: path.join(root, 'AGENTS.md'),
              target_reason: 'Repository-level convention.',
              proposed_text: 'Project convention: use node --test.',
              rationale: 'Future verification should reuse this.'
            }
          }]
        }
      }
    }),
    notify: async (payload) => notified.push(payload)
  });

  assert.equal(result.status, 'succeeded');
  assert.equal((await readJob({ root, jobId: job.id })).status, 'succeeded');
  const paths = resolveSessionPaths({ root, sessionId: 'sess_worker' });
  const retrospective = JSON.parse(await fs.readFile(paths.retrospectivePath, 'utf8'));
  assert.equal(retrospective.retrospective.findings[0].action.type, 'update_knowledge');
  assert.equal(notified.length, 1);
  assert.equal(notified[0].sessionId, 'sess_worker');
});

test('runOneReviewJob fails job on reviewer error without fallback', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-worker-'));
  await collectEvent({ root, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess_fail', prompt: 'hello' } });
  const job = await enqueueJob({ root, sessionId: 'sess_fail', runtime: 'codex' });

  const result = await runOneReviewJob({
    root,
    reviewer: async () => { throw new Error('bad json'); },
    notify: async () => { throw new Error('should not notify'); }
  });

  assert.equal(result.status, 'failed');
  const read = await readJob({ root, jobId: job.id });
  assert.equal(read.status, 'failed');
  assert.match(read.error, /bad json/);
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
node --test test/review-worker.test.js
```

Expected: missing `review-worker.js`.

- [ ] **Step 3: Implement notifier**

Create `src/service/notifier.js`:

```js
import { spawn } from 'node:child_process';
import { viewerUrl } from '../viewer/server.js';

export async function notifyKnowledgeReady({ host, port, sessionId, openBrowser = true }) {
  const url = `${viewerUrl({ host, port, sessionId })}?review=ready`;
  if (!openBrowser) return { url, opened: false };
  openUrl(url);
  return { url, opened: true };
}

function openUrl(url) {
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
}
```

- [ ] **Step 4: Implement review worker**

Create `src/service/review-worker.js`:

```js
import fs from 'node:fs/promises';
import path from 'node:path';
import { claimNextJob, completeJob, failJob, skipJob } from './job-store.js';
import { buildReviewerPrompt } from './reviewer-prompt.js';
import { runReviewerCli } from './reviewer-runner.js';
import { validateReviewerResult } from './reviewer-validation.js';
import { notifyKnowledgeReady } from './notifier.js';
import { resolveSessionPaths } from '../core/session-paths.js';
import { readBypassConfig } from '../core/config.js';
import { routeKnowledgeTarget } from '../knowledge-routing.js';

export async function runOneReviewJob({
  root = process.cwd(),
  reviewer,
  notify,
  leaseMs = 180000
} = {}) {
  const job = await claimNextJob({ root, leaseMs });
  if (!job) return { status: 'nothing' };
  try {
    const payload = await buildPayload({ root, job });
    if (payload.events.length === 0) {
      await skipJob({ root, jobId: job.id, error: 'session has no events' });
      return { status: 'skipped' };
    }
    const prompt = buildReviewerPrompt(payload);
    const review = reviewer
      ? await reviewer({ root, runtime: job.runtime, prompt, payload })
      : await runReviewerCli({ root, runtime: job.runtime, prompt });
    const result = validateReviewerResult({
      root,
      parsed: { session_id: job.session_id, ...review.parsed },
      events: payload.events,
      candidates: payload.candidates
    });
    await writeReviewArtifacts({ root, sessionId: job.session_id, result });
    await completeJob({ root, jobId: job.id });
    if (hasKnowledgeActions(result)) {
      const config = await readBypassConfig({ root });
      const notifier = notify || notifyKnowledgeReady;
      await notifier({
        host: config.viewer.host,
        port: config.viewer.port,
        sessionId: job.session_id,
        openBrowser: config.service.openBrowserOnKnowledge
      });
    }
    return { status: 'succeeded', result };
  } catch (error) {
    await failJob({ root, jobId: job.id, error: error.message || String(error) });
    await writeReviewerLog({ root, sessionId: job.session_id, text: `Review failed: ${error.message || String(error)}\n` });
    return { status: 'failed', error };
  }
}

async function buildPayload({ root, job }) {
  const paths = resolveSessionPaths({ root, sessionId: job.session_id });
  const metadata = await readJson(paths.metadataPath, {});
  const events = await readEvents(paths.eventsPath);
  const config = await readBypassConfig({ root });
  const candidates = [];
  for (const event of events) {
    const route = await routeKnowledgeTarget({ root, event, configuredTarget: config.knowledgeTarget });
    candidates.push({
      event_id: event.id,
      target: route.target,
      target_reason: route.target_reason,
      target_exists: await fileExists(route.target),
      relative_target: path.relative(root, route.target),
      target_preview: await readPreview(route.target)
    });
  }
  return {
    session_id: job.session_id,
    runtime: job.runtime,
    workspace_root: root,
    metadata,
    events,
    candidates
  };
}

async function writeReviewArtifacts({ root, sessionId, result }) {
  const paths = resolveSessionPaths({ root, sessionId });
  await fs.mkdir(paths.sessionDir, { recursive: true });
  await fs.writeFile(paths.retrospectivePath, `${JSON.stringify(result, null, 2)}\n`);
  await fs.writeFile(paths.retrospectiveMarkdownPath, formatMarkdown(result));
  await writeReviewerLog({ root, sessionId, text: `Review succeeded: ${result.summary}\n` });
}

function formatMarkdown(result) {
  const findings = result.retrospective.findings;
  const lines = ['# Session Retrospective', '', `Session: ${result.session_id}`, '', '## Task Status', '', `- Outcome: ${result.retrospective.outcome}`, `- Quality: ${result.retrospective.quality}`, `- Summary: ${result.summary}`, '', '## Findings'];
  if (findings.length === 0) lines.push('', 'No significant failures or reusable improvements were detected.');
  for (const finding of findings) {
    lines.push('', `### ${finding.id}`, '', `- Category: ${finding.category}`, `- Severity: ${finding.severity}`, `- Evidence: ${finding.evidence.join(', ')}`, `- Diagnosis: ${finding.diagnosis}`, `- Recommendation: ${finding.recommendation}`, `- Action: ${finding.action.type}`);
    if (finding.action.proposed_text) lines.push('', finding.action.proposed_text);
  }
  return `${lines.join('\n')}\n`;
}

async function writeReviewerLog({ root, sessionId, text }) {
  const paths = resolveSessionPaths({ root, sessionId });
  await fs.mkdir(paths.sessionDir, { recursive: true });
  await fs.writeFile(paths.reviewerLogPath, text);
}

function hasKnowledgeActions(result) {
  return result.retrospective.findings.some((finding) => finding.action?.type === 'update_knowledge');
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function readEvents(eventsPath) {
  try {
    const text = await fs.readFile(eventsPath, 'utf8');
    return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function fileExists(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function readPreview(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return text.length > 4000 ? `${text.slice(0, 4000)}...` : text;
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}
```

- [ ] **Step 5: Run test**

Run:

```bash
node --test test/review-worker.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/service/review-worker.js src/service/notifier.js test/review-worker.test.js
git commit -m "feat: process async review jobs"
```

---

### Task 6: Local Service HTTP Server

**Files:**
- Create: `src/service/server.js`
- Create: `scripts/evo-bypassd.js`
- Modify: `src/viewer/session-store.js`
- Test: `test/service-server.test.js`

- [ ] **Step 1: Write failing service server tests**

Create `test/service-server.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServiceServer } from '../src/service/server.js';

test('service server exposes health and accepts jobs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-service-'));
  const service = await startServiceServer({ root, host: '127.0.0.1', port: 0, startWorker: false });
  try {
    const health = await getJson(`${service.url}/api/health`);
    assert.equal(health.name, 'evo-bypassd');
    assert.equal(health.ok, true);

    const enqueue = await fetch(`${service.url}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'sess_http', runtime: 'codex', root })
    });
    assert.equal(enqueue.status, 202);
    const job = await enqueue.json();
    assert.equal(job.id, 'job_sess_http');
    assert.equal(job.status, 'queued');

    const jobDetail = await getJson(`${service.url}/api/jobs/job_sess_http`);
    assert.equal(jobDetail.session_id, 'sess_http');
  } finally {
    await service.close();
  }
});

test('service server serves async review UI', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-service-'));
  const service = await startServiceServer({ root, host: '127.0.0.1', port: 0, startWorker: false });
  try {
    const response = await fetch(`${service.url}/sessions`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Evo Bypass|Async review/i);
  } finally {
    await service.close();
  }
});

async function getJson(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return response.json();
}
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
node --test test/service-server.test.js
```

Expected: missing `service/server.js`.

- [ ] **Step 3: Implement service server**

Create `src/service/server.js`:

```js
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enqueueJob, readJob, listJobs, resetStaleRunningJobs } from './job-store.js';
import { runOneReviewJob } from './review-worker.js';
import { getSessionDetail, listSessions } from '../viewer/session-store.js';
import { applyEditedApprovedUpdate } from './apply-edited-update.js';
import { resolveServicePaths } from '../core/service-paths.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const uiPath = path.join(repoRoot, 'src', 'viewer', 'static', 'index.html');

export async function startServiceServer({ root = process.cwd(), host = '127.0.0.1', port = 8765, startWorker = true } = {}) {
  const server = http.createServer((request, response) => {
    handleRequest({ root, request, response }).catch((error) => sendJson(response, 500, { error: error.message || String(error) }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const resolvedPort = typeof address === 'object' && address ? address.port : port;
  const url = `http://${host}:${resolvedPort}`;
  await writeServiceFiles({ root, url });
  let workerTimer;
  if (startWorker) {
    await resetStaleRunningJobs({ root });
    workerTimer = setInterval(() => runOneReviewJob({ root }).catch(() => {}), 1000);
  }
  return {
    server,
    host,
    port: resolvedPort,
    url,
    close: () => new Promise((resolve, reject) => {
      if (workerTimer) clearInterval(workerTimer);
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

async function handleRequest({ root, request, response }) {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, { name: 'evo-bypassd', ok: true, root });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/jobs') {
    const body = await readJsonBody(request);
    const job = await enqueueJob({ root, sessionId: body.session_id, runtime: body.runtime });
    sendJson(response, 202, job);
    return;
  }
  if (request.method === 'GET' && url.pathname.startsWith('/api/jobs/')) {
    sendJson(response, 200, await readJob({ root, jobId: decodeURIComponent(url.pathname.slice('/api/jobs/'.length)) }));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/jobs') {
    sendJson(response, 200, { jobs: await listJobs({ root }) });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/sessions') {
    sendJson(response, 200, await listSessions({ root }));
    return;
  }
  if (request.method === 'GET' && url.pathname.startsWith('/api/sessions/')) {
    sendJson(response, 200, await getSessionDetail({ root, sessionId: decodeURIComponent(url.pathname.slice('/api/sessions/'.length)) }));
    return;
  }
  if (request.method === 'POST' && url.pathname.match(/^\/api\/sessions\/[^/]+\/apply$/)) {
    const sessionId = decodeURIComponent(url.pathname.split('/')[3]);
    const body = await readJsonBody(request);
    sendJson(response, 200, await applyEditedApprovedUpdate({ root, sessionId, approval: body }));
    return;
  }
  if (request.method === 'GET' && (url.pathname === '/sessions' || url.pathname.startsWith('/sessions/') || url.pathname === '/')) {
    const html = await fs.readFile(uiPath, 'utf8');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
    return;
  }
  sendJson(response, 404, { error: 'Not found' });
}

async function readJsonBody(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : {};
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

async function writeServiceFiles({ root, url }) {
  const paths = resolveServicePaths({ root });
  await fs.mkdir(paths.serviceDir, { recursive: true });
  await fs.writeFile(paths.serviceUrlPath, `${url}\n`);
  await fs.writeFile(paths.servicePidPath, `${process.pid}\n`);
}
```

- [ ] **Step 4: Implement service CLI**

Create `scripts/evo-bypassd.js`:

```js
#!/usr/bin/env node
import { startServiceServer } from '../src/service/server.js';
import { readBypassConfig } from '../src/core/config.js';

const args = parseArgs(process.argv.slice(2));
const root = args.root || process.cwd();
const config = await readBypassConfig({ root });
const service = await startServiceServer({
  root,
  host: args.host || config.service.host,
  port: args.port ? Number(args.port) : config.service.port
});

console.log(service.url);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith('--')) {
      parsed[argv[index].slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return parsed;
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
node --test test/service-server.test.js
```

Expected: may fail until Task 7 creates `apply-edited-update.js`. If so, create a temporary exported stub:

```js
export async function applyEditedApprovedUpdate() {
  throw new Error('apply endpoint is not implemented yet');
}
```

Then rerun and expect PASS for health/jobs/UI routes.

- [ ] **Step 6: Commit**

```bash
git add src/service/server.js scripts/evo-bypassd.js src/viewer/session-store.js test/service-server.test.js src/service/apply-edited-update.js
git commit -m "feat: serve async review service APIs"
```

---

### Task 7: Edited Approval Apply Flow

**Files:**
- Create/Modify: `src/service/apply-edited-update.js`
- Modify: `src/apply-approved-update.js`
- Test: `test/apply-approved-update.test.js`
- Test: `test/service-apply.test.js`

- [ ] **Step 1: Add failing test for edited text**

Append to `test/apply-approved-update.test.js`:

```js
test('applyApprovedUpdate uses edited action proposed_text from approval', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const paths = resolveSessionPaths({ root, sessionId: 'sess_apply_edited' });
  await fs.mkdir(paths.sessionDir, { recursive: true });
  await fs.writeFile(paths.retrospectivePath, JSON.stringify({
    session_id: 'sess_apply_edited',
    summary: 'Found one action.',
    retrospective: {
      outcome: 'completed',
      quality: 'minor_issues',
      findings: [{
        id: 'finding_edit',
        category: 'knowledge',
        severity: 'medium',
        evidence: ['evt_1'],
        diagnosis: 'Reusable convention.',
        recommendation: 'Save it.',
        action: {
          type: 'update_knowledge',
          confidence: 'high',
          target: paths.defaultKnowledgePath,
          proposed_text: 'Original text should not be written.',
          rationale: 'Retrospective is authoritative.'
        }
      }]
    }
  }));
  await fs.writeFile(paths.approvalPath, JSON.stringify({
    approved_at: new Date().toISOString(),
    approved_suggestion_ids: ['finding_edit'],
    approval_text: 'approved edited',
    edited_actions: {
      finding_edit: { proposed_text: 'Edited project convention text.' }
    }
  }));

  await applyApprovedUpdate({ root, sessionId: 'sess_apply_edited' });
  const knowledge = await fs.readFile(paths.defaultKnowledgePath, 'utf8');
  assert.match(knowledge, /Edited project convention text/);
  assert.equal(knowledge.includes('Original text should not be written'), false);
});
```

- [ ] **Step 2: Create service apply endpoint test**

Create `test/service-apply.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveSessionPaths } from '../src/core/session-paths.js';
import { applyEditedApprovedUpdate } from '../src/service/apply-edited-update.js';

test('applyEditedApprovedUpdate writes approval and applies edited selected action', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-service-apply-'));
  const paths = resolveSessionPaths({ root, sessionId: 'sess_service_apply' });
  await fs.mkdir(paths.sessionDir, { recursive: true });
  await fs.writeFile(paths.retrospectivePath, JSON.stringify({
    session_id: 'sess_service_apply',
    retrospective: {
      outcome: 'completed',
      quality: 'minor_issues',
      findings: [{
        id: 'finding_keep',
        category: 'knowledge',
        severity: 'medium',
        evidence: ['evt_1'],
        diagnosis: 'Keep.',
        recommendation: 'Apply.',
        action: {
          type: 'update_knowledge',
          confidence: 'high',
          target: paths.defaultKnowledgePath,
          proposed_text: 'Original.',
          rationale: 'Useful.'
        }
      }]
    }
  }));

  const result = await applyEditedApprovedUpdate({
    root,
    sessionId: 'sess_service_apply',
    approval: {
      approved_action_ids: ['finding_keep'],
      approval_text: 'approved in UI',
      edited_actions: { finding_keep: { proposed_text: 'Edited from UI.' } }
    }
  });

  assert.equal(result.applied.length, 1);
  assert.match(await fs.readFile(paths.defaultKnowledgePath, 'utf8'), /Edited from UI/);
  const approval = JSON.parse(await fs.readFile(paths.approvalPath, 'utf8'));
  assert.deepEqual(approval.approved_suggestion_ids, ['finding_keep']);
});
```

- [ ] **Step 3: Run tests and verify they fail**

Run:

```bash
node --test test/apply-approved-update.test.js test/service-apply.test.js
```

Expected: edited text not used and missing service apply module.

- [ ] **Step 4: Modify applyApprovedUpdate to use edited text**

In `src/apply-approved-update.js`, after reading approval, pass approval into validation mapping:

```js
const toApply = updateActions
  .filter((suggestion) => approvedIds.has(suggestion.id))
  .map((suggestion) => validateApprovedSuggestion({
    root: rootPath,
    suggestion: withEditedText({ suggestion, approval })
  }));
```

Add helper:

```js
function withEditedText({ suggestion, approval }) {
  const edited = approval.edited_actions?.[suggestion.id];
  if (!edited || typeof edited.proposed_text !== 'string') {
    return suggestion;
  }
  return { ...suggestion, proposed_text: edited.proposed_text };
}
```

- [ ] **Step 5: Implement service apply wrapper**

Create `src/service/apply-edited-update.js`:

```js
import fs from 'node:fs/promises';
import { resolveSessionPaths } from '../core/session-paths.js';
import { applyApprovedUpdate } from '../apply-approved-update.js';

export async function applyEditedApprovedUpdate({ root = process.cwd(), sessionId, approval }) {
  if (!Array.isArray(approval?.approved_action_ids) || approval.approved_action_ids.length === 0) {
    throw new Error('approved_action_ids is required');
  }
  if (typeof approval.approval_text !== 'string' || approval.approval_text.trim() === '') {
    throw new Error('approval_text is required');
  }
  const normalized = {
    approved_at: new Date().toISOString(),
    approved_suggestion_ids: approval.approved_action_ids,
    approval_text: approval.approval_text,
    edited_actions: normalizeEditedActions(approval.edited_actions)
  };
  const paths = resolveSessionPaths({ root, sessionId });
  await fs.mkdir(paths.sessionDir, { recursive: true });
  await fs.writeFile(paths.approvalPath, `${JSON.stringify(normalized, null, 2)}\n`);
  return applyApprovedUpdate({ root, sessionId });
}

function normalizeEditedActions(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const output = {};
  for (const [id, value] of Object.entries(input)) {
    if (!value || typeof value !== 'object') continue;
    if (typeof value.proposed_text !== 'string' || value.proposed_text.trim() === '') continue;
    output[id] = { proposed_text: value.proposed_text };
  }
  return output;
}
```

- [ ] **Step 6: Run tests**

Run:

```bash
node --test test/apply-approved-update.test.js test/service-apply.test.js test/service-server.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/apply-approved-update.js src/service/apply-edited-update.js test/apply-approved-update.test.js test/service-apply.test.js
git commit -m "feat: apply edited knowledge approvals"
```

---

### Task 8: Real Async Review Web UI

**Files:**
- Modify: `src/viewer/static/index.html`
- Modify: `src/viewer/server.js` or `src/service/server.js` if extra API shape is needed
- Modify: `src/viewer/session-store.js`
- Test: `test/viewer-server.test.js`
- Test: `test/service-server.test.js`

- [ ] **Step 1: Add session store job status test**

Append to `test/viewer-server.test.js`:

```js
test('session detail includes async review job status when job exists', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-viewer-'));
  await writeSession(root, 'sess_job_detail');
  await fs.mkdir(path.join(root, '.bypass', 'jobs'), { recursive: true });
  await fs.writeFile(path.join(root, '.bypass', 'jobs', 'job_sess_job_detail.json'), JSON.stringify({
    id: 'job_sess_job_detail',
    session_id: 'sess_job_detail',
    runtime: 'codex',
    root,
    status: 'succeeded',
    created_at: '2026-06-06T10:00:00.000Z',
    started_at: '2026-06-06T10:00:01.000Z',
    finished_at: '2026-06-06T10:01:01.000Z',
    error: ''
  }));

  const detail = await getSessionDetail({ root, sessionId: 'sess_job_detail' });
  assert.equal(detail.job.status, 'succeeded');
});
```

Import `getSessionDetail` in the test if needed:

```js
import { getSessionDetail } from '../src/viewer/session-store.js';
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
node --test test/viewer-server.test.js
```

Expected: `detail.job` is missing.

- [ ] **Step 3: Add job status to session store**

Modify `src/viewer/session-store.js`:

```js
import { readJob } from '../service/job-store.js';
```

In `getSessionDetail`, add:

```js
const job = await readSessionJob({ root, sessionId });
```

Return it:

```js
job,
```

Add helper:

```js
async function readSessionJob({ root, sessionId }) {
  try {
    return await readJob({ root, jobId: `job_${sessionId}` });
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    return undefined;
  }
}
```

In `toSummary`, include:

```js
job_status: detail.job?.status || 'none',
```

- [ ] **Step 4: Replace viewer static UI with productionized prototype**

Use `prototype/async-review-service/index.html` as the visual source, but replace hard-coded arrays with existing API calls:

```js
async function loadDetail(sessionId) {
  const detail = await api(`/api/sessions/${encodeURIComponent(sessionId)}`);
  state.detail = detail;
  renderDetail();
}
```

Render approval actions from:

```js
const actions = detail.retrospective.retrospective.findings
  .filter((finding) => finding.action?.type === 'update_knowledge');
```

Apply edited actions:

```js
async function applySelectedActions() {
  const actions = selectedActionPayload();
  const response = await fetch(`/api/sessions/${encodeURIComponent(state.detail.session_id)}/apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      approved_action_ids: actions.map((action) => action.id),
      approval_text: 'Approved from Evo Bypass web UI',
      edited_actions: Object.fromEntries(actions.map((action) => [action.id, { proposed_text: action.proposed_text }]))
    })
  });
  if (!response.ok) throw new Error(`Apply failed with ${response.status}`);
  state.applyResult = await response.json();
  await loadDetail(state.detail.session_id);
}
```

Keep the prototype's layout and visual hierarchy:

- left service health rail
- center review timeline/evidence
- right editable approval drawer

- [ ] **Step 5: Run server tests**

Run:

```bash
node --test test/viewer-server.test.js test/service-server.test.js
```

Expected: PASS.

- [ ] **Step 6: Manually verify UI**

Run:

```bash
node scripts/evo-bypassd.js --root "$PWD" --port 8765
```

Open:

```text
http://127.0.0.1:8765/sessions
```

Expected: UI renders the async review console style and no console errors are visible.

- [ ] **Step 7: Commit**

```bash
git add src/viewer/static/index.html src/viewer/session-store.js src/viewer/server.js test/viewer-server.test.js test/service-server.test.js
git commit -m "feat: add async review approval UI"
```

---

### Task 9: Integration, Installer, and Documentation

**Files:**
- Modify: `README.md`
- Modify: `scripts/install-hooks.js`
- Modify: `test/install-hooks.test.js`
- Create: `test/e2e-async-review-service.test.js`

- [ ] **Step 1: Write e2e service test**

Create `test/e2e-async-review-service.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectEvent } from '../src/collect-event.js';
import { startServiceServer } from '../src/service/server.js';
import { enqueueReviewJob } from '../src/service/service-client.js';
import { resolveSessionPaths } from '../src/core/session-paths.js';

test('async service accepts a session job and exposes session detail', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-e2e-'));
  await collectEvent({ root, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess_e2e', prompt: 'hello' } });
  const service = await startServiceServer({ root, host: '127.0.0.1', port: 0, startWorker: false });
  try {
    const enqueue = await enqueueReviewJob({
      url: service.url,
      job: { session_id: 'sess_e2e', runtime: 'codex', root },
      timeoutMs: 500
    });
    assert.equal(enqueue.enqueued, true);
    const detail = await (await fetch(`${service.url}/api/sessions/sess_e2e`)).json();
    assert.equal(detail.session_id, 'sess_e2e');
    assert.equal(detail.job.status, 'queued');
  } finally {
    await service.close();
  }
});
```

- [ ] **Step 2: Update installer tests for new hook scripts**

Modify `test/install-hooks.test.js` expected hook commands to include:

```text
scripts/session-start-service.js
scripts/enqueue-review-job.js
```

Keep assertions that existing hooks are preserved and duplicate installs are idempotent.

- [ ] **Step 3: Update README**

Add a section:

```md
## Async Local Review Service

Evo Bypass runs review work outside the Stop hook.

- `SessionStart` checks whether the local service is healthy and starts it if needed.
- `Stop` only enqueues a review job when service health is good.
- The worker calls the local runtime reviewer: Codex sessions use `codex exec`; Claude Code sessions use `claude -p`.
- There is no OpenAI-compatible provider in this flow.
- If knowledge updates are proposed, Evo Bypass opens the local Web UI for review.
- Users can edit proposed text before applying.

If the service is unhealthy at Stop time, review enqueue is skipped and the main session is not blocked.
```

- [ ] **Step 4: Run full tests**

Run:

```bash
node --test
```

Expected: PASS.

- [ ] **Step 5: Run smoke check for service CLI**

Run:

```bash
node scripts/evo-bypassd.js --root "$PWD" --port 8765
```

Expected: prints `http://127.0.0.1:8765`. Stop it with Ctrl-C after confirming:

```bash
curl -sf http://127.0.0.1:8765/api/health
```

Expected JSON contains `"name": "evo-bypassd"`.

- [ ] **Step 6: Commit**

```bash
git add README.md scripts/install-hooks.js test/install-hooks.test.js test/e2e-async-review-service.test.js
git commit -m "docs: document async local review service"
```

---

## Self-Review

Spec coverage:

- SessionStart starts service only when health fails: Task 2.
- Stop only enqueues when service is healthy and never starts service: Task 2.
- No OpenAI-compatible provider: Task 4 runner uses only `codex exec` and `claude -p`; Task 9 docs state the constraint.
- No rules fallback: Task 4 and Task 5 fail jobs on reviewer errors.
- Internal invocation guard: Task 1 and Task 4.
- File-backed job store: Task 3.
- Local service APIs: Task 6.
- Browser notification only for `update_knowledge`: Task 5.
- Editable approval UI and apply endpoint: Task 7 and Task 8.
- Reuse Web UI prototype direction: Task 8.
- Existing `.bypass/sessions` model remains source of truth: Tasks 5-8.

Placeholder scan:

- No `TBD`, `TODO`, or "implement later" instructions are present.
- Every code step includes concrete code or exact commands.

Type consistency:

- Job fields use `session_id`, `runtime`, `root`, `status`, `created_at`, `started_at`, `finished_at`, `lease_expires_at`, `error` across tasks.
- Approval endpoint accepts `approved_action_ids`, `approval_text`, and `edited_actions`; stored approval uses existing `approved_suggestion_ids`.
- Runtime names are `codex` and `claude` throughout.
