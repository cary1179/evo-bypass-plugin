import path from 'node:path';
import { normalizeRetrospectiveResult } from '../core/retrospective-schema.js';

const OUTCOMES = new Set(['completed', 'partial', 'failed', 'unknown']);
const QUALITIES = new Set(['smooth', 'minor_issues', 'significant_issues']);
const CATEGORIES = new Set(['knowledge', 'skill', 'code', 'agent_usage', 'environment']);
const SEVERITIES = new Set(['low', 'medium', 'high']);
const ACTION_TYPES = new Set(['update_knowledge', 'create_skill', 'improve_code', 'adjust_agent_usage', 'fix_environment', 'no_action']);
const CONFIDENCES = new Set(['low', 'medium', 'high']);

export function validateReviewerResult({ root, parsed, events = [], candidates = [] }) {
  if (!Array.isArray(parsed?.retrospective?.findings)) {
    throw new Error('reviewer result must include retrospective.findings array');
  }

  validateOptionalEnum(parsed.retrospective.outcome, OUTCOMES, 'retrospective outcome');
  validateOptionalEnum(parsed.retrospective.quality, QUALITIES, 'retrospective quality');

  const eventIds = new Set(events.map((event) => event?.id).filter((id) => typeof id === 'string' && id));
  const candidateTargets = new Set(candidates.map((candidate) => candidate?.target).filter((target) => typeof target === 'string' && target));
  const normalizedFindings = parsed.retrospective.findings.map((finding) => {
    validateFinding({ root, finding, eventIds, candidateTargets });
    return normalizeFindingTarget({ root, finding });
  });

  return normalizeRetrospectiveResult({
    sessionId: parsed.session_id || parsed.sessionId || 'unknown',
    summary: parsed.summary,
    outcome: parsed.retrospective.outcome,
    quality: parsed.retrospective.quality,
    findings: normalizedFindings
  });
}

function validateFinding({ root, finding, eventIds, candidateTargets }) {
  if (!finding || typeof finding !== 'object') {
    throw new Error('finding must be an object');
  }
  validateRequiredString(finding.id, 'finding id');
  validateRequiredEnum(finding.category, CATEGORIES, 'finding category');
  validateRequiredEnum(finding.severity, SEVERITIES, 'finding severity');
  if (!Array.isArray(finding.evidence) || finding.evidence.length === 0) {
    throw new Error('finding evidence is required');
  }
  for (const id of finding.evidence) {
    if (typeof id !== 'string' || !eventIds.has(id)) {
      throw new Error(`unknown evidence id: ${id}`);
    }
  }
  validateRequiredString(finding.diagnosis, 'finding diagnosis');
  validateRequiredString(finding.recommendation, 'finding recommendation');

  const action = finding.action;
  if (!action || typeof action !== 'object') {
    throw new Error('finding action is required');
  }
  validateRequiredEnum(action.type, ACTION_TYPES, 'action type');
  validateRequiredEnum(action.confidence, CONFIDENCES, 'action confidence');

  if (action.type === 'update_knowledge') {
    validateUpdateKnowledgeAction({ root, action, candidateTargets });
  }
}

function validateUpdateKnowledgeAction({ root, action, candidateTargets }) {
  if (typeof action.target !== 'string' || action.target.trim() === '') {
    throw new Error('update_knowledge target is required');
  }
  if (typeof action.proposed_text !== 'string' || action.proposed_text.trim() === '') {
    throw new Error('update_knowledge proposed_text is required');
  }
  if (!candidateTargets.has(action.target)) {
    throw new Error('update_knowledge target must match a candidate');
  }

  const rootPath = path.resolve(root);
  const targetPath = resolveTarget({ root: rootPath, target: action.target });
  const relative = path.relative(rootPath, targetPath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('update_knowledge target must stay inside root');
  }
}

function normalizeFindingTarget({ root, finding }) {
  if (finding.action?.type !== 'update_knowledge') {
    return finding;
  }
  return {
    ...finding,
    action: {
      ...finding.action,
      target: resolveTarget({ root, target: finding.action.target })
    }
  };
}

function resolveTarget({ root, target }) {
  return path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(root, target);
}

function validateRequiredEnum(value, allowed, name) {
  if (!allowed.has(value)) {
    throw new Error(`invalid ${name}`);
  }
}

function validateRequiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
}

function validateOptionalEnum(value, allowed, name) {
  if (value !== undefined && !allowed.has(value)) {
    throw new Error(`invalid ${name}`);
  }
}
