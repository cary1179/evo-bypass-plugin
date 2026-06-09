import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeRetrospectiveResult } from './core/retrospective-schema.js';
import { hasReusableProjectConvention } from './project-convention.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const reviewerPromptPath = path.join(repoRoot, 'prompts', 'reviewer.md');

export async function reviewWithAiProvider({ root, sessionId, events, candidates, reviewer }) {
  const provider = reviewer?.provider;
  if (!provider || provider.type !== 'openai-compatible') {
    throw new Error('AI reviewer provider is not configured');
  }

  const apiKey = provider.apiKey || process.env[provider.apiKeyEnv];
  if (!apiKey) {
    throw new Error('AI reviewer API key is not configured');
  }

  const prompt = await fs.readFile(reviewerPromptPath, 'utf8');
  const payload = await buildReviewerPayload({ root, sessionId, events, candidates });
  const body = {
    model: provider.model,
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: JSON.stringify(payload, null, 2) }
    ],
    temperature: 0,
    response_format: { type: 'json_object' }
  };

  const response = await fetchWithTimeout(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  }, reviewer.timeoutMs);

  if (!response.ok) {
    throw new Error(`AI reviewer request failed with ${response.status}`);
  }

  const responseJson = await response.json();
  const content = responseJson?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error('AI reviewer response did not include message content');
  }

  const parsed = JSON.parse(content);
  return validateAiRetrospective({ root, sessionId, events, candidates, parsed });
}

async function buildReviewerPayload({ root, sessionId, events, candidates }) {
  return {
    session_id: sessionId,
    instructions: [
      'Return JSON only.',
      'Only use target values from candidates.',
      'Only use evidence ids present in events.'
    ],
    events: events.map(compactEvent),
    candidates: await Promise.all(candidates.map((candidate) => enrichCandidate({ root, candidate })))
  };
}

function compactEvent(event) {
  return {
    id: event.id,
    hook: event.hook,
    tool: event.tool,
    summary: event.summary,
    paths: event.paths || [],
    status: event.status,
    signals: event.signals || [],
    evidence: event.evidence || []
  };
}

async function enrichCandidate({ root, candidate }) {
  return {
    event_id: candidate.event_id,
    target: candidate.target,
    target_reason: candidate.target_reason,
    target_exists: await fileExists(candidate.target),
    target_preview: await readPreview(candidate.target),
    relative_target: path.relative(root, candidate.target)
  };
}

async function readPreview(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return text.length > 4000 ? `${text.slice(0, 4000)}...` : text;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function validateAiRetrospective({ root, sessionId, events, candidates, parsed }) {
  if (!Array.isArray(parsed?.retrospective?.findings)) {
    throw new Error('AI reviewer response must include retrospective.findings array');
  }

  const eventIds = new Set(events.map((event) => event.id));
  const targetByCandidate = new Map(candidates.map((candidate) => [path.resolve(candidate.target), candidate.target]));
  const normalizedFindings = parsed.retrospective.findings
    .map((finding) => normalizeAiFinding({ root, eventIds, targetByCandidate, finding }))
    .filter(Boolean);

  return normalizeRetrospectiveResult({
    sessionId,
    summary: parsed?.summary,
    outcome: parsed?.retrospective?.outcome,
    quality: parsed?.retrospective?.quality,
    findings: normalizedFindings
  });
}

function normalizeAiFinding({ root, eventIds, targetByCandidate, finding }) {
  if (!finding || typeof finding !== 'object') {
    return undefined;
  }

  const evidence = Array.isArray(finding.evidence)
    ? finding.evidence.filter((id) => eventIds.has(id))
    : [];
  if (evidence.length === 0) {
    return undefined;
  }

  const action = { ...(finding.action || {}) };
  if (action.type === 'update_knowledge') {
    const target = safeCandidateTarget({ root, target: action.target, targetByCandidate });
    if (!target) {
      return undefined;
    }
    if (!hasReusableProjectConvention(action.proposed_text)) {
      return undefined;
    }
    action.target = target;
  }

  return { ...finding, evidence, action };
}

function safeCandidateTarget({ root, target, targetByCandidate }) {
  if (typeof target !== 'string' || target.trim() === '') {
    return '';
  }

  const rootPath = path.resolve(root);
  const targetPath = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(rootPath, target);
  const relative = path.relative(rootPath, targetPath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return '';
  }
  return targetByCandidate.get(targetPath) || '';
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
