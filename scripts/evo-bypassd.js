#!/usr/bin/env node
import { readBypassConfig } from '../src/core/config.js';
import { startServiceServer } from '../src/service/server.js';

const args = parseArgs(process.argv.slice(2));
const root = args.root || process.cwd();
let service;
let shutdownPromise;

try {
  const config = await readBypassConfig({ root });
  const host = args.host || config.service.host || '127.0.0.1';
  const port = args.port ?? config.service.port ?? 8766;
  service = await startServiceServer({ root, host, port });
  process.once('SIGTERM', () => {
    shutdown(0);
  });
  process.once('SIGINT', () => {
    shutdown(0);
  });
  console.log(service.url);
} catch (error) {
  console.error(error.message || String(error));
  process.exitCode = 1;
}

function shutdown(exitCode) {
  shutdownPromise ??= closeService()
    .catch((error) => {
      console.error(error.message || String(error));
      exitCode = 1;
    })
    .finally(() => {
      process.exit(exitCode);
    });
}

async function closeService() {
  if (service) {
    await service.close();
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      parsed.root = argv[++index];
    } else if (arg === '--host') {
      parsed.host = argv[++index];
    } else if (arg === '--port') {
      const port = Number(argv[++index]);
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        parsed.port = port;
      }
    }
  }
  return parsed;
}
