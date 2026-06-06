import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSessionPaths } from '../core/session-paths.js';
import { extractKnowledgeActions } from '../core/retrospective-schema.js';
import { assertWritableFileTarget, findingToSuggestion, formatKnowledgeEntry, resolveSafeTarget } from '../apply-approved-update.js';

export async function applyEditedApprovedUpdate({
  root = process.cwd(),
  sessionId,
  approved_suggestion_ids: approvedSuggestionIds,
  edits,
  approvals
} = {}) {
  const paths = resolveSessionPaths({ root, sessionId });
  const retrospective = await readJson(paths.retrospectivePath, 'retrospective.json is required');
  const suggestions = extractKnowledgeActions(retrospective).map(findingToSuggestion);
  const approvalRequest = normalizeApprovalRequest({ approvedSuggestionIds, edits, approvals });

  const suggestionIds = new Set(suggestions.map((suggestion) => suggestion.id));
  const unknownIds = approvalRequest.approved_suggestion_ids.filter((id) => !suggestionIds.has(id));
  if (unknownIds.length > 0) {
    throw new Error('approved_suggestion_ids must match suggestions');
  }

  const approvedIds = new Set(approvalRequest.approved_suggestion_ids);
  const invalidEditIds = Object.keys(approvalRequest.edits).filter((id) => !approvedIds.has(id));
  if (invalidEditIds.length > 0) {
    throw new Error('edits must match approved suggestions');
  }

  const toApply = await Promise.all(suggestions
    .filter((suggestion) => approvedIds.has(suggestion.id))
    .map(async (suggestion) => {
      const text = Object.hasOwn(approvalRequest.edits, suggestion.id)
        ? approvalRequest.edits[suggestion.id]
        : suggestion.proposed_text;
      if (typeof text !== 'string' || text.trim() === '') {
        throw new Error('approved update text must be non-empty');
      }
      const target = await resolveSafeTarget(path.resolve(root), suggestion.target);
      await assertWritableFileTarget(target);
      return {
        suggestion: { ...suggestion, proposed_text: text },
        target
      };
    }));

  if (toApply.length === 0) {
    throw new Error('approved_suggestion_ids must match suggestions');
  }

  const approval = {
    approved_at: new Date().toISOString(),
    approved_suggestion_ids: approvalRequest.approved_suggestion_ids,
    edits: approvalRequest.edits
  };
  await fs.writeFile(paths.approvalPath, `${JSON.stringify(approval, null, 2)}\n`);

  const applied = [];
  for (const { suggestion, target } of toApply) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const entry = formatKnowledgeEntry({ suggestion, sessionId });
    await fs.appendFile(target, entry);
    applied.push({ id: suggestion.id, target });
  }

  const patchText = applied.map((item) => `applied ${item.id} -> ${item.target}`).join('\n');
  await fs.writeFile(paths.appliedPatchPath, `${patchText}\n`);

  return {
    applied_count: applied.length,
    applied,
    skipped: [],
    rejected: []
  };
}

function normalizeApprovalRequest({ approvedSuggestionIds, edits, approvals }) {
  const normalizedEdits = normalizeEdits(edits);
  const ids = [];

  if (approvedSuggestionIds !== undefined) {
    if (!Array.isArray(approvedSuggestionIds)) {
      throw new Error('approval must include approved_suggestion_ids');
    }
    ids.push(...approvedSuggestionIds);
  }

  if (approvals !== undefined) {
    if (!Array.isArray(approvals)) {
      throw new Error('approval must include approved_suggestion_ids');
    }
    for (const approval of approvals) {
      if (!approval || typeof approval !== 'object' || typeof approval.id !== 'string') {
        throw new Error('approval must include approved_suggestion_ids');
      }
      const id = approval.id.trim();
      ids.push(id);
      if (Object.hasOwn(approval, 'proposed_text')) {
        normalizedEdits[id] = approval.proposed_text;
      } else if (Object.hasOwn(approval, 'text')) {
        normalizedEdits[id] = approval.text;
      }
    }
  }

  if (
    ids.length === 0 ||
    ids.some((id) => typeof id !== 'string' || id.trim() === '')
  ) {
    throw new Error('approval must include approved_suggestion_ids');
  }

  const trimmedIds = ids.map((id) => id.trim());
  if (new Set(trimmedIds).size !== trimmedIds.length) {
    throw new Error('approved_suggestion_ids must not contain duplicates');
  }

  return {
    approved_suggestion_ids: trimmedIds,
    edits: normalizedEdits
  };
}

function normalizeEdits(edits) {
  if (edits === undefined) return {};
  if (!edits || typeof edits !== 'object' || Array.isArray(edits)) {
    throw new Error('edits must be an object');
  }

  const normalized = {};
  for (const [id, text] of Object.entries(edits)) {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error('edits must be an object');
    }
    normalized[id.trim()] = text;
  }
  return normalized;
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
