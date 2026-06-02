#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { reviewSession } from '../src/review-session.js';
import { readBypassConfig, shouldExposeViewer } from '../src/core/config.js';
import { viewerUrl } from '../src/viewer/server.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const input = await readStdin();
let payload = {};
try {
  payload = input ? JSON.parse(input) : {};
} catch {
  console.error('Invalid reviewer payload JSON; ignoring stdin.');
}
if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
  payload = {};
}
const sessionId = firstNonFlagArg()
  || payload.session_id
  || payload.sessionId
  || payload.conversation_id
  || payload.thread_id
  || process.env.CLAUDE_SESSION_ID
  || process.env.CODEX_SESSION_ID;
if (!sessionId) {
  console.error('Usage: scripts/review-session.js <session-id>');
  process.exit(0);
}

const root = payload.cwd || payload.working_directory || payload.workspace || process.cwd();
const runtime = hookRuntime(payload);
await appendStopHookLog({ root, runtime, sessionId, event: 'stop_hook_start' });
try {
  const result = await reviewSession({ root, sessionId });
  const viewerResult = await maybeStartViewer({ root, sessionId, suggestionCount: result.suggestions.length });
  await appendStopHookLog({
    root,
    runtime,
    sessionId,
    event: 'stop_hook_finish',
    suggestionCount: result.suggestions.length,
    reportPath: result.suggestion_report_path || ''
  });
  const report = formatReport(result, viewerResult);
  if (isCodexRuntime(payload)) {
    console.log(JSON.stringify({
      continue: result.suggestions.length === 0,
      suppressOutput: false,
      systemMessage: report
    }, null, 2));
  } else {
    console.log(report);
  }
} catch (error) {
  await appendStopHookLog({
    root,
    runtime,
    sessionId,
    event: 'stop_hook_error',
    error: error.message || String(error)
  });
  throw error;
}

async function readStdin() {
  if (process.stdin.isTTY) {
    return '';
  }
  process.stdin.setEncoding('utf8');
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input;
}

function firstNonFlagArg() {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--runtime') {
      index += 1;
      continue;
    }
    if (!args[index].startsWith('--')) {
      return args[index];
    }
  }
  return undefined;
}

function isCodexRuntime(payload) {
  return hookRuntime(payload) === 'codex';
}

function hookRuntime(payload) {
  const runtimeArgIndex = process.argv.indexOf('--runtime');
  if (runtimeArgIndex >= 0 && process.argv[runtimeArgIndex + 1]) {
    return process.argv[runtimeArgIndex + 1];
  }
  return payload.runtime || 'claude';
}

async function appendStopHookLog({ root, ...entry }) {
  try {
    const logPath = path.join(root, '.bypass', 'stop-hook.log');
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(logPath, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      cwd: root,
      ...entry
    })}\n`);
  } catch {
    // Stop hook observability should never make the hook itself fail.
  }
}

async function maybeStartViewer({ root, sessionId, suggestionCount }) {
  const config = await readBypassConfig({ root });
  if (!shouldExposeViewer({ viewer: config.viewer, suggestionCount })) {
    return undefined;
  }

  try {
    const url = startViewerProcess({ root, sessionId, viewer: config.viewer });
    return { url };
  } catch (error) {
    return { error: error.message || String(error) };
  }
}

function startViewerProcess({ root, sessionId, viewer }) {
  const viewerScript = process.env.EVO_BYPASS_VIEWER_SCRIPT || path.join(repoRoot, 'scripts', 'session-viewer.js');
  const args = [
    viewerScript,
    '--root',
    root,
    '--host',
    viewer.host,
    '--port',
    String(viewer.port),
    '--session',
    sessionId,
    '--openMode',
    viewer.openMode
  ];

  if (process.env.EVO_BYPASS_VIEWER_ONCE === '1') {
    const result = spawnSync(process.execPath, [...args, '--once'], {
      cwd: root,
      encoding: 'utf8'
    });
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || 'viewer exited with a non-zero status');
    }
    return result.stdout.trim().split(/\r?\n/).at(-1);
  }

  const child = spawn(process.execPath, args, {
    cwd: root,
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  return viewerUrl({ host: viewer.host, port: viewer.port, sessionId });
}

function formatReport(result, viewerResult) {
  if (result.suggestions.length === 0) {
    return withViewerReport('本次任务无待更新知识。', viewerResult);
  }

  return withViewerReport(
    `请告知用户：本次任务总结了可更新知识或记忆。请阅读 ${result.suggestion_report_path} 文件，了解根据本次任务总结的知识或记忆，并询问用户是否应用这些建议。`,
    viewerResult
  );
}

function withViewerReport(report, viewerResult) {
  if (!viewerResult) {
    return report;
  }
  if (viewerResult.url) {
    return `${report}\n\n会话查看器：${viewerResult.url}`;
  }
  if (viewerResult.error) {
    return `${report}\n\n无法启动会话查看器：${viewerResult.error}`;
  }
  return report;
}
