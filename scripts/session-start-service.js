#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBypassConfig } from '../src/core/config.js';
import {
  appendHookLog,
  checkServiceHealth,
  readServiceUrl,
  serviceUrl,
  startServiceDetached,
} from '../src/service/service-client.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const payload = await readPayload();
const root = rootFromPayload(payload);
const runtime = runtimeArg() || payload.runtime || 'claude';

try {
  const config = await readBypassConfig({ root });
  if (!config.service.enabled) {
    emitContinue();
    process.exit(0);
  }

  const url = await readServiceUrl({ root, fallbackUrl: serviceUrl(config.service) });
  const health = await checkServiceHealth({ url, timeoutMs: hookClientTimeoutMs(config) });
  if (health.healthy) {
    emitContinue();
    process.exit(0);
  }

  const start = startServiceDetached({
    root,
    scriptPath: path.join(repoRoot, 'scripts', 'evo-bypassd.js'),
    env: { ...process.env, EVO_BYPASS_STARTED_BY: 'SessionStart', EVO_BYPASS_RUNTIME: runtime },
  });
  if (!start.started) {
    await appendHookLog({
      root,
      file: 'service/session-start.log',
      entry: { event: 'service_start_unavailable', runtime, reason: start.reason, scriptPath: start.scriptPath || '' },
    });
    emitContinue();
    process.exit(0);
  }

  await appendHookLog({
    root,
    file: 'service/session-start.log',
    entry: { event: 'service_start_requested', runtime, pid: start.pid },
  });
  emitContinue();
} catch (error) {
  await appendHookLog({
    root,
    file: 'service/session-start.log',
    entry: { event: 'service_start_error', runtime, error: error.message || String(error) },
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

function rootFromPayload(payload) {
  return payload.root || payload.cwd || payload.working_directory || payload.workspace || process.cwd();
}

function emitContinue() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

function hookClientTimeoutMs(config) {
  return Math.max(config.service.healthTimeoutMs, 1000);
}
