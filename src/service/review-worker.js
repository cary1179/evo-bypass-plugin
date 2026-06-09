import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSessionPaths } from '../core/session-paths.js';
import { readBypassConfig } from '../core/config.js';
import { extractKnowledgeActions } from '../core/retrospective-schema.js';
import { routeKnowledgeTarget } from '../knowledge-routing.js';
import { extractReusableProjectConvention } from '../project-convention.js';
import { claimNextJob, completeJobWithArtifacts, failJobWithArtifacts, skipJob } from './job-store.js';
import { buildReviewerPrompt } from './reviewer-prompt.js';
import { runReviewerCli } from './reviewer-runner.js';
import { validateReviewerResult } from './reviewer-validation.js';

export async function runOneReviewJob({
  root = process.cwd(),
  reviewer = runReviewerCli,
  leaseMs = 180000
} = {}) {
  const job = await claimNextJob({ root, leaseMs });
  if (!job) {
    return { status: 'nothing' };
  }

  const paths = resolveSessionPaths({ root, sessionId: job.session_id });

  try {
    const metadata = await readJson(paths.metadataPath, {});
    const { events, malformedCount } = await readEvents(paths.eventsPath);
    const config = await readBypassConfig({ root });
    const candidates = await buildCandidates({ root, events, configuredTarget: config.knowledgeTarget });
    const payload = {
      session: metadata,
      events,
      config,
      candidates
    };

    if (metadata.skip_review === true) {
      await skipJob({
        root,
        jobId: job.id,
        leaseToken: job.lease_token,
        error: metadata.skip_reason || 'session marked skip_review'
      });
      return { status: 'skipped' };
    }

    if (events.length === 0) {
      await skipJob({
        root,
        jobId: job.id,
        leaseToken: job.lease_token,
        error: 'session has no events'
      });
      return { status: 'skipped' };
    }

    const prompt = buildReviewerPrompt(payload);
    let review = await runReviewerOrFallback({
      root,
      runtime: job.runtime,
      prompt,
      payload,
      reviewer,
      sessionId: job.session_id,
      events,
      candidates,
      config
    });
    const validated = validateReviewOrFallback({
      root,
      sessionId: job.session_id,
      review,
      events,
      candidates,
      config
    });
    const { result } = validated;
    review = validated.review;
    result.retrospective_report_path = paths.retrospectiveMarkdownPath;

    await completeJobWithArtifacts({
      root,
      jobId: job.id,
      leaseToken: job.lease_token,
      writeArtifacts: async () => writeArtifacts({ paths, result, review, malformedCount })
    });

    return { status: 'succeeded', result };
  } catch (error) {
    await failClaimedJob({ root, job, error });
    return { status: 'failed', error: errorMessage(error) };
  }
}

async function buildCandidates({ root, events, configuredTarget }) {
  const candidates = [];
  for (const event of events) {
    const route = await routeKnowledgeTarget({ root, event, configuredTarget });
    const targetInfo = await safeTargetInfo({ root, filePath: route.target });
    if (!targetInfo.safe) {
      continue;
    }
    const relativeTarget = path.relative(root, route.target);
    candidates.push({
      event_id: event.id,
      target: route.target,
      target_reason: route.target_reason,
      relative_target: relativeTarget && !relativeTarget.startsWith('..') && !path.isAbsolute(relativeTarget)
        ? relativeTarget
        : route.target,
      target_exists: targetInfo.exists,
      target_preview: await safeFilePreview(targetInfo)
    });
  }
  return candidates;
}

async function readEvents(eventsPath) {
  let content;
  try {
    content = await fs.readFile(eventsPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { events: [], malformedCount: 0 };
    throw error;
  }

  const events = [];
  let malformedCount = 0;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      malformedCount += 1;
    }
  }
  return { events, malformedCount };
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function safeFilePreview(info, limit = 2000) {
  if (!info.exists) {
    return '';
  }
  const content = await fs.readFile(info.realPath, 'utf8');
  return content.slice(0, limit);
}

async function safeTargetInfo({ root, filePath }) {
  const resolvedRoot = path.resolve(root);
  const rootPath = await fs.realpath(root);
  const targetPath = path.resolve(filePath);
  if (!isInsideRoot({ rootPath: resolvedRoot, targetPath })) {
    return { safe: false, exists: false };
  }

  let lstat;
  try {
    lstat = await fs.lstat(targetPath);
  } catch (error) {
    if (error.code === 'ENOENT') return missingTargetInfo({ rootPath, targetPath });
    throw error;
  }
  if (!lstat.isFile() && !lstat.isSymbolicLink()) {
    return { safe: false, exists: false };
  }

  let realPath;
  try {
    realPath = await fs.realpath(targetPath);
  } catch (error) {
    if (error.code === 'ENOENT') return missingTargetInfo({ rootPath, targetPath });
    throw error;
  }
  if (!isInsideRoot({ rootPath, targetPath: realPath })) {
    return { safe: false, exists: false };
  }

  const stat = await fs.stat(realPath);
  return { safe: stat.isFile(), exists: stat.isFile(), realPath };
}

async function missingTargetInfo({ rootPath, targetPath }) {
  const parentPath = await nearestExistingParent(targetPath);
  if (!parentPath) {
    return { safe: false, exists: false };
  }

  const realParentPath = await fs.realpath(parentPath);
  return {
    safe: isInsideRoot({ rootPath, targetPath: realParentPath }),
    exists: false
  };
}

async function nearestExistingParent(targetPath) {
  let current = path.dirname(targetPath);
  while (current && current !== path.dirname(current)) {
    try {
      const stat = await fs.stat(current);
      return stat.isDirectory() ? current : undefined;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
    current = path.dirname(current);
  }
  return undefined;
}

function isInsideRoot({ rootPath, targetPath }) {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function validateReviewOrFallback({ root, sessionId, review, events, candidates, config }) {
  try {
    return {
      result: validateReviewerResult({
        root,
        sessionId,
        parsed: withJobSessionId({ parsed: review.parsed, sessionId }),
        events,
        candidates
      }),
      review
    };
  } catch (error) {
    if (config.reviewer?.fallback !== 'rules' || !isMalformedReviewerShapeError(error)) {
      throw error;
    }
    const fallbackReview = {
      ...review,
      parsed: rulesReview({ sessionId, events, candidates }),
      fallbackReason: errorMessage(error)
    };
    return {
      result: validateReviewerResult({
        root,
        sessionId,
        parsed: fallbackReview.parsed,
        events,
        candidates
      }),
      review: fallbackReview
    };
  }
}

async function runReviewerOrFallback({ root, runtime, prompt, payload, reviewer, sessionId, events, candidates, config }) {
  try {
    return await reviewer({ root, runtime, prompt, payload, timeoutMs: config.reviewer?.timeoutMs });
  } catch (error) {
    if (config.reviewer?.fallback !== 'rules') {
      throw error;
    }
    return {
      parsed: rulesReview({ sessionId, events, candidates, reason: 'Reviewer failed; used deterministic rules fallback.' }),
      fallbackReason: errorMessage(error)
    };
  }
}

function isMalformedReviewerShapeError(error) {
  return errorMessage(error) === 'reviewer result must include retrospective.findings array';
}

function rulesReview({ sessionId, events, candidates, reason = 'Reviewer output was malformed; used deterministic rules fallback.' }) {
  const routeByEventId = new Map(candidates.map((candidate) => [candidate.event_id, candidate]));
  const findings = [];
  for (const event of events) {
    findings.push(...rulesFindingsForEvent({ event, candidate: routeByEventId.get(event.id) }));
  }
  return {
    session_id: sessionId,
    summary: reason,
    retrospective: {
      outcome: 'completed',
      quality: findings.length > 0 ? 'minor_issues' : 'smooth',
      findings: dedupeFindings(findings).slice(0, 10)
    }
  };
}

function rulesFindingsForEvent({ event, candidate }) {
  const evidence = Array.isArray(event.evidence) ? event.evidence : [];
  const signals = Array.isArray(event.signals) ? event.signals : [];
  const text = `${event.summary || ''}\n${evidence.join('\n')}`;
  const knowledgeText = extractReusableProjectConvention(text);
  const hasConventionCue = signals.includes('project_convention')
    || /project convention|项目(?:约定|规范|规则)|项目中?的?规则/iu.test(text);
  if (hasConventionCue && knowledgeText && candidate) {
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
        target: candidate.target,
        target_reason: candidate.target_reason,
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

async function writeArtifacts({ paths, result, review, malformedCount }) {
  await fs.mkdir(paths.sessionDir, { recursive: true });
  await fs.writeFile(paths.retrospectivePath, `${JSON.stringify(result, null, 2)}\n`);
  await fs.writeFile(paths.retrospectiveMarkdownPath, formatRetrospectiveMarkdown(result));
  await fs.writeFile(paths.reviewerLogPath, reviewerLog({ result, review, malformedCount }));
}

async function writeFailureLog({ paths, error }) {
  await fs.mkdir(paths.sessionDir, { recursive: true });
  await fs.writeFile(paths.reviewerLogPath, `Review job failed: ${errorMessage(error)}\n${error?.stack || ''}\n`);
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
    lines.push('', 'No significant failures or reusable improvements were detected.');
  }

  for (const finding of findings) {
    lines.push(
      '',
      `### ${finding.id}`,
      '',
      `- Category: ${finding.category}`,
      `- Severity: ${finding.severity}`,
      `- Evidence: ${finding.evidence.join(', ')}`,
      `- Diagnosis: ${finding.diagnosis}`,
      `- Recommendation: ${finding.recommendation}`
    );
  }

  lines.push('', '## Recommended Actions');
  if (findings.length === 0) {
    lines.push('', 'No action recommended.');
  }

  for (const finding of findings) {
    lines.push(
      '',
      `### ${finding.action.type}`,
      '',
      `- Confidence: ${finding.action.confidence}`
    );
    if (finding.action.target) lines.push(`- Target: ${finding.action.target}`);
    if (finding.action.target_reason) lines.push(`- Target reason: ${finding.action.target_reason}`);
    if (finding.action.rationale) lines.push(`- Rationale: ${finding.action.rationale}`);
    if (finding.action.proposed_text) {
      lines.push('', 'Proposed text:', '', finding.action.proposed_text);
    }
  }

  return `${lines.join('\n')}\n`;
}

function reviewerLog({ result, review, malformedCount = 0 }) {
  const lines = [
    result.summary,
    `Finding count: ${result.retrospective.findings.length}`,
    `Knowledge action count: ${extractKnowledgeActions(result).length}`,
    `Malformed event line count: ${malformedCount}`
  ];
  if (typeof review.raw === 'string' && review.raw.trim()) {
    lines.push('', 'Raw reviewer output:', review.raw.trim());
  }
  if (typeof review.fallbackReason === 'string' && review.fallbackReason.trim()) {
    lines.push('', `Rules fallback reason: ${review.fallbackReason.trim()}`);
  }
  return `${lines.join('\n')}\n`;
}

function withJobSessionId({ parsed, sessionId }) {
  return {
    ...parsed,
    session_id: sessionId,
    sessionId
  };
}

async function failClaimedJob({ root, job, error }) {
  try {
    const paths = resolveSessionPaths({ root, sessionId: job.session_id });
    await failJobWithArtifacts({
      root,
      jobId: job.id,
      leaseToken: job.lease_token,
      error: errorMessage(error),
      writeArtifacts: async () => writeFailureLog({ paths, error })
    });
  } catch (failError) {
    if (!/stale job lease/.test(errorMessage(failError))) {
      throw failError;
    }
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
