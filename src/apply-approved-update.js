import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSessionPaths } from './core/session-paths.js';

export async function applyApprovedUpdate({ root = process.cwd(), sessionId }) {
  const paths = resolveSessionPaths({ root, sessionId });
  const suggestions = await readJson(paths.suggestionsPath, 'suggestions.json is required');
  const approval = await readJson(paths.approvalPath, 'approval.json is required before applying updates');
  const rootPath = path.resolve(root);

  if (
    !Array.isArray(approval.approved_suggestion_ids) ||
    approval.approved_suggestion_ids.length === 0 ||
    approval.approved_suggestion_ids.some((id) => typeof id !== 'string' || id.trim() === '') ||
    typeof approval.approval_text !== 'string' ||
    approval.approval_text.trim() === ''
  ) {
    throw new Error('approval must include approved_suggestion_ids and approval_text');
  }

  if (new Set(approval.approved_suggestion_ids).size !== approval.approved_suggestion_ids.length) {
    throw new Error('approved_suggestion_ids must not contain duplicates');
  }

  if (!Array.isArray(suggestions.suggestions)) {
    throw new Error('suggestions.json must include suggestions array');
  }

  const approvedIds = new Set(approval.approved_suggestion_ids);
  const suggestionIds = new Set(suggestions.suggestions.map((suggestion) => suggestion.id));
  const unknownIds = approval.approved_suggestion_ids.filter((id) => !suggestionIds.has(id));

  if (unknownIds.length > 0) {
    throw new Error('approved_suggestion_ids must match suggestions');
  }

  const toApply = suggestions.suggestions
    .filter((suggestion) => approvedIds.has(suggestion.id))
    .map((suggestion) => validateApprovedSuggestion({ root: rootPath, suggestion }));

  if (toApply.length === 0) {
    throw new Error('approved_suggestion_ids must match suggestions');
  }

  const applied = [];
  for (const { suggestion, target } of toApply) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const entry = formatKnowledgeEntry({ suggestion, sessionId });
    await fs.appendFile(target, entry);
    applied.push({ id: suggestion.id, target });
  }

  const patchText = applied.map((item) => `applied ${item.id} -> ${item.target}`).join('\n');
  await fs.writeFile(paths.appliedPatchPath, `${patchText}\n`);
  return { applied };
}

function validateApprovedSuggestion({ root, suggestion }) {
  if (
    !suggestion ||
    typeof suggestion.id !== 'string' ||
    suggestion.id.trim() === '' ||
    typeof suggestion.proposed_text !== 'string' ||
    suggestion.proposed_text.trim() === '' ||
    (suggestion.evidence !== undefined && !Array.isArray(suggestion.evidence))
  ) {
    throw new Error('approved suggestion must include id, safe target, and proposed_text');
  }

  try {
    return {
      suggestion,
      target: resolveSafeTarget(root, suggestion.target)
    };
  } catch (error) {
    if (error.message === 'target must stay inside root') {
      throw error;
    }
    throw new Error('approved suggestion must include id, safe target, and proposed_text');
  }
}

function resolveSafeTarget(root, target) {
  if (typeof target !== 'string' || target.trim() === '') {
    throw new Error('target must stay inside root');
  }

  const rootPath = path.resolve(root);
  const targetPath = path.resolve(rootPath, target);
  if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error('target must stay inside root');
  }

  return targetPath;
}

async function readJson(filePath, message) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(message);
    }
    throw error;
  }
}

function formatKnowledgeEntry({ suggestion, sessionId }) {
  return [
    '',
    `## ${suggestion.id}`,
    '',
    `- Session: ${sessionId}`,
    `- Kind: ${suggestion.kind || 'unknown'}`,
    `- Confidence: ${suggestion.confidence || 'unknown'}`,
    `- Evidence: ${(suggestion.evidence || []).join(', ')}`,
    '',
    suggestion.proposed_text,
    ''
  ].join('\n');
}
