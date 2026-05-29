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
console.log(formatReport(result));

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

function formatReport(result) {
  if (result.suggestions.length === 0) {
    return 'Knowledge Update Suggestions\n\nNo durable knowledge updates suggested for this session.';
  }

  const lines = [
    'Knowledge Update Suggestions',
    '',
    `I found ${result.suggestions.length} possible knowledge update(s) from this task.`,
    'Ask the user whether they want to apply them before running the updater.',
    ''
  ];

  for (const suggestion of result.suggestions) {
    lines.push(`- ${suggestion.id} [${suggestion.kind}, ${suggestion.confidence}] -> ${suggestion.target}`);
    lines.push(`  Proposed: ${suggestion.proposed_text}`);
    lines.push(`  Evidence: ${suggestion.evidence.join(', ')}`);
  }

  return lines.join('\n');
}
