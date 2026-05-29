import { randomUUID } from 'node:crypto';
import { redactSecrets } from './redact.js';

const HOOKS = new Set(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Stop']);
const STATUSES = new Set(['success', 'failure', 'unknown']);

export function normalizeEvent(input) {
  const sessionId = stringOrThrow(input.sessionId, 'sessionId');
  const hook = HOOKS.has(input.hook) ? input.hook : 'PostToolUse';
  const status = STATUSES.has(input.status) ? input.status : 'unknown';

  return {
    id: nonEmptyString(input.id) || `evt_${randomUUID()}`,
    session_id: sessionId,
    timestamp: nonEmptyString(input.timestamp) || new Date().toISOString(),
    hook,
    tool: typeof input.tool === 'string' && input.tool ? input.tool : 'Other',
    summary: truncate(redactSecrets(summaryString(input.summary)), 500),
    paths: arrayOfStrings(input.paths),
    status,
    signals: arrayOfStrings(input.signals),
    evidence: arrayOfStrings(input.evidence).map((item) => truncate(redactSecrets(item), 500))
  };
}

export function normalizeSuggestion(input, fallbackTarget) {
  return {
    id: input.id || `sug_${randomUUID()}`,
    kind: input.kind,
    confidence: input.confidence,
    target: input.target || fallbackTarget,
    evidence: arrayOfStrings(input.evidence),
    proposed_text: String(input.proposed_text || '').trim(),
    rationale: String(input.rationale || '').trim()
  };
}

function stringOrThrow(value, name) {
  if (!value || typeof value !== 'string') {
    throw new Error(`${name} is required`);
  }
  return value;
}

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.length > 0) : [];
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : '';
}

function summaryString(value) {
  if (value === undefined || value === null || value === '') {
    return 'No summary provided';
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' ? json : String(value);
  } catch {
    return String(value);
  }
}

function truncate(value, maxLength) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}
