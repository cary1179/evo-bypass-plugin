import { randomUUID } from 'node:crypto';
import { redactSecrets } from './redact.js';

const HOOKS = new Set(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PermissionRequest', 'Stop']);
const STATUSES = new Set(['success', 'failure', 'unknown']);

export function normalizeEvent(input) {
  const sessionId = stringOrThrow(input.sessionId, 'sessionId');
  const hook = HOOKS.has(input.hook) ? input.hook : 'PostToolUse';
  const status = STATUSES.has(input.status) ? input.status : 'unknown';

  return {
    id: input.id || `evt_${randomUUID()}`,
    session_id: sessionId,
    timestamp: input.timestamp || new Date().toISOString(),
    hook,
    tool: typeof input.tool === 'string' && input.tool ? input.tool : 'Other',
    summary: truncate(redactSecrets(input.summary || 'No summary provided'), 500),
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

function truncate(value, maxLength) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}
