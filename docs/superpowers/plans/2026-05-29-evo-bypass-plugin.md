# Evo Bypass Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Claude Code and Codex hook package that records main-agent behavior into a local session store, reviews the session for knowledge update suggestions at task completion, and applies updates only after explicit user approval.

**Architecture:** Use a shared Node.js core with thin runtime adapters for Claude and Codex hook payloads. Claude installs through `.claude-plugin/plugin.json` and `hooks/claude-hooks.json`; Codex installs by merging `hooks/codex-hooks.json` into `~/.codex/hooks.json`; both runtimes normalize hook payloads into `.bypass/sessions/<session-id>/`, run the same reviewer at `Stop`, and write approved suggestions only after explicit user confirmation.

**Tech Stack:** Node.js ESM, built-in `node:test`, built-in `node:assert`, built-in `node:fs/promises`, JSONL session storage, Claude plugin manifest, Claude hooks JSON, and Codex hooks JSON.

---

## File Structure

- Create `package.json`: project metadata, ESM mode, test scripts.
- Create `.gitignore`: ignore `.bypass/sessions/`, logs, and dependency folders.
- Create `src/core/redact.js`: redacts secrets from evidence before persistence.
- Create `src/core/session-paths.js`: resolves repo root, config, session directory, metadata, events, suggestions, approval, and patch paths.
- Create `src/core/event-schema.js`: validates and normalizes event and suggestion objects without external dependencies.
- Create `src/adapters/hook-payload.js`: normalizes Claude and Codex hook payload shapes into the collector's internal input.
- Create `src/collect-event.js`: library function for hook event collection.
- Create `scripts/collect-event.js`: CLI wrapper used by Claude and Codex hooks.
- Create `src/review-session.js`: library function that reads events and writes `suggestions.json`.
- Create `scripts/review-session.js`: CLI wrapper used by the `Stop` hook.
- Create `src/apply-approved-update.js`: library function that applies approved suggestions.
- Create `scripts/apply-approved-update.js`: CLI wrapper used after user confirmation.
- Create `.claude-plugin/plugin.json`: plugin metadata.
- Create `hooks/claude-hooks.json`: Claude hook definitions.
- Create `hooks/codex-hooks.json`: Codex hook definitions that can be merged into `~/.codex/hooks.json`.
- Create `prompts/reviewer.md`: reviewer instructions.
- Create `schemas/session-event.schema.json`: JSON schema documentation for events.
- Create `schemas/suggestion.schema.json`: JSON schema documentation for reviewer output.
- Create `test/*.test.js`: unit and integration tests.
- Create `README.md`: usage, safety model, and confirmation flow.

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `src/core/session-paths.js`
- Test: `test/session-paths.test.js`

- [ ] **Step 1: Write the failing path test**

```js
// test/session-paths.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveSessionPaths } from '../src/core/session-paths.js';

test('resolveSessionPaths returns stable repository-local artifact paths', () => {
  const root = path.join(process.cwd(), 'fixture-root');
  const paths = resolveSessionPaths({ root, sessionId: 'sess_123' });

  assert.equal(paths.root, root);
  assert.equal(paths.bypassDir, path.join(root, '.bypass'));
  assert.equal(paths.sessionDir, path.join(root, '.bypass', 'sessions', 'sess_123'));
  assert.equal(paths.metadataPath, path.join(paths.sessionDir, 'metadata.json'));
  assert.equal(paths.eventsPath, path.join(paths.sessionDir, 'events.jsonl'));
  assert.equal(paths.suggestionsPath, path.join(paths.sessionDir, 'suggestions.json'));
  assert.equal(paths.approvalPath, path.join(paths.sessionDir, 'approval.json'));
  assert.equal(paths.appliedPatchPath, path.join(paths.sessionDir, 'applied.patch'));
  assert.equal(paths.defaultKnowledgePath, path.join(root, 'AGENTS.md'));
});
```

- [ ] **Step 2: Add project metadata**

```json
{
  "name": "evo-bypass",
  "version": "0.1.0",
  "description": "Advisory-first Claude Code and Codex hook package for session-based knowledge update suggestions.",
  "type": "module",
  "private": true,
  "scripts": {
    "test": "node --test",
    "test:unit": "node --test test/*.test.js"
  },
  "engines": {
    "node": ">=20"
  }
}
```

- [ ] **Step 3: Add ignore rules**

```gitignore
node_modules/
npm-debug.log*
.DS_Store
.bypass/sessions/
.bypass/*.log
```

- [ ] **Step 4: Implement session path resolver**

```js
// src/core/session-paths.js
import path from 'node:path';

export function resolveSessionPaths({ root = process.cwd(), sessionId }) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('sessionId is required');
  }

  const bypassDir = path.join(root, '.bypass');
  const sessionDir = path.join(bypassDir, 'sessions', sessionId);

  return {
    root,
    bypassDir,
    configPath: path.join(bypassDir, 'config.json'),
    defaultKnowledgePath: path.join(root, 'AGENTS.md'),
    sessionDir,
    metadataPath: path.join(sessionDir, 'metadata.json'),
    eventsPath: path.join(sessionDir, 'events.jsonl'),
    suggestionsPath: path.join(sessionDir, 'suggestions.json'),
    approvalPath: path.join(sessionDir, 'approval.json'),
    appliedPatchPath: path.join(sessionDir, 'applied.patch'),
    reviewerLogPath: path.join(sessionDir, 'reviewer.log')
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- test/session-paths.test.js`

Expected: PASS with one passing test.

- [ ] **Step 6: Commit**

```bash
git add package.json .gitignore src/core/session-paths.js test/session-paths.test.js
git commit -m "chore: scaffold evo bypass project"
```

---

### Task 2: Event Normalization And Redaction

**Files:**
- Create: `src/core/redact.js`
- Create: `src/core/event-schema.js`
- Test: `test/event-schema.test.js`

- [ ] **Step 1: Write failing schema and redaction tests**

```js
// test/event-schema.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../src/core/redact.js';
import { normalizeEvent } from '../src/core/event-schema.js';

test('redactSecrets removes obvious secret values', () => {
  const input = 'TOKEN=abc123456789012345678901234567890 password: hunter2 api_key="sk-live-123"';
  const output = redactSecrets(input);

  assert.equal(output.includes('abc123456789012345678901234567890'), false);
  assert.equal(output.includes('hunter2'), false);
  assert.equal(output.includes('sk-live-123'), false);
  assert.match(output, /\[REDACTED\]/);
});

test('normalizeEvent produces stable fields and redacted evidence', () => {
  const event = normalizeEvent({
    sessionId: 'sess_1',
    hook: 'PostToolUse',
    tool: 'Bash',
    summary: 'ran tests',
    paths: ['test/example.test.js'],
    status: 'failure',
    signals: ['test_failure'],
    evidence: ['API_TOKEN=secretsecretsecretsecretsecretsecret failed']
  });

  assert.equal(event.session_id, 'sess_1');
  assert.equal(event.hook, 'PostToolUse');
  assert.equal(event.tool, 'Bash');
  assert.equal(event.status, 'failure');
  assert.deepEqual(event.paths, ['test/example.test.js']);
  assert.deepEqual(event.signals, ['test_failure']);
  assert.equal(event.evidence[0].includes('secretsecret'), false);
  assert.match(event.id, /^evt_/);
  assert.match(event.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});
```

- [ ] **Step 2: Implement redaction**

```js
// src/core/redact.js
const SECRET_PATTERNS = [
  /\b[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|PASS|API_KEY|AUTH)[A-Z0-9_]*\s*=\s*["']?[^"'\s]+["']?/gi,
  /\b(password|api_key|token|secret)\s*:\s*["']?[^"'\s]+["']?/gi,
  /\bsk-[A-Za-z0-9_-]{6,}\b/g
];

export function redactSecrets(value) {
  if (typeof value !== 'string') {
    return value;
  }

  return SECRET_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, (match) => {
      const separator = match.includes('=') ? '=' : match.includes(':') ? ':' : '';
      const key = separator ? match.split(separator)[0].trim() : 'secret';
      return `${key}${separator ? `${separator} ` : ' '}[REDACTED]`;
    }),
    value
  );
}
```

- [ ] **Step 3: Implement event normalization**

```js
// src/core/event-schema.js
import { randomUUID } from 'node:crypto';
import { redactSecrets } from './redact.js';

const HOOKS = new Set(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PermissionRequest', 'Stop']);
const STATUSES = new Set(['success', 'failure', 'unknown']);

export function normalizeEvent(input) {
  const sessionId = stringOrThrow(input.sessionId, 'sessionId');
  const hook = HOOKS.has(input.hook) ? input.hook : 'PostToolUse';
  const status = STATUSES.has(input.status) ? input.status : 'unknown';

  return {
    id: input.id || `evt_${randomUUID()}`,
    session_id: sessionId,
    timestamp: input.timestamp || new Date().toISOString(),
    hook,
    tool: typeof input.tool === 'string' && input.tool ? input.tool : 'Other',
    summary: truncate(redactSecrets(input.summary || 'No summary provided'), 500),
    paths: arrayOfStrings(input.paths),
    status,
    signals: arrayOfStrings(input.signals),
    evidence: arrayOfStrings(input.evidence).map((item) => truncate(redactSecrets(item), 500))
  };
}

export function normalizeSuggestion(input, fallbackTarget) {
  return {
    id: input.id || `sug_${randomUUID()}`,
    kind: input.kind,
    confidence: input.confidence,
    target: input.target || fallbackTarget,
    evidence: arrayOfStrings(input.evidence),
    proposed_text: String(input.proposed_text || '').trim(),
    rationale: String(input.rationale || '').trim()
  };
}

function stringOrThrow(value, name) {
  if (!value || typeof value !== 'string') {
    throw new Error(`${name} is required`);
  }
  return value;
}

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.length > 0) : [];
}

function truncate(value, maxLength) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/event-schema.test.js`

Expected: PASS with two passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/redact.js src/core/event-schema.js test/event-schema.test.js
git commit -m "feat: add event normalization and redaction"
```

---

### Task 3: Hook Event Collector

**Files:**
- Create: `src/adapters/hook-payload.js`
- Create: `src/collect-event.js`
- Create: `scripts/collect-event.js`
- Test: `test/collect-event.test.js`

- [ ] **Step 1: Write failing collector tests**

```js
// test/collect-event.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectEvent } from '../src/collect-event.js';
import { normalizeHookPayload } from '../src/adapters/hook-payload.js';

test('normalizeHookPayload accepts Codex-style hook payloads', () => {
  const normalized = normalizeHookPayload({
    runtime: 'codex',
    hook: 'PostToolUse',
    session_id: 'codex_sess',
    tool_name: 'exec_command',
    input: { cmd: 'npm test' },
    response: { exit_code: 0, stdout: 'ok' },
    cwd: '/tmp/project'
  });

  assert.equal(normalized.runtime, 'codex');
  assert.equal(normalized.hook, 'PostToolUse');
  assert.equal(normalized.sessionId, 'codex_sess');
  assert.equal(normalized.tool, 'exec_command');
  assert.equal(normalized.root, '/tmp/project');
  assert.equal(normalized.command, 'npm test');
});

test('collectEvent creates metadata on UserPromptSubmit', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const result = await collectEvent({
    root,
    payload: {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'sess_meta',
      prompt: 'Build the plugin'
    }
  });

  const metadata = JSON.parse(await fs.readFile(result.paths.metadataPath, 'utf8'));
  assert.equal(metadata.session_id, 'sess_meta');
  assert.equal(metadata.original_prompt, 'Build the plugin');
  assert.equal(metadata.working_directory, root);
});

test('collectEvent appends redacted PostToolUse events', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  await collectEvent({
    root,
    payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess_events', prompt: 'Run tests' }
  });

  const result = await collectEvent({
    root,
    payload: {
      hook_event_name: 'PostToolUse',
      session_id: 'sess_events',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { exit_code: 1, output: 'API_TOKEN=secretsecretsecretsecretsecretsecret failed' }
    }
  });

  const lines = (await fs.readFile(result.paths.eventsPath, 'utf8')).trim().split('\n');
  const event = JSON.parse(lines.at(-1));
  assert.equal(event.session_id, 'sess_events');
  assert.equal(event.tool, 'Bash');
  assert.equal(event.status, 'failure');
  assert.deepEqual(event.signals, ['test_failure']);
  assert.equal(JSON.stringify(event).includes('secretsecret'), false);
});
```

- [ ] **Step 2: Implement hook payload adapter**

```js
// src/adapters/hook-payload.js
export function normalizeHookPayload(payload, fallbackRoot = process.cwd()) {
  const hook = payload.hook_event_name || payload.hook || payload.event || 'PostToolUse';
  const runtime = payload.runtime || payload.source || detectRuntime(payload);
  const sessionId = payload.session_id || payload.sessionId || payload.conversation_id || payload.thread_id || 'unknown-session';
  const toolInput = payload.tool_input || payload.input || {};
  const toolResponse = payload.tool_response || payload.response || {};

  return {
    runtime,
    hook,
    sessionId,
    root: payload.cwd || payload.working_directory || payload.workspace || fallbackRoot,
    prompt: payload.prompt || payload.user_prompt || payload.message || '',
    tool: payload.tool_name || payload.tool || payload.toolName || (hook === 'UserPromptSubmit' ? 'UserPrompt' : 'Other'),
    toolInput,
    toolResponse,
    command: toolInput.command || toolInput.cmd || payload.command || '',
    output: toolResponse.output || toolResponse.stderr || toolResponse.stdout || payload.output || '',
    exitCode: Number.isInteger(toolResponse.exit_code) ? toolResponse.exit_code : toolResponse.exitCode
  };
}

function detectRuntime(payload) {
  if (payload.codex || payload.thread_id || payload.conversation_id) {
    return 'codex';
  }
  return 'claude';
}
```

- [ ] **Step 3: Implement collector library**

```js
// src/collect-event.js
import fs from 'node:fs/promises';
import { resolveSessionPaths } from './core/session-paths.js';
import { normalizeEvent } from './core/event-schema.js';
import { normalizeHookPayload } from './adapters/hook-payload.js';

export async function collectEvent({ root = process.cwd(), payload }) {
  const normalized = normalizeHookPayload(payload, root);
  const hook = normalized.hook;
  const sessionId = normalized.sessionId;
  const paths = resolveSessionPaths({ root: normalized.root, sessionId });
  await fs.mkdir(paths.sessionDir, { recursive: true });

  if (hook === 'UserPromptSubmit') {
    const metadata = {
      session_id: sessionId,
      created_at: new Date().toISOString(),
      runtime: normalized.runtime,
      working_directory: normalized.root,
      original_prompt: normalized.prompt,
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
  const status = exitCode === 0 ? 'success' : exitCode > 0 ? 'failure' : 'unknown';

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
  const text = `${command}\n${output}`.toLowerCase();
  if (status === 'failure' && /\b(test|vitest|jest|pytest|node --test)\b/.test(text)) {
    signals.push('test_failure');
  }
  if (/\b(npm|pnpm|yarn) (install|add)\b/.test(text)) {
    signals.push('dependency_change');
  }
  if (/\b(config|convention|preference|prefer)\b/.test(text)) {
    signals.push('project_convention');
  }
  return signals;
}
```

- [ ] **Step 4: Implement collector CLI**

```js
// scripts/collect-event.js
#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { collectEvent } from '../src/collect-event.js';

const input = await readStdin();
const payload = input ? JSON.parse(input) : {};
const runtimeArgIndex = process.argv.indexOf('--runtime');
if (runtimeArgIndex >= 0 && process.argv[runtimeArgIndex + 1]) {
  payload.runtime = process.argv[runtimeArgIndex + 1];
}
const root = payload.cwd || payload.working_directory || process.cwd();

await collectEvent({ root, payload });

async function readStdin() {
  if (process.stdin.isTTY) {
    return '';
  }
  return readFile(0, 'utf8');
}
```

- [ ] **Step 5: Make script executable**

Run: `chmod +x scripts/collect-event.js`

Expected: command exits with code 0.

- [ ] **Step 6: Run collector tests**

Run: `npm test -- test/collect-event.test.js`

Expected: PASS with two passing tests.

- [ ] **Step 7: Commit**

```bash
git add src/adapters/hook-payload.js src/collect-event.js scripts/collect-event.js test/collect-event.test.js
git commit -m "feat: collect bypass session events"
```

---

### Task 4: Session Reviewer

**Files:**
- Create: `src/review-session.js`
- Create: `scripts/review-session.js`
- Create: `prompts/reviewer.md`
- Test: `test/review-session.test.js`

- [ ] **Step 1: Write failing reviewer tests**

```js
// test/review-session.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectEvent } from '../src/collect-event.js';
import { reviewSession } from '../src/review-session.js';

test('reviewSession suggests durable knowledge from convention evidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  await collectEvent({ root, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess_review', prompt: 'Use Node only' } });
  await collectEvent({
    root,
    payload: {
      hook_event_name: 'PostToolUse',
      session_id: 'sess_review',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { exit_code: 0, output: 'Project convention: use node:test and avoid runtime dependencies.' }
    }
  });

  const result = await reviewSession({ root, sessionId: 'sess_review' });
  assert.equal(result.session_id, 'sess_review');
  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].kind, 'project_convention');
  assert.equal(result.suggestions[0].target.endsWith('AGENTS.md'), true);
});

test('reviewSession emits no suggestions without durable signals', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  await collectEvent({ root, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess_empty', prompt: 'hello' } });

  const result = await reviewSession({ root, sessionId: 'sess_empty' });
  assert.deepEqual(result.suggestions, []);
});
```

- [ ] **Step 2: Add reviewer prompt**

```md
# Evo Bypass Reviewer

You review one completed agent session and identify only durable, reusable knowledge.

Return suggestions only when the event evidence supports a future-useful knowledge update. Do not suggest saving secrets, credentials, raw command output, private personal data, or one-off task details.

Every suggestion must include:
- type of knowledge
- confidence
- target file
- event evidence ids
- exact proposed text
- rationale

Prefer no suggestion over a weak suggestion. The main agent must ask the user before any update is applied.
```

- [ ] **Step 3: Implement reviewer library**

```js
// src/review-session.js
import fs from 'node:fs/promises';
import { resolveSessionPaths } from './core/session-paths.js';
import { normalizeSuggestion } from './core/event-schema.js';

export async function reviewSession({ root = process.cwd(), sessionId }) {
  const paths = resolveSessionPaths({ root, sessionId });
  const events = await readEvents(paths.eventsPath);
  const target = await resolveKnowledgeTarget(paths);
  const suggestions = events.flatMap((event) => suggestionForEvent(event, target)).slice(0, 10);
  const result = {
    session_id: sessionId,
    summary: suggestions.length > 0
      ? `Found ${suggestions.length} possible knowledge update(s).`
      : 'No durable knowledge updates suggested for this session.',
    suggestions
  };

  await fs.mkdir(paths.sessionDir, { recursive: true });
  await fs.writeFile(paths.suggestionsPath, `${JSON.stringify(result, null, 2)}\n`);
  await fs.writeFile(paths.reviewerLogPath, `${result.summary}\n`);
  return result;
}

async function readEvents(eventsPath) {
  try {
    const content = await fs.readFile(eventsPath, 'utf8');
    return content.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function resolveKnowledgeTarget(paths) {
  try {
    const config = JSON.parse(await fs.readFile(paths.configPath, 'utf8'));
    return config.knowledgeTarget || paths.defaultKnowledgePath;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return paths.defaultKnowledgePath;
    }
    throw error;
  }
}

function suggestionForEvent(event, target) {
  const text = `${event.summary}\n${event.evidence.join('\n')}`;
  if (event.signals.includes('project_convention') || /project convention/i.test(text)) {
    return [normalizeSuggestion({
      kind: 'project_convention',
      confidence: 'medium',
      target,
      evidence: [event.id],
      proposed_text: extractKnowledgeText(text, 'Project convention'),
      rationale: 'The session included explicit convention evidence that may affect future work in this repository.'
    }, target)];
  }
  if (event.signals.includes('test_failure')) {
    return [normalizeSuggestion({
      kind: 'failure_pattern',
      confidence: 'low',
      target,
      evidence: [event.id],
      proposed_text: `Observed test failure pattern: ${event.summary}`,
      rationale: 'The failed command may be useful if the same failure recurs, but it needs user confirmation before saving.'
    }, target)];
  }
  return [];
}

function extractKnowledgeText(text, fallback) {
  const match = text.match(/Project convention:\s*(.+)/i);
  return match ? `Project convention: ${match[1].trim()}` : fallback;
}
```

- [ ] **Step 4: Implement reviewer CLI**

```js
// scripts/review-session.js
#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { reviewSession } from '../src/review-session.js';

const input = await readStdin();
const payload = input ? JSON.parse(input) : {};
const sessionId = firstNonFlagArg()
  || payload.session_id
  || payload.sessionId
  || payload.conversation_id
  || payload.thread_id
  || process.env.CLAUDE_SESSION_ID
  || process.env.CODEX_SESSION_ID;
if (!sessionId) {
  console.error('Usage: scripts/review-session.js <session-id>');
  process.exit(1);
}

const root = payload.cwd || payload.working_directory || payload.workspace || process.cwd();
const result = await reviewSession({ root, sessionId });
console.log(formatReport(result));

async function readStdin() {
  if (process.stdin.isTTY) {
    return '';
  }
  return readFile(0, 'utf8');
}

function firstNonFlagArg() {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--runtime') {
      index += 1;
      continue;
    }
    if (!args[index].startsWith('--')) {
      return args[index];
    }
  }
  return undefined;
}

function formatReport(result) {
  if (result.suggestions.length === 0) {
    return 'Knowledge Update Suggestions\n\nNo durable knowledge updates suggested for this session.';
  }

  const lines = [
    'Knowledge Update Suggestions',
    '',
    `I found ${result.suggestions.length} possible knowledge update(s) from this task.`,
    'Ask the user whether they want to apply them before running the updater.',
    ''
  ];

  for (const suggestion of result.suggestions) {
    lines.push(`- ${suggestion.id} [${suggestion.kind}, ${suggestion.confidence}] -> ${suggestion.target}`);
    lines.push(`  Proposed: ${suggestion.proposed_text}`);
    lines.push(`  Evidence: ${suggestion.evidence.join(', ')}`);
  }

  return lines.join('\n');
}
```

- [ ] **Step 5: Make script executable**

Run: `chmod +x scripts/review-session.js`

Expected: command exits with code 0.

- [ ] **Step 6: Run reviewer tests**

Run: `npm test -- test/review-session.test.js`

Expected: PASS with two passing tests.

- [ ] **Step 7: Commit**

```bash
git add src/review-session.js scripts/review-session.js prompts/reviewer.md test/review-session.test.js
git commit -m "feat: review sessions for knowledge suggestions"
```

---

### Task 5: Approval-Gated Updater

**Files:**
- Create: `src/apply-approved-update.js`
- Create: `scripts/apply-approved-update.js`
- Test: `test/apply-approved-update.test.js`

- [ ] **Step 1: Write failing updater tests**

```js
// test/apply-approved-update.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveSessionPaths } from '../src/core/session-paths.js';
import { applyApprovedUpdate } from '../src/apply-approved-update.js';

test('applyApprovedUpdate refuses to write without approval', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const paths = resolveSessionPaths({ root, sessionId: 'sess_apply' });
  await fs.mkdir(paths.sessionDir, { recursive: true });
  await fs.writeFile(paths.suggestionsPath, JSON.stringify({
    session_id: 'sess_apply',
    suggestions: [{ id: 'sug_1', target: paths.defaultKnowledgePath, proposed_text: 'Remember this.' }]
  }));

  await assert.rejects(
    applyApprovedUpdate({ root, sessionId: 'sess_apply' }),
    /approval.json is required/
  );
});

test('applyApprovedUpdate writes only approved suggestions and records patch', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const paths = resolveSessionPaths({ root, sessionId: 'sess_apply_ok' });
  await fs.mkdir(paths.sessionDir, { recursive: true });
  await fs.writeFile(paths.suggestionsPath, JSON.stringify({
    session_id: 'sess_apply_ok',
    suggestions: [
      { id: 'sug_1', target: paths.defaultKnowledgePath, proposed_text: 'Project convention: use node:test.' },
      { id: 'sug_2', target: paths.defaultKnowledgePath, proposed_text: 'Do not write me.' }
    ]
  }));
  await fs.writeFile(paths.approvalPath, JSON.stringify({
    approved_at: new Date().toISOString(),
    approved_suggestion_ids: ['sug_1'],
    approval_text: 'yes, apply sug_1'
  }));

  const result = await applyApprovedUpdate({ root, sessionId: 'sess_apply_ok' });
  const knowledge = await fs.readFile(paths.defaultKnowledgePath, 'utf8');
  const patch = await fs.readFile(paths.appliedPatchPath, 'utf8');

  assert.equal(result.applied.length, 1);
  assert.match(knowledge, /Project convention: use node:test/);
  assert.equal(knowledge.includes('Do not write me'), false);
  assert.match(patch, /sug_1/);
});
```

- [ ] **Step 2: Implement updater library**

```js
// src/apply-approved-update.js
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSessionPaths } from './core/session-paths.js';

export async function applyApprovedUpdate({ root = process.cwd(), sessionId }) {
  const paths = resolveSessionPaths({ root, sessionId });
  const suggestions = await readJson(paths.suggestionsPath, 'suggestions.json is required');
  const approval = await readJson(paths.approvalPath, 'approval.json is required before applying updates');
  const approvedIds = new Set(approval.approved_suggestion_ids || []);

  if (approvedIds.size === 0 || typeof approval.approval_text !== 'string' || approval.approval_text.trim() === '') {
    throw new Error('approval must include approved_suggestion_ids and approval_text');
  }

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
```

- [ ] **Step 3: Implement updater CLI**

```js
// scripts/apply-approved-update.js
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
```

- [ ] **Step 4: Make script executable**

Run: `chmod +x scripts/apply-approved-update.js`

Expected: command exits with code 0.

- [ ] **Step 5: Run updater tests**

Run: `npm test -- test/apply-approved-update.test.js`

Expected: PASS with two passing tests.

- [ ] **Step 6: Commit**

```bash
git add src/apply-approved-update.js scripts/apply-approved-update.js test/apply-approved-update.test.js
git commit -m "feat: apply approved knowledge updates"
```

---

### Task 6: Plugin Manifest, Claude/Codex Hooks, Schemas, And Docs

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `hooks/claude-hooks.json`
- Create: `hooks/codex-hooks.json`
- Create: `schemas/session-event.schema.json`
- Create: `schemas/suggestion.schema.json`
- Create: `README.md`
- Test: `test/plugin-files.test.js`

- [ ] **Step 1: Write failing plugin file tests**

```js
// test/plugin-files.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('plugin manifest and hooks are valid JSON with expected lifecycle hooks', async () => {
  const manifest = JSON.parse(await fs.readFile('.claude-plugin/plugin.json', 'utf8'));
  const claudeHooks = JSON.parse(await fs.readFile('hooks/claude-hooks.json', 'utf8'));
  const codexHooks = JSON.parse(await fs.readFile('hooks/codex-hooks.json', 'utf8'));

  assert.equal(manifest.name, 'evo-bypass');
  assert.equal(manifest.version, '0.1.0');
  assert.ok(claudeHooks.hooks.UserPromptSubmit);
  assert.ok(claudeHooks.hooks.PostToolUse);
  assert.ok(claudeHooks.hooks.Stop);
  assert.ok(codexHooks.hooks.UserPromptSubmit);
  assert.ok(codexHooks.hooks.PostToolUse);
  assert.ok(codexHooks.hooks.Stop);
  assert.ok(codexHooks.hooks.SessionStart);
  assert.match(JSON.stringify(claudeHooks), /collect-event\.js/);
  assert.match(JSON.stringify(codexHooks), /--runtime codex/);
});
```

- [ ] **Step 2: Add plugin manifest**

```json
{
  "name": "evo-bypass",
  "version": "0.1.0",
  "description": "Advisory-first bypass agent that suggests knowledge updates from Claude Code and Codex session behavior.",
  "author": {
    "name": "Sakki"
  }
}
```

- [ ] **Step 3: Add Claude hooks config**

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node scripts/collect-event.js"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node scripts/collect-event.js"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node scripts/review-session.js \"$CLAUDE_SESSION_ID\"",
            "asyncRewake": true
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 4: Add Codex hooks config**

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node scripts/collect-event.js --runtime codex",
            "timeout": 5
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node scripts/collect-event.js --runtime codex",
            "timeout": 5
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node scripts/collect-event.js --runtime codex",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node scripts/review-session.js --runtime codex",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 5: Add event schema documentation**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Evo Bypass Session Event",
  "type": "object",
  "required": ["id", "session_id", "timestamp", "hook", "tool", "summary", "paths", "status", "signals", "evidence"],
  "properties": {
    "id": { "type": "string" },
    "session_id": { "type": "string" },
    "timestamp": { "type": "string" },
    "hook": { "enum": ["SessionStart", "UserPromptSubmit", "PostToolUse", "PermissionRequest", "Stop"] },
    "tool": { "type": "string" },
    "summary": { "type": "string" },
    "paths": { "type": "array", "items": { "type": "string" } },
    "status": { "enum": ["success", "failure", "unknown"] },
    "signals": { "type": "array", "items": { "type": "string" } },
    "evidence": { "type": "array", "items": { "type": "string" } }
  }
}
```

- [ ] **Step 6: Add suggestion schema documentation**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Evo Bypass Knowledge Suggestion",
  "type": "object",
  "required": ["session_id", "summary", "suggestions"],
  "properties": {
    "session_id": { "type": "string" },
    "summary": { "type": "string" },
    "suggestions": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "kind", "confidence", "target", "evidence", "proposed_text", "rationale"],
        "properties": {
          "id": { "type": "string" },
          "kind": { "enum": ["user_preference", "project_convention", "tool_learning", "failure_pattern", "environment_fact", "external_fact"] },
          "confidence": { "enum": ["low", "medium", "high"] },
          "target": { "type": "string" },
          "evidence": { "type": "array", "items": { "type": "string" } },
          "proposed_text": { "type": "string" },
          "rationale": { "type": "string" }
        }
      }
    }
  }
}
```

- [ ] **Step 7: Add README**

```md
# Evo Bypass

Evo Bypass is an advisory-first hook package for Claude Code and Codex. It records structured session events, reviews them at task completion, and suggests local knowledge updates.

It never updates the knowledge base from the review hook. The main agent must ask the user for confirmation before running `scripts/apply-approved-update.js`.

## Flow

1. `UserPromptSubmit` creates `.bypass/sessions/<session-id>/metadata.json`.
2. `PostToolUse` appends redacted events to `events.jsonl`.
3. `Stop` runs the reviewer and writes `suggestions.json`.
4. The async rewake report asks the main agent to request user approval.
5. After approval, run:

```bash
node scripts/apply-approved-update.js <session-id> <sug_1,sug_2> "user approved these updates"
```

By default, approved updates are routed to `AGENTS.md`.

## Codex Installation

Merge `hooks/codex-hooks.json` into `~/.codex/hooks.json`. Existing hooks should stay in place; add Evo Bypass as an additional command hook under the same lifecycle events.

Codex supports `SessionStart`, `UserPromptSubmit`, `PostToolUse`, and `Stop` hook entries in the local hooks file. Evo Bypass uses the same collector and reviewer scripts as Claude.
```

- [ ] **Step 8: Run plugin file tests**

Run: `npm test -- test/plugin-files.test.js`

Expected: PASS with one passing test.

- [ ] **Step 9: Commit**

```bash
git add .claude-plugin/plugin.json hooks/claude-hooks.json hooks/codex-hooks.json schemas/session-event.schema.json schemas/suggestion.schema.json README.md test/plugin-files.test.js
git commit -m "feat: add claude and codex hook metadata"
```

---

### Task 7: End-To-End Verification

**Files:**
- Create: `test/e2e-session.test.js`
- Modify: `README.md`

- [ ] **Step 1: Write end-to-end test**

```js
// test/e2e-session.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectEvent } from '../src/collect-event.js';
import { reviewSession } from '../src/review-session.js';
import { applyApprovedUpdate } from '../src/apply-approved-update.js';
import { resolveSessionPaths } from '../src/core/session-paths.js';

test('full bypass flow records, reviews, requires approval, and applies approved update', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const sessionId = 'sess_e2e';
  const paths = resolveSessionPaths({ root, sessionId });

  await collectEvent({ root, payload: { hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: 'Capture project convention' } });
  await collectEvent({
    root,
    payload: {
      hook_event_name: 'PostToolUse',
      session_id: sessionId,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { exit_code: 0, output: 'Project convention: ask before updating local knowledge.' }
    }
  });

  const review = await reviewSession({ root, sessionId });
  assert.equal(review.suggestions.length, 1);

  await assert.rejects(
    applyApprovedUpdate({ root, sessionId }),
    /approval.json is required/
  );

  await fs.writeFile(paths.approvalPath, JSON.stringify({
    approved_at: new Date().toISOString(),
    approved_suggestion_ids: [review.suggestions[0].id],
    approval_text: 'confirmed by user'
  }));

  const apply = await applyApprovedUpdate({ root, sessionId });
  const knowledge = await fs.readFile(paths.defaultKnowledgePath, 'utf8');

  assert.equal(apply.applied.length, 1);
  assert.match(knowledge, /ask before updating local knowledge/);
});
```

- [ ] **Step 2: Run full test suite**

Run: `npm test`

Expected: PASS with all test files passing.

- [ ] **Step 3: Update README with verification command**

Add this section:

```md
## Development

Run the full test suite:

```bash
npm test
```
```

- [ ] **Step 4: Run full test suite again**

Run: `npm test`

Expected: PASS with all test files passing.

- [ ] **Step 5: Commit**

```bash
git add test/e2e-session.test.js README.md
git commit -m "test: verify end-to-end bypass flow"
```

---

## Self-Review Notes

- Spec coverage: hook lifecycle for Claude and Codex is covered by Tasks 3, 4, and 6; session storage by Tasks 1, 3, 4, and 5; event and suggestion schemas by Tasks 2, 4, and 6; approval-gated update flow by Task 5; privacy redaction by Task 2; testing by Tasks 1 through 7.
- Placeholder scan: the plan contains no unresolved placeholder steps. Every code-producing step includes concrete content.
- Type consistency: the plan consistently uses `sessionId` in library inputs, `session_id` in persisted JSON, `suggestions.json`, `approval.json`, and `AGENTS.md` as the default target.
