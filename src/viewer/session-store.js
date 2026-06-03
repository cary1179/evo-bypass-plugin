import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSessionPaths } from '../core/session-paths.js';

export async function listSessions({ root = process.cwd() } = {}) {
  const sessionsDir = path.join(root, '.bypass', 'sessions');
  let entries = [];
  try {
    entries = await fs.readdir(sessionsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { root, sessions: [] };
    }
    throw error;
  }

  const sessions = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      const detail = await getSessionDetail({ root, sessionId: entry.name });
      sessions.push(toSummary(detail));
    } catch {
      // Ignore unsafe or unreadable session directories in the listing.
    }
  }

  sessions.sort((left, right) => String(right.created_at || '').localeCompare(String(left.created_at || '')));
  return { root, sessions };
}

export async function getSessionDetail({ root = process.cwd(), sessionId }) {
  const paths = resolveSessionPaths({ root, sessionId });
  const metadata = await readJson(paths.metadataPath, {
    session_id: sessionId,
    created_at: '',
    runtime: 'unknown',
    working_directory: root,
    original_prompt: '',
    plugin_version: ''
  });
  const { events, malformedCount } = await readEvents(paths.eventsPath);
  const suggestions = await readJson(paths.suggestionsPath, {
    session_id: sessionId,
    summary: 'No suggestions file found for this session.',
    suggestions: []
  });
  const retrospective = await readJson(paths.retrospectivePath, {
    session_id: sessionId,
    summary: 'No retrospective file found for this session.',
    retrospective: {
      outcome: 'unknown',
      quality: 'smooth',
      findings: []
    }
  });
  const reviewerLog = await readText(paths.reviewerLogPath, '');

  return {
    session_id: sessionId,
    metadata,
    events,
    retrospective,
    suggestions,
    reviewerLog,
    malformedEventCount: malformedCount
  };
}

function toSummary(detail) {
  const events = Array.isArray(detail.events) ? detail.events : [];
  const findings = retrospectiveFindings(detail);
  const knowledgeActions = knowledgeActionFindings(detail);
  return {
    session_id: detail.session_id,
    created_at: detail.metadata?.created_at || '',
    runtime: detail.metadata?.runtime || 'unknown',
    event_count: events.length,
    failure_count: events.filter((event) => event.status === 'failure').length,
    signals: [...new Set(events.flatMap((event) => Array.isArray(event.signals) ? event.signals : []))],
    finding_count: findings.length,
    suggestion_count: knowledgeActions.length,
    has_suggestion_report: reportPath(detail).length > 0,
    working_directory: detail.metadata?.working_directory || '',
    prompt_preview: preview(detail.metadata?.original_prompt || '')
  };
}

function retrospectiveFindings(detail) {
  return Array.isArray(detail.retrospective?.retrospective?.findings)
    ? detail.retrospective.retrospective.findings
    : [];
}

function knowledgeActionFindings(detail) {
  const findings = retrospectiveFindings(detail);
  if (findings.length > 0) {
    return findings.filter((finding) => finding.action?.type === 'update_knowledge');
  }
  return Array.isArray(detail.suggestions?.suggestions) ? detail.suggestions.suggestions : [];
}

function reportPath(detail) {
  return typeof detail.retrospective?.retrospective_report_path === 'string' && detail.retrospective.retrospective_report_path.length > 0
    ? detail.retrospective.retrospective_report_path
    : typeof detail.suggestions?.suggestion_report_path === 'string'
      ? detail.suggestions.suggestion_report_path
      : '';
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) {
      return fallback;
    }
    throw error;
  }
}

async function readText(filePath, fallback) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

async function readEvents(eventsPath) {
  let content = '';
  try {
    content = await fs.readFile(eventsPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { events: [], malformedCount: 0 };
    }
    throw error;
  }

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
}

function preview(value) {
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}
