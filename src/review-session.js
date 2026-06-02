import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveSessionPaths } from './core/session-paths.js';
import { normalizeSuggestion } from './core/event-schema.js';
import { readBypassConfig } from './core/config.js';
import { routeKnowledgeTarget } from './knowledge-routing.js';
import { reviewWithAiProvider } from './ai-reviewer.js';

export async function reviewSession({ root = process.cwd(), sessionId, bypassDir = defaultBypassDir() }) {
  const paths = resolveSessionPaths({ root, sessionId });
  const { events, malformedCount } = await readEvents(paths.eventsPath);
  const config = await readBypassConfig({ root: paths.root });
  const candidates = await buildCandidates({ root: paths.root, events, configuredTarget: config.knowledgeTarget });
  const suggested = await reviewSuggestions({ root: paths.root, sessionId, events, candidates, reviewer: config.reviewer });
  const suggestions = dedupeSuggestions(suggested).slice(0, 10);
  const result = {
    session_id: sessionId,
    summary: suggestions.length > 0
      ? `Found ${suggestions.length} possible knowledge update(s).`
      : 'No durable knowledge updates suggested for this session.',
    suggestions
  };

  if (suggestions.length > 0) {
    result.suggestion_report_path = await writeSuggestionReport({ bypassDir, result });
  }

  await fs.mkdir(paths.sessionDir, { recursive: true });
  await fs.writeFile(paths.suggestionsPath, `${JSON.stringify(result, null, 2)}\n`);
  await fs.writeFile(paths.reviewerLogPath, reviewerLog({ result, malformedCount }));
  return result;
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

async function reviewSuggestions({ root, sessionId, events, candidates, reviewer }) {
  if (shouldUseAiReviewer(reviewer)) {
    try {
      return await reviewWithAiProvider({ root, sessionId, events, candidates, reviewer });
    } catch (error) {
      if (reviewer.fallback !== 'rules') {
        return [];
      }
    }
  }

  if (reviewer.mode === 'ai' && reviewer.fallback !== 'rules') {
    return [];
  }
  return reviewWithRules({ events, candidates });
}

function shouldUseAiReviewer(reviewer) {
  if (!reviewer?.provider) {
    return false;
  }
  return reviewer.mode === 'ai' || reviewer.mode === 'auto';
}

function reviewWithRules({ events, candidates }) {
  const suggestions = [];
  const routeByEventId = new Map(candidates.map((candidate) => [candidate.event_id, candidate]));
  for (const event of events) {
    suggestions.push(...suggestionForEvent(event, routeByEventId.get(event.id)));
  }
  return suggestions;
}

function defaultBypassDir() {
  return process.env.EVO_BYPASS_DIR || path.join(os.homedir(), '.bypass');
}

async function writeSuggestionReport({ bypassDir, result }) {
  const reportDir = path.join(bypassDir, 'suggestion');
  const reportPath = path.join(reportDir, `${result.session_id}.md`);
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(reportPath, formatSuggestionReportMarkdown(result));
  return reportPath;
}

function formatSuggestionReportMarkdown(result) {
  const lines = [
    '# Knowledge Update Suggestions',
    '',
    `Session: ${result.session_id}`,
    '',
    `Found ${result.suggestions.length} possible knowledge update(s) from this task.`,
    '',
    '---'
  ];

  for (const suggestion of result.suggestions) {
    lines.push('');
    lines.push(`## ${suggestion.id}`);
    lines.push('');
    lines.push(`- Kind: ${suggestion.kind || 'unknown'}`);
    lines.push(`- Confidence: ${suggestion.confidence || 'unknown'}`);
    lines.push(`- Target: ${suggestion.target}`);
    lines.push(`- Evidence: ${(suggestion.evidence || []).join(', ')}`);
    if (suggestion.rationale) {
      lines.push(`- Rationale: ${suggestion.rationale}`);
    }
    lines.push('');
    lines.push('Proposed knowledge:');
    lines.push('');
    lines.push(suggestion.proposed_text);
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

function suggestionForEvent(event, route) {
  const evidence = Array.isArray(event.evidence) ? event.evidence : [];
  const signals = Array.isArray(event.signals) ? event.signals : [];
  const text = `${event.summary}\n${evidence.join('\n')}`;
  const knowledgeText = extractKnowledgeText(text);
  if ((signals.includes('project_convention') || /project convention/i.test(text)) && knowledgeText) {
    return [normalizeSuggestion({
      kind: 'project_convention',
      confidence: 'medium',
      target: route.target,
      target_reason: route.target_reason,
      evidence: [event.id],
      proposed_text: knowledgeText,
      rationale: 'The session included explicit convention evidence that may affect future work in this repository.'
    }, route.target)];
  }
  if (signals.includes('test_failure')) {
    return [normalizeSuggestion({
      kind: 'failure_pattern',
      confidence: 'low',
      target: route.target,
      target_reason: route.target_reason,
      evidence: [event.id],
      proposed_text: `Observed test failure pattern: ${event.summary}`,
      rationale: 'The failed command may be useful if the same failure recurs, but it needs user confirmation before saving.'
    }, route.target)];
  }
  return [];
}

function dedupeSuggestions(suggestions) {
  const seen = new Set();
  const deduped = [];
  for (const suggestion of suggestions) {
    const key = [suggestion.kind, suggestion.proposed_text, suggestion.target].join('\0');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(suggestion);
  }
  return deduped;
}

function reviewerLog({ result, malformedCount }) {
  const lines = [result.summary];
  if (malformedCount > 0) {
    lines.push(`Skipped ${malformedCount} malformed event line(s).`);
  }
  return `${lines.join('\n')}\n`;
}

function extractKnowledgeText(text) {
  const labeled = text.match(/Project convention:\s*(.+)/i);
  if (labeled && labeled[1].trim()) {
    return `Project convention: ${labeled[1].trim()}`;
  }

  const usefulSentence = text
    .split(/\r?\n|(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .find((sentence) => /^(always|avoid|do not|don't|keep|never|prefer|use)\b/i.test(sentence));
  return usefulSentence ? `Project convention: ${usefulSentence}` : '';
}
