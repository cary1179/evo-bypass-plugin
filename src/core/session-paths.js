import path from 'node:path';

export function resolveSessionPaths({ root = process.cwd(), sessionId }) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('sessionId is required');
  }
  if (sessionId === '.' || sessionId === '..' || !/^[A-Za-z0-9_.-]+$/.test(sessionId)) {
    throw new Error('sessionId must be a safe path segment');
  }

  const bypassDir = path.join(root, '.bypass');
  const sessionDir = path.join(bypassDir, 'sessions', sessionId);

  return {
    root,
    bypassDir,
    configPath: path.join(bypassDir, 'config.json'),
    defaultKnowledgePath: path.join(bypassDir, 'knowledge.md'),
    sessionDir,
    metadataPath: path.join(sessionDir, 'metadata.json'),
    eventsPath: path.join(sessionDir, 'events.jsonl'),
    suggestionsPath: path.join(sessionDir, 'suggestions.json'),
    approvalPath: path.join(sessionDir, 'approval.json'),
    appliedPatchPath: path.join(sessionDir, 'applied.patch'),
    reviewerLogPath: path.join(sessionDir, 'reviewer.log')
  };
}
