import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSessionPaths } from './session-paths.js';

const DEFAULT_VIEWER = Object.freeze({
  enabled: false,
  openMode: 'url',
  host: '127.0.0.1',
  port: 8765,
  openOnlyWhenSuggestions: true
});

const OPEN_MODES = new Set(['off', 'url', 'browser']);

export async function readBypassConfig({ root = process.cwd() } = {}) {
  const defaultTarget = path.join(root, '.bypass', 'knowledge.md');
  const configPath = path.join(root, '.bypass', 'config.json');
  let rawConfig = {};
  let configError;

  try {
    rawConfig = JSON.parse(await fs.readFile(configPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      rawConfig = {};
    } else if (error instanceof SyntaxError) {
      rawConfig = {};
      configError = new Error(`Invalid JSON in ${configPath}`);
    } else {
      throw error;
    }
  }

  return {
    knowledgeTarget: safeKnowledgeTarget({ root, configuredTarget: rawConfig.knowledgeTarget, defaultTarget }),
    viewer: normalizeViewer(rawConfig.viewer),
    configError
  };
}

export function normalizeViewer(input) {
  const viewer = isObject(input) ? input : {};
  return {
    enabled: typeof viewer.enabled === 'boolean' ? viewer.enabled : DEFAULT_VIEWER.enabled,
    openMode: OPEN_MODES.has(viewer.openMode) ? viewer.openMode : DEFAULT_VIEWER.openMode,
    host: typeof viewer.host === 'string' && viewer.host.trim() ? viewer.host : DEFAULT_VIEWER.host,
    port: Number.isInteger(viewer.port) && viewer.port > 0 && viewer.port <= 65535 ? viewer.port : DEFAULT_VIEWER.port,
    openOnlyWhenSuggestions: typeof viewer.openOnlyWhenSuggestions === 'boolean'
      ? viewer.openOnlyWhenSuggestions
      : DEFAULT_VIEWER.openOnlyWhenSuggestions
  };
}

export function shouldExposeViewer({ viewer, suggestionCount }) {
  if (!viewer?.enabled || viewer.openMode === 'off') {
    return false;
  }
  if (viewer.openOnlyWhenSuggestions && suggestionCount === 0) {
    return false;
  }
  return true;
}

export function safeKnowledgeTarget({ root, configuredTarget, defaultTarget }) {
  if (typeof configuredTarget !== 'string' || configuredTarget.trim() === '') {
    return defaultTarget;
  }

  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(resolvedRoot, configuredTarget);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return resolvedTarget;
  }
  return defaultTarget;
}

export function safeSessionId(sessionId) {
  resolveSessionPaths({ sessionId });
  return sessionId;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
