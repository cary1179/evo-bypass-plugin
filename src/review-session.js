import fs from 'node:fs/promises';
import { resolveSessionPaths } from './core/session-paths.js';
import { normalizeSuggestion } from './core/event-schema.js';

export async function reviewSession({ root = process.cwd(), sessionId }) {
  const paths = resolveSessionPaths({ root, sessionId });
  const events = await readEvents(paths.eventsPath);
  const target = await resolveKnowledgeTarget(paths);
  const suggestions = events.flatMap((event) => suggestionForEvent(event, target)).slice(0, 10);
  const result = {
    session_id: sessionId,
    summary: suggestions.length > 0
      ? `Found ${suggestions.length} possible knowledge update(s).`
      : 'No durable knowledge updates suggested for this session.',
    suggestions
  };

  await fs.mkdir(paths.sessionDir, { recursive: true });
  await fs.writeFile(paths.suggestionsPath, `${JSON.stringify(result, null, 2)}\n`);
  await fs.writeFile(paths.reviewerLogPath, `${result.summary}\n`);
  return result;
}

async function readEvents(eventsPath) {
  try {
    const content = await fs.readFile(eventsPath, 'utf8');
    return content.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function resolveKnowledgeTarget(paths) {
  try {
    const config = JSON.parse(await fs.readFile(paths.configPath, 'utf8'));
    return config.knowledgeTarget || paths.defaultKnowledgePath;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return paths.defaultKnowledgePath;
    }
    throw error;
  }
}

function suggestionForEvent(event, target) {
  const text = `${event.summary}\n${event.evidence.join('\n')}`;
  if (event.signals.includes('project_convention') || /project convention/i.test(text)) {
    return [normalizeSuggestion({
      kind: 'project_convention',
      confidence: 'medium',
      target,
      evidence: [event.id],
      proposed_text: extractKnowledgeText(text, 'Project convention'),
      rationale: 'The session included explicit convention evidence that may affect future work in this repository.'
    }, target)];
  }
  if (event.signals.includes('test_failure')) {
    return [normalizeSuggestion({
      kind: 'failure_pattern',
      confidence: 'low',
      target,
      evidence: [event.id],
      proposed_text: `Observed test failure pattern: ${event.summary}`,
      rationale: 'The failed command may be useful if the same failure recurs, but it needs user confirmation before saving.'
    }, target)];
  }
  return [];
}

function extractKnowledgeText(text, fallback) {
  const match = text.match(/Project convention:\s*(.+)/i);
  return match ? `Project convention: ${match[1].trim()}` : fallback;
}
