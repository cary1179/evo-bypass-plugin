import { randomUUID } from 'node:crypto';

const OUTCOMES = new Set(['completed', 'partial', 'failed', 'unknown']);
const QUALITIES = new Set(['smooth', 'minor_issues', 'significant_issues']);
const CATEGORIES = new Set(['knowledge', 'skill', 'code', 'agent_usage', 'environment']);
const SEVERITIES = new Set(['low', 'medium', 'high']);
const ACTION_TYPES = new Set(['update_knowledge', 'create_skill', 'improve_code', 'adjust_agent_usage', 'fix_environment', 'no_action']);
const CONFIDENCES = new Set(['low', 'medium', 'high']);

export function normalizeRetrospectiveResult(input) {
  const sessionId = requiredString(input.sessionId || input.session_id, 'sessionId');
  const findings = Array.isArray(input.findings)
    ? input.findings.map(normalizeFinding).filter(Boolean)
    : Array.isArray(input.retrospective?.findings)
      ? input.retrospective.findings.map(normalizeFinding).filter(Boolean)
      : [];
  const outcome = OUTCOMES.has(input.outcome || input.retrospective?.outcome)
    ? (input.outcome || input.retrospective.outcome)
    : inferOutcome(findings);
  const quality = QUALITIES.has(input.quality || input.retrospective?.quality)
    ? (input.quality || input.retrospective.quality)
    : inferQuality(findings);
  const summary = typeof input.summary === 'string' && input.summary.trim()
    ? input.summary.trim()
    : defaultSummary({ findings });

  return {
    session_id: sessionId,
    summary,
    retrospective: {
      outcome,
      quality,
      findings
    }
  };
}

export function extractKnowledgeActions(result) {
  return (result?.retrospective?.findings || [])
    .filter((finding) => finding.action?.type === 'update_knowledge');
}

function normalizeFinding(finding) {
  if (!finding || typeof finding !== 'object') {
    return undefined;
  }
  if (!CATEGORIES.has(finding.category) || !SEVERITIES.has(finding.severity)) {
    return undefined;
  }
  const action = normalizeAction(finding.action);
  if (!action) {
    return undefined;
  }
  const normalized = {
    id: typeof finding.id === 'string' && finding.id.trim() ? finding.id.trim() : `finding_${randomUUID()}`,
    category: finding.category,
    severity: finding.severity,
    evidence: arrayOfStrings(finding.evidence),
    diagnosis: stringField(finding.diagnosis),
    recommendation: stringField(finding.recommendation),
    action
  };
  if (normalized.evidence.length === 0 || !normalized.diagnosis || !normalized.recommendation) {
    return undefined;
  }
  return normalized;
}

function normalizeAction(action) {
  if (!action || typeof action !== 'object' || !ACTION_TYPES.has(action.type)) {
    return undefined;
  }
  const normalized = {
    type: action.type,
    confidence: CONFIDENCES.has(action.confidence) ? action.confidence : 'low'
  };
  for (const field of ['target', 'target_reason', 'proposed_text', 'rationale']) {
    if (typeof action[field] === 'string' && action[field].trim()) {
      normalized[field] = action[field].trim();
    }
  }
  if (normalized.type === 'update_knowledge' && (!normalized.target || !normalized.proposed_text)) {
    return undefined;
  }
  return normalized;
}

function inferOutcome(findings) {
  return findings.some((finding) => finding.severity === 'high') ? 'partial' : 'completed';
}

function inferQuality(findings) {
  if (findings.some((finding) => finding.severity === 'high')) {
    return 'significant_issues';
  }
  if (findings.length > 0) {
    return 'minor_issues';
  }
  return 'smooth';
}

function defaultSummary({ findings }) {
  return findings.length === 0
    ? 'No retrospective actions were suggested for this session.'
    : `Found ${findings.length} retrospective action(s).`;
}

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()) : [];
}

function stringField(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}
