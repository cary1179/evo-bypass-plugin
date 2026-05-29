#!/usr/bin/env node
import { collectEvent } from '../src/collect-event.js';

const input = await readStdin();
let payload = {};
try {
  payload = input ? JSON.parse(input) : {};
} catch {
  console.error('Invalid hook payload JSON; ignoring event.');
  process.exit(0);
}
if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
  payload = {};
}
const runtimeArgIndex = process.argv.indexOf('--runtime');
if (runtimeArgIndex >= 0 && process.argv[runtimeArgIndex + 1]) {
  payload.runtime = process.argv[runtimeArgIndex + 1];
}
const root = process.cwd();

await collectEvent({ root, payload });

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
