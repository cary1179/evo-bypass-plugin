#!/usr/bin/env node
import { readBypassConfig } from '../src/core/config.js';
import {
  appendHookLog,
  checkServiceHealth,
  enqueueReviewJob,
  readServiceUrl,
  serviceUrl,
} from '../src/service/service-client.js';

const payload = await readPayload();
const runtime = runtimeArg() || payload.runtime || 'claude';
const sessionId = sessionIdFromPayload(payload);
const root = rootFromPayload(payload);

try {
  if (!sessionId) {
    await appendHookLog({ root, entry: { event: 'enqueue_skipped', reason: 'missing_session_id', runtime } });
    emitContinue();
    process.exit(0);
  }

  const config = await readBypassConfig({ root });
  const url = await readServiceUrl({ root, fallbackUrl: serviceUrl(config.service) });
  const hookTimeoutMs = hookClientTimeoutMs(config);
  const health = await checkServiceHealth({ url, timeoutMs: hookTimeoutMs });
  if (!health.healthy) {
    await appendHookLog({
      root,
      entry: { event: 'service_unhealthy', runtime, sessionId, error: health.error || '' },
    });
    emitContinue();
    process.exit(0);
  }

  const result = await enqueueReviewJob({
    url,
    job: { session_id: sessionId, runtime, root },
    timeoutMs: hookTimeoutMs,
  });
  await appendHookLog({
    root,
    entry: {
      event: result.enqueued ? 'job_enqueued' : 'enqueue_failed',
      runtime,
      sessionId,
      error: result.error || '',
    },
  });
  emitContinue();
} catch (error) {
  await appendHookLog({
    root,
    entry: { event: 'enqueue_error', runtime, sessionId, error: error.message || String(error) },
  });
  emitContinue();
}

async function readPayload() {
  if (process.stdin.isTTY) {
    return {};
  }

  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
  }

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

function sessionIdFromPayload(payload) {
  return payload.session_id
    || payload.sessionId
    || payload.conversation_id
    || payload.thread_id
    || process.env.CLAUDE_SESSION_ID
    || process.env.CODEX_SESSION_ID;
}

function rootFromPayload(payload) {
  return payload.root || payload.cwd || payload.working_directory || payload.workspace || process.cwd();
}

function emitContinue() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

function hookClientTimeoutMs(config) {
  return Math.max(config.service.healthTimeoutMs, 1000);
}
