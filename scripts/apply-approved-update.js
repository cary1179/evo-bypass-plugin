#!/usr/bin/env node
import fs from 'node:fs/promises';
import { resolveSessionPaths } from '../src/core/session-paths.js';
import { applyApprovedUpdate } from '../src/apply-approved-update.js';

const [sessionId, approvedIdsArg, ...approvalTextParts] = process.argv.slice(2);
if (!sessionId || !approvedIdsArg || approvalTextParts.length === 0) {
  console.error('Usage: scripts/apply-approved-update.js <session-id> <sug_1,sug_2> <approval text>');
  process.exit(1);
}

const paths = resolveSessionPaths({ root: process.cwd(), sessionId });
await fs.mkdir(paths.sessionDir, { recursive: true });
await fs.writeFile(paths.approvalPath, `${JSON.stringify({
  approved_at: new Date().toISOString(),
  approved_suggestion_ids: approvedIdsArg.split(',').map((id) => id.trim()).filter(Boolean),
  approval_text: approvalTextParts.join(' ')
}, null, 2)}\n`);

const result = await applyApprovedUpdate({ root: process.cwd(), sessionId });
console.log(`Applied ${result.applied.length} knowledge update(s).`);
