import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveSessionPaths } from './core/session-paths.js';
import { normalizeRetrospectiveResult, extractKnowledgeActions } from './core/retrospective-schema.js';
import { readBypassConfig } from './core/config.js';
import { routeKnowledgeTarget } from './knowledge-routing.js';
import { reviewWithAiProvider } from './ai-reviewer.js';
import { extractReusableProjectConvention } from './project-convention.js';

export async function reviewSession({ root = process.cwd(), sessionId, bypassDir = defaultBypassDir() }) {
  const paths = resolveSessionPaths({ root, sessionId });
  const { events, malformedCount } = await readEvents(paths.eventsPath);
  const config = await readBypassConfig({ root: paths.root });
  const candidates = await buildCandidates({ root: paths.root, events, configuredTarget: config.knowledgeTarget });
  const reviewed = await reviewRetrospective({ root: paths.root, sessionId, events, candidates, reviewer: config.reviewer });
  const result = normalizeRetrospectiveResult(reviewed);
  result.retrospective_report_path = await writeRetrospectiveReport({ bypassDir, result });
  const legacyResult = withLegacySuggestionCompatibility(result);

  await fs.mkdir(paths.sessionDir, { recursive: true });
  await fs.writeFile(paths.retrospectivePath, `${JSON.stringify(result, null, 2)}\n`);
  // Legacy compatibility view until apply-approved-update reads retrospective.json directly.
  await fs.writeFile(paths.suggestionsPath, `${JSON.stringify(legacySuggestionView(legacyResult), null, 2)}\n`);
  await fs.writeFile(paths.retrospectiveMarkdownPath, formatRetrospectiveMarkdown(result));
  await fs.writeFile(paths.reviewerLogPath, reviewerLog({ result, malformedCount }));
  return legacyResult;
}

async function buildCandidates({ root, events, configuredTarget }) {
  const candidates = [];
  for (const event of events) {
    const route = await routeKnowledgeTarget({ root, event, configuredTarget });
    candidates.push({
      event_id: event.id,
      target: route.target,
      target_reason: route.target_reason
    });
  }
  return candidates;
}

async function reviewRetrospective({ root, sessionId, events, candidates, reviewer }) {
  if (shouldUseAiReviewer(reviewer)) {
    try {
      return await reviewWithAiProvider({ root, sessionId, events, candidates, reviewer });
    } catch {
      if (reviewer.fallback !== 'rules') {
        return { sessionId, findings: [] };
      }
    }
  }

  if (reviewer.mode === 'ai' && reviewer.fallback !== 'rules') {
    return { sessionId, findings: [] };
  }
  return reviewWithRules({ sessionId, events, candidates });
}

function shouldUseAiReviewer(reviewer) {
  if (!reviewer?.provider) {
    return false;
  }
  return reviewer.mode === 'ai' || reviewer.mode === 'auto';
}

function reviewWithRules({ sessionId, events, candidates }) {
  const findings = [];
  const routeByEventId = new Map(candidates.map((candidate) => [candidate.event_id, candidate]));
  for (const event of events) {
    findings.push(...findingsForEvent(event, routeByEventId.get(event.id)));
  }
  return { sessionId, findings: dedupeFindings(findings).slice(0, 10) };
}

function defaultBypassDir() {
  return process.env.EVO_BYPASS_DIR || path.join(os.homedir(), '.bypass');
}

async function writeRetrospectiveReport({ bypassDir, result }) {
  const reportDir = path.join(bypassDir, 'retrospective');
  const reportPath = path.join(reportDir, `${result.session_id}.md`);
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(reportPath, formatRetrospectiveMarkdown(result));
  return reportPath;
}

function formatRetrospectiveMarkdown(result) {
  const findings = result.retrospective.findings;
  const lines = [
    '# Session Retrospective',
    '',
    `Session: ${result.session_id}`,
    '',
    '## Task Status',
    '',
    `- Outcome: ${result.retrospective.outcome}`,
    `- Quality: ${result.retrospective.quality}`,
    `- Summary: ${result.summary}`,
    '',
    '## Findings'
  ];

  if (findings.length === 0) {
    lines.push('');
    lines.push('No significant failures or reusable improvements were detected.');
  }

  for (const finding of findings) {
    lines.push('');
    lines.push(`### ${finding.id}`);
    lines.push('');
    lines.push(`- Category: ${finding.category}`);
    lines.push(`- Severity: ${finding.severity}`);
    lines.push(`- Evidence: ${finding.evidence.join(', ')}`);
    lines.push(`- Diagnosis: ${finding.diagnosis}`);
    lines.push(`- Recommendation: ${finding.recommendation}`);
  }

  lines.push('');
  lines.push('## Recommended Actions');

  if (findings.length === 0) {
    lines.push('');
    lines.push('No action recommended.');
  }

  for (const finding of findings) {
    lines.push('');
    lines.push(`### ${finding.action.type}`);
    lines.push('');
    lines.push(`- Confidence: ${finding.action.confidence}`);
    if (finding.action.target) {
      lines.push(`- Target: ${finding.action.target}`);
    }
    if (finding.action.target_reason) {
      lines.push(`- Target reason: ${finding.action.target_reason}`);
    }
    if (finding.action.rationale) {
      lines.push(`- Rationale: ${finding.action.rationale}`);
    }
    if (finding.action.proposed_text) {
      lines.push('');
      lines.push('Proposed text:');
      lines.push('');
      lines.push(finding.action.proposed_text);
    }
  }

  return `${lines.join('\n')}\n`;
}

async function readEvents(eventsPath) {
  try {
    const content = await fs.readFile(eventsPath, 'utf8');
    const events = [];
    let malformedCount = 0;
    for (const line of content.trim().split('\n').filter(Boolean)) {
      try {
        events.push(JSON.parse(line));
      } catch {
        malformedCount += 1;
      }
    }
    return { events, malformedCount };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { events: [], malformedCount: 0 };
    }
    throw error;
  }
}

function findingsForEvent(event, route) {
  const evidence = Array.isArray(event.evidence) ? event.evidence : [];
  const signals = Array.isArray(event.signals) ? event.signals : [];
  const text = `${event.summary}\n${evidence.join('\n')}`;
  const knowledgeText = extractReusableProjectConvention(text);
  const hasConventionCue = signals.includes('project_convention')
    || /project convention|项目(?:约定|规范|规则)|项目中?的?规则/iu.test(text);
  if (hasConventionCue && knowledgeText) {
    return [{
      id: `finding_${event.id}`,
      category: 'knowledge',
      severity: 'medium',
      evidence: [event.id],
      diagnosis: 'The session included explicit convention evidence that may affect future work in this repository.',
      recommendation: 'Ask whether to save this convention to the routed knowledge file.',
      action: {
        type: 'update_knowledge',
        confidence: 'medium',
        target: route.target,
        target_reason: route.target_reason,
        proposed_text: knowledgeText,
        rationale: 'Future sessions can reuse this project convention.'
      }
    }];
  }
  if (signals.includes('test_failure')) {
    return [{
      id: `finding_${event.id}`,
      category: 'code',
      severity: 'low',
      evidence: [event.id],
      diagnosis: `Observed test failure during review: ${event.summary}`,
      recommendation: 'Inspect the failing test output and improve the code or test setup before considering the task complete.',
      action: {
        type: 'improve_code',
        confidence: 'low',
        rationale: 'The session recorded a test failure rather than reusable knowledge.'
      }
    }];
  }
  return [];
}

function dedupeFindings(findings) {
  const seen = new Set();
  const deduped = [];
  for (const finding of findings) {
    const key = [
      finding.category,
      finding.action?.type,
      finding.action?.target,
      finding.action?.proposed_text,
      finding.diagnosis
    ].join('\0');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(finding);
  }
  return deduped;
}

function reviewerLog({ result, malformedCount }) {
  const findingCount = result.retrospective.findings.length;
  const knowledgeActionCount = extractKnowledgeActions(result).length;
  const lines = [
    result.summary,
    `Finding count: ${findingCount}`,
    `Knowledge action count: ${knowledgeActionCount}`,
    `Malformed event line count: ${malformedCount}`
  ];
  if (malformedCount > 0) {
    lines.push(`Skipped ${malformedCount} malformed event line(s).`);
  }
  return `${lines.join('\n')}\n`;
}

// Temporary bridge for the current Stop CLI until its output is migrated to retrospectives.
function withLegacySuggestionCompatibility(result) {
  const suggestions = extractKnowledgeActions(result).map((finding) => ({
    id: finding.id,
    kind: 'project_convention',
    confidence: finding.action.confidence,
    target: finding.action.target,
    target_reason: finding.action.target_reason,
    evidence: finding.evidence,
    proposed_text: finding.action.proposed_text,
    rationale: finding.action.rationale || ''
  }));
  Object.defineProperty(result, 'suggestions', {
    value: suggestions,
    enumerable: false
  });
  Object.defineProperty(result, 'suggestion_report_path', {
    value: result.retrospective_report_path,
    enumerable: false
  });
  return result;
}

function legacySuggestionView(result) {
  return {
    session_id: result.session_id,
    summary: result.summary,
    suggestions: result.suggestions,
    suggestion_report_path: result.suggestion_report_path
  };
}
