import { spawn } from 'node:child_process';
import { viewerUrl } from '../viewer/server.js';

export function notifyKnowledgeReady({ host, port, sessionId, openBrowser = true, opener = openUrl, url } = {}) {
  const resolvedUrl = url || withReadyQuery(viewerUrl({ host, port, sessionId }));
  if (openBrowser) {
    opener(resolvedUrl);
  }
  return { url: resolvedUrl };
}

export function openUrl(url) {
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open';
  const args = process.platform === 'win32'
    ? ['/c', 'start', '', url]
    : [url];

  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore'
  });
  child.on('error', () => {});
  child.unref();
}

function withReadyQuery(url) {
  const parsed = new URL(url);
  parsed.searchParams.set('review', 'ready');
  return parsed.href;
}
