import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSessionPaths } from './core/session-paths.js';

export async function applyApprovedUpdate({ root = process.cwd(), sessionId }) {
  const paths = resolveSessionPaths({ root, sessionId });
  const suggestions = await readJson(paths.suggestionsPath, 'suggestions.json is required');
  const approval = await readJson(paths.approvalPath, 'approval.json is required before applying updates');

  if (
    !Array.isArray(approval.approved_suggestion_ids) ||
    approval.approved_suggestion_ids.length === 0 ||
    approval.approved_suggestion_ids.some((id) => typeof id !== 'string' || id.trim() === '') ||
    typeof approval.approval_text !== 'string' ||
    approval.approval_text.trim() === ''
  ) {
    throw new Error('approval must include approved_suggestion_ids and approval_text');
  }

  const approvedIds = new Set(approval.approved_suggestion_ids);

  const applied = [];
  for (const suggestion of suggestions.suggestions || []) {
    if (!approvedIds.has(suggestion.id)) {
      continue;
    }
    const target = path.resolve(root, suggestion.target);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const entry = formatKnowledgeEntry({ suggestion, sessionId });
    await fs.appendFile(target, entry);
    applied.push({ id: suggestion.id, target });
  }

  const patchText = applied.map((item) => `applied ${item.id} -> ${item.target}`).join('\n');
  await fs.writeFile(paths.appliedPatchPath, `${patchText}\n`);
  return { applied };
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
