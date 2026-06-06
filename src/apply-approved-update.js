import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSessionPaths } from './core/session-paths.js';
import { extractKnowledgeActions } from './core/retrospective-schema.js';

export async function applyApprovedUpdate({ root = process.cwd(), sessionId }) {
  const paths = resolveSessionPaths({ root, sessionId });
  const updateActions = await readApprovedActionCandidates(paths);
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

  const approvedIds = new Set(approval.approved_suggestion_ids);
  const suggestionIds = new Set(updateActions.map((suggestion) => suggestion.id));
  const unknownIds = approval.approved_suggestion_ids.filter((id) => !suggestionIds.has(id));

  if (unknownIds.length > 0) {
    throw new Error('approved_suggestion_ids must match suggestions');
  }

  const toApply = await Promise.all(updateActions
    .filter((suggestion) => approvedIds.has(suggestion.id))
    .map((suggestion) => validateApprovedSuggestion({
      root: rootPath,
      suggestion: suggestionWithApprovedEdit({ suggestion, approval })
    })));

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

async function readApprovedActionCandidates(paths) {
  try {
    const retrospective = await readJson(paths.retrospectivePath, 'retrospective.json is required');
    const actions = extractKnowledgeActions(retrospective).map(findingToSuggestion);
    return actions;
  } catch (error) {
    if (error.message !== 'retrospective.json is required') {
      throw error;
    }
    const suggestions = await readJson(paths.suggestionsPath, 'suggestions.json is required');
    if (!Array.isArray(suggestions.suggestions)) {
      throw new Error('suggestions.json must include suggestions array');
    }
    return suggestions.suggestions;
  }
}

export function findingToSuggestion(finding) {
  return {
    id: finding.id,
    kind: 'retrospective_knowledge',
    confidence: finding.action.confidence,
    target: finding.action.target,
    evidence: finding.evidence,
    proposed_text: finding.action.proposed_text,
    rationale: finding.action.rationale || finding.diagnosis
  };
}

function suggestionWithApprovedEdit({ suggestion, approval }) {
  const edited = approval.edited_actions?.[suggestion.id]?.proposed_text;
  if (edited === undefined) return suggestion;
  return { ...suggestion, proposed_text: edited };
}

async function validateApprovedSuggestion({ root, suggestion }) {
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
    const target = await resolveSafeTarget(root, suggestion.target);
    await assertWritableFileTarget(target);
    return {
      suggestion,
      target
    };
  } catch (error) {
    if (error.message === 'target must stay inside root' || error.message === 'target must be a file path') {
      throw error;
    }
    throw new Error('approved suggestion must include id, safe target, and proposed_text');
  }
}

export async function resolveSafeTarget(root, target) {
  if (typeof target !== 'string' || target.trim() === '') {
    throw new Error('target must stay inside root');
  }

  const rootPath = path.resolve(root);
  const targetPath = path.resolve(rootPath, target);
  if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error('target must stay inside root');
  }

  const rootRealPath = await fs.realpath(rootPath);
  const existingAncestor = await nearestExistingAncestor(targetPath, rootPath);
  const ancestorRealPath = await fs.realpath(existingAncestor);
  if (ancestorRealPath !== rootRealPath && !ancestorRealPath.startsWith(`${rootRealPath}${path.sep}`)) {
    throw new Error('target must stay inside root');
  }

  return targetPath;
}

export async function assertWritableFileTarget(target) {
  try {
    const stat = await fs.lstat(target);
    if (stat.isDirectory()) {
      throw new Error('target must be a file path');
    }
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
}

async function nearestExistingAncestor(targetPath, rootPath) {
  let current = targetPath;
  while (current !== path.dirname(current)) {
    try {
      await fs.lstat(current);
      return current;
    } catch (error) {
      if (error.code === 'ENOTDIR') {
        throw new Error('target must be a file path');
      }
      if (error.code !== 'ENOENT') throw error;
    }
    if (current === rootPath) break;
    current = path.dirname(current);
  }
  return rootPath;
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

export function formatKnowledgeEntry({ suggestion, sessionId }) {
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
