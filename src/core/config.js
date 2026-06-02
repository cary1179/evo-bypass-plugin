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
const REVIEWER_MODES = new Set(['rules', 'ai', 'auto']);
const REVIEWER_FALLBACKS = new Set(['rules', 'none']);
const PROVIDER_TYPES = new Set(['openai-compatible']);

const DEFAULT_REVIEWER = Object.freeze({
  mode: 'rules',
  fallback: 'rules',
  timeoutMs: 120000,
  provider: undefined
});

export async function readBypassConfig({ root = process.cwd() } = {}) {
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
    knowledgeTarget: safeKnowledgeTarget({ root, configuredTarget: rawConfig.knowledgeTarget }),
    viewer: normalizeViewer(rawConfig.viewer),
    reviewer: normalizeReviewer(rawConfig.reviewer),
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

export function normalizeReviewer(input) {
  const reviewer = isObject(input) ? input : {};
  return {
    mode: REVIEWER_MODES.has(reviewer.mode) ? reviewer.mode : DEFAULT_REVIEWER.mode,
    fallback: REVIEWER_FALLBACKS.has(reviewer.fallback) ? reviewer.fallback : DEFAULT_REVIEWER.fallback,
    timeoutMs: Number.isInteger(reviewer.timeoutMs) && reviewer.timeoutMs > 0
      ? reviewer.timeoutMs
      : DEFAULT_REVIEWER.timeoutMs,
    provider: normalizeProvider(reviewer.provider)
  };
}

function normalizeProvider(input) {
  const provider = isObject(input) ? input : {};
  if (!PROVIDER_TYPES.has(provider.type) || typeof provider.baseUrl !== 'string' || provider.baseUrl.trim() === '') {
    return undefined;
  }

  const model = typeof provider.model === 'string' && provider.model.trim() ? provider.model.trim() : '';
  if (!model) {
    return undefined;
  }

  const normalized = {
    type: provider.type,
    baseUrl: provider.baseUrl.trim().replace(/\/+$/, ''),
    apiKey: typeof provider.apiKey === 'string' && provider.apiKey.trim() ? provider.apiKey.trim() : undefined,
    apiKeyEnv: typeof provider.apiKeyEnv === 'string' && provider.apiKeyEnv.trim() ? provider.apiKeyEnv.trim() : undefined,
    model
  };

  if (!normalized.apiKey && !normalized.apiKeyEnv) {
    return undefined;
  }
  return normalized;
}

export function safeKnowledgeTarget({ root, configuredTarget }) {
  if (typeof configuredTarget !== 'string' || configuredTarget.trim() === '') {
    return undefined;
  }

  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(resolvedRoot, configuredTarget);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return resolvedTarget;
  }
  return undefined;
}

export function safeSessionId(sessionId) {
  resolveSessionPaths({ sessionId });
  return sessionId;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
