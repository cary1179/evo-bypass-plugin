#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { collectEvent } from '../src/collect-event.js';

const input = await readStdin();
const payload = input ? JSON.parse(input) : {};
const runtimeArgIndex = process.argv.indexOf('--runtime');
if (runtimeArgIndex >= 0 && process.argv[runtimeArgIndex + 1]) {
  payload.runtime = process.argv[runtimeArgIndex + 1];
}
const root = payload.cwd || payload.working_directory || process.cwd();

await collectEvent({ root, payload });

async function readStdin() {
  if (process.stdin.isTTY) {
    return '';
  }
  return readFile(0, 'utf8');
}
