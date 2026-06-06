import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSessionPaths } from '../core/session-paths.js';
import { readBypassConfig } from '../core/config.js';
import { extractKnowledgeActions } from '../core/retrospective-schema.js';
import { routeKnowledgeTarget } from '../knowledge-routing.js';
import { claimNextJob, completeJob, failJob, skipJob } from './job-store.js';
import { buildReviewerPrompt } from './reviewer-prompt.js';
import { runReviewerCli } from './reviewer-runner.js';
import { validateReviewerResult } from './reviewer-validation.js';
import { notifyKnowledgeReady } from './notifier.js';

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
    const events = await readEvents(paths.eventsPath);
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
      parsed: review.parsed,
      events,
      candidates
    });
    result.retrospective_report_path = paths.retrospectiveMarkdownPath;

    await writeArtifacts({ paths, result, review });
    await completeJob({ root, jobId: job.id, leaseToken: job.lease_token });

    if (extractKnowledgeActions(result).length > 0) {
      await notifyBestEffort(notify, {
        root,
        host: config.service.host,
        port: config.service.port,
        sessionId: job.session_id,
        openBrowser: config.service.openBrowserOnKnowledge
      });
    }

    return { status: 'succeeded', result };
  } catch (error) {
    await writeFailureLog({ paths, error });
    await failJob({
      root,
      jobId: job.id,
      leaseToken: job.lease_token,
      error: errorMessage(error)
    });
    return { status: 'failed', error: errorMessage(error) };
  }
}

async function buildCandidates({ root, events, configuredTarget }) {
  const candidates = [];
  for (const event of events) {
    const route = await routeKnowledgeTarget({ root, event, configuredTarget });
    const relativeTarget = path.relative(root, route.target);
    candidates.push({
      event_id: event.id,
      target: route.target,
      target_reason: route.target_reason,
      relative_target: relativeTarget && !relativeTarget.startsWith('..') && !path.isAbsolute(relativeTarget)
        ? relativeTarget
        : route.target,
      target_exists: await fileExists(route.target),
      target_preview: await filePreview(route.target)
    });
  }
  return candidates;
}

async function readEvents(eventsPath) {
  let content;
  try {
    content = await fs.readFile(eventsPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const events = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    events.push(JSON.parse(line));
  }
  return events;
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function filePreview(filePath, limit = 2000) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return content.slice(0, limit);
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

async function writeArtifacts({ paths, result, review }) {
  await fs.mkdir(paths.sessionDir, { recursive: true });
  await fs.writeFile(paths.retrospectivePath, `${JSON.stringify(result, null, 2)}\n`);
  await fs.writeFile(paths.retrospectiveMarkdownPath, formatRetrospectiveMarkdown(result));
  await fs.writeFile(paths.reviewerLogPath, reviewerLog({ result, review }));
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

function reviewerLog({ result, review }) {
  const lines = [
    result.summary,
    `Finding count: ${result.retrospective.findings.length}`,
    `Knowledge action count: ${extractKnowledgeActions(result).length}`
  ];
  if (typeof review.raw === 'string' && review.raw.trim()) {
    lines.push('', 'Raw reviewer output:', review.raw.trim());
  }
  return `${lines.join('\n')}\n`;
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
