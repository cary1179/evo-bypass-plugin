import fs from 'node:fs/promises';
import { resolveSessionPaths } from './core/session-paths.js';
import { normalizeEvent } from './core/event-schema.js';
import { normalizeHookPayload } from './adapters/hook-payload.js';
import { hasReusableProjectConvention } from './project-convention.js';

export async function collectEvent({ root = process.cwd(), payload, env = process.env }) {
  if (env.EVO_BYPASS_INTERNAL === '1') {
    return { skipped: true, reason: 'internal_invocation' };
  }

  const normalized = normalizeHookPayload(payload, root);
  const hook = normalized.hook;
  const sessionId = normalized.sessionId;
  const paths = resolveSessionPaths({ root, sessionId });
  await fs.mkdir(paths.sessionDir, { recursive: true });

  if (hook === 'UserPromptSubmit') {
    const metadata = {
      session_id: sessionId,
      created_at: new Date().toISOString(),
      runtime: normalized.runtime,
      working_directory: root,
      original_prompt: normalized.prompt,
      skip_review: normalized.skipReview,
      skip_reason: normalized.skipReason,
      plugin_version: '0.1.0'
    };
    await fs.writeFile(paths.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  }

  const event = normalizeEvent(toEventInput({ normalized }));
  await fs.appendFile(paths.eventsPath, `${JSON.stringify(event)}\n`);
  return { paths, event };
}

function toEventInput({ normalized }) {
  const output = String(normalized.output || '');
  const command = normalized.command || '';
  const exitCode = normalized.exitCode;
  const status = inferStatus({ hook: normalized.hook, output, error: normalized.error, exitCode });

  return {
    sessionId: normalized.sessionId,
    hook: normalized.hook,
    tool: normalized.tool,
    summary: summarize({ hook: normalized.hook, tool: normalized.tool, command }),
    paths: extractPaths(normalized.toolInput),
    status,
    signals: detectSignals({ command, output, status }),
    evidence: [command, output].filter(Boolean)
  };
}

function inferStatus({ hook, output, error, exitCode }) {
  if (exitCode > 0 || hook.endsWith('Failure') || error || /\berror\b/i.test(output)) {
    return 'failure';
  }
  if (exitCode === 0) {
    return 'success';
  }
  return 'unknown';
}

function summarize({ hook, tool, command }) {
  if (hook === 'UserPromptSubmit') {
    return 'User submitted the task prompt';
  }
  if (command) {
    return `${tool} ran command: ${command}`;
  }
  return `${tool} completed ${hook}`;
}

function extractPaths(input) {
  return [input.file_path, input.path, input.cwd].filter((item) => typeof item === 'string' && item.length > 0);
}

function detectSignals({ command, output, status }) {
  const signals = [];
  const text = `${command}\n${output}`;
  const lowerText = text.toLowerCase();
  if (status === 'failure' && /\b(test|vitest|jest|pytest|node --test)\b/.test(lowerText)) {
    signals.push('test_failure');
  }
  if (/\b(npm|pnpm|yarn) (install|add)\b/.test(lowerText)) {
    signals.push('dependency_change');
  }
  if (hasReusableProjectConvention(text)) {
    signals.push('project_convention');
  }
  return signals;
}
