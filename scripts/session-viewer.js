#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { startViewerServer, viewerUrl } from '../src/viewer/server.js';

const args = parseArgs(process.argv.slice(2));
const root = args.root || process.cwd();
const host = args.host || '127.0.0.1';
const port = args.port === undefined ? 8765 : Number(args.port);
const sessionId = args.session;
const openMode = args.openMode || 'url';

try {
  const viewer = await startViewerServer({ root, host, port });
  const url = viewerUrl({ host: viewer.host, port: viewer.port, sessionId });
  console.log(url);

  if (openMode === 'browser') {
    openBrowser(url);
  }

  if (args.once) {
    const health = await fetch(`${viewer.url}/api/health`);
    if (!health.ok) {
      throw new Error(`Viewer health check failed with ${health.status}`);
    }
    await viewer.close();
  }
} catch (error) {
  console.error(error.message || String(error));
  process.exitCode = 1;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--once') {
      parsed.once = true;
      continue;
    }
    if (arg.startsWith('--')) {
      parsed[arg.slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return parsed;
}

function openBrowser(url) {
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
}
