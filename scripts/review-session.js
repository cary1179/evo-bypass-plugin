#!/usr/bin/env node
import { reviewSession } from '../src/review-session.js';

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
const result = await reviewSession({ root, sessionId });
const report = formatReport(result);
if (isCodexRuntime(payload)) {
  console.log(JSON.stringify({
    continue: result.suggestions.length === 0,
    suppressOutput: false,
    systemMessage: report
  }, null, 2));
} else {
  console.log(report);
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
  const runtimeArgIndex = process.argv.indexOf('--runtime');
  if (runtimeArgIndex >= 0 && process.argv[runtimeArgIndex + 1] === 'codex') {
    return true;
  }
  return payload.runtime === 'codex';
}

function formatReport(result) {
  if (result.suggestions.length === 0) {
    return '本次任务无待更新知识。';
  }

  return `请告知用户：本次任务总结了可更新知识或记忆。请阅读 ${result.suggestion_report_path} 文件，了解根据本次任务总结的知识或记忆，并询问用户是否应用这些建议。`;
}
