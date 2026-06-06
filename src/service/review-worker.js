import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSessionPaths } from '../core/session-paths.js';
import { readBypassConfig } from '../core/config.js';
import { extractKnowledgeActions } from '../core/retrospective-schema.js';
import { routeKnowledgeTarget } from '../knowledge-routing.js';
import { claimNextJob, completeJobWithArtifacts, failJobWithArtifacts, skipJob } from './job-store.js';
import { buildReviewerPrompt } from './reviewer-prompt.js';
import { runReviewerCli } from './reviewer-runner.js';
import { validateReviewerResult } from './reviewer-validation.js';
import { notifyKnowledgeReady } from './notifier.js';
import { readServiceUrl, serviceUrl } from './service-client.js';

export async function runOneReviewJob({
  root = process.cwd(),
  reviewer = runReviewerCli,
  notify = notifyKnowledgeReady,
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
    const review = await reviewer({ root, runtime: job.runtime, prompt, payload });
    const result = validateReviewerResult({
      root,
      sessionId: job.session_id,
      parsed: withJobSessionId({ parsed: review.parsed, sessionId: job.session_id }),
      events,
      candidates
    });
    result.retrospective_report_path = paths.retrospectiveMarkdownPath;

    await completeJobWithArtifacts({
      root,
      jobId: job.id,
      leaseToken: job.lease_token,
      writeArtifacts: async () => writeArtifacts({ paths, result, review, malformedCount })
    });

    if (extractKnowledgeActions(result).length > 0) {
      const notification = await notificationPayload({
        root,
        config,
        sessionId: job.session_id
      });
      await notifyBestEffort(notify, {
        ...notification,
        root,
        openBrowser: config.service.openBrowserOnKnowledge
      });
    }

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
  return `${lines.join('\n')}\n`;
}

function withJobSessionId({ parsed, sessionId }) {
  return {
    ...parsed,
    session_id: sessionId,
    sessionId
  };
}

async function notificationPayload({ root, config, sessionId }) {
  const fallbackUrl = serviceUrl(config.service);
  const baseUrl = await readServiceUrl({ root, fallbackUrl });
  const parsed = new URL(baseUrl);
  const host = parsed.hostname;
  const port = Number(parsed.port);
  const { url } = notifyKnowledgeReady({
    host,
    port,
    sessionId,
    openBrowser: false
  });
  return { host, port, sessionId, url };
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

async function notifyBestEffort(notify, payload) {
  try {
    await notify(payload);
  } catch {
    // Notification is best-effort after the job and artifacts have completed.
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
