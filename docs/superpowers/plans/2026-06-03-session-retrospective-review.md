# Session Retrospective Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade Evo Bypass so every Stop hook produces a structured task retrospective, with knowledge updates represented as retrospective actions rather than top-level suggestions.

**Architecture:** Keep the existing hook collector and Stop CLI, but change `reviewSession()` to write `retrospective.json` and Markdown reports as the authoritative review result. Add a small retrospective schema module that normalizes findings/actions, update the AI reviewer to validate retrospective output, and update the apply script to read approved `update_knowledge` actions while keeping legacy `suggestions.json` fallback.

**Tech Stack:** Node.js ESM, `node:test`, filesystem JSON/Markdown artifacts, existing OpenAI-compatible reviewer provider.

---

## File Structure

- Modify `src/core/session-paths.js`: add paths for `retrospective.json`, local `retrospective.md`, and keep legacy `suggestionsPath`.
- Create `src/core/retrospective-schema.js`: normalize/validate retrospective results, findings, and actions.
- Modify `src/review-session.js`: return retrospective results, write reports every time, derive knowledge actions from rules, and stop writing new `suggestions.json` as primary output.
- Modify `src/ai-reviewer.js`: send the new retrospective prompt and validate AI findings/actions instead of suggestions.
- Modify `prompts/reviewer.md`: describe retrospective JSON output and action classification rules.
- Modify `scripts/review-session.js`: format Stop hook messages from retrospective findings and decide Codex `continue` from approval-needed actions.
- Modify `src/apply-approved-update.js`: read approved `update_knowledge` actions from `retrospective.json`; fallback to legacy `suggestions.json`.
- Create `schemas/retrospective.schema.json`: JSON Schema for the new primary result.
- Modify `schemas/suggestion.schema.json`: mark as legacy in title/description without changing compatibility.
- Modify `README.md`: document retrospective artifacts and updated Stop behavior.
- Modify tests:
  - `test/session-paths.test.js`
  - `test/review-session.test.js`
  - `test/apply-approved-update.test.js`
  - `test/event-schema.test.js` only if schema helpers move shared constants

---

### Task 1: Add Retrospective Paths And Schema Normalizer

**Files:**
- Modify: `src/core/session-paths.js`
- Create: `src/core/retrospective-schema.js`
- Modify: `test/session-paths.test.js`
- Create: `test/retrospective-schema.test.js`

- [ ] **Step 1: Write failing path tests**

Add this test to `test/session-paths.test.js`:

```js
test('resolveSessionPaths includes retrospective artifact paths', () => {
  const paths = resolveSessionPaths({ root: '/tmp/project', sessionId: 'sess_paths' });

  assert.equal(paths.retrospectivePath, path.join('/tmp/project', '.bypass', 'sessions', 'sess_paths', 'retrospective.json'));
  assert.equal(paths.retrospectiveMarkdownPath, path.join('/tmp/project', '.bypass', 'sessions', 'sess_paths', 'retrospective.md'));
  assert.equal(paths.suggestionsPath, path.join('/tmp/project', '.bypass', 'sessions', 'sess_paths', 'suggestions.json'));
});
```

- [ ] **Step 2: Write failing retrospective schema tests**

Create `test/retrospective-schema.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRetrospectiveResult, extractKnowledgeActions } from '../src/core/retrospective-schema.js';

test('normalizeRetrospectiveResult creates a smooth empty retrospective', () => {
  const result = normalizeRetrospectiveResult({ sessionId: 'sess_empty', findings: [] });

  assert.equal(result.session_id, 'sess_empty');
  assert.equal(result.retrospective.outcome, 'completed');
  assert.equal(result.retrospective.quality, 'smooth');
  assert.deepEqual(result.retrospective.findings, []);
  assert.match(result.summary, /No retrospective actions/);
});

test('normalizeRetrospectiveResult keeps valid update_knowledge action fields', () => {
  const result = normalizeRetrospectiveResult({
    sessionId: 'sess_knowledge',
    outcome: 'partial',
    quality: 'minor_issues',
    findings: [{
      id: 'finding_knowledge',
      category: 'knowledge',
      severity: 'medium',
      evidence: ['evt_1'],
      diagnosis: 'A durable convention was observed.',
      recommendation: 'Ask whether to save it.',
      action: {
        type: 'update_knowledge',
        confidence: 'high',
        target: '/tmp/project/AGENTS.md',
        target_reason: 'Repository-level convention.',
        proposed_text: 'Project convention: use node:test.',
        rationale: 'Future tests should follow this.'
      }
    }]
  });

  assert.equal(result.retrospective.findings[0].action.type, 'update_knowledge');
  assert.equal(result.retrospective.findings[0].action.proposed_text, 'Project convention: use node:test.');
  assert.equal(extractKnowledgeActions(result).length, 1);
});

test('normalizeRetrospectiveResult drops invalid findings', () => {
  const result = normalizeRetrospectiveResult({
    sessionId: 'sess_invalid',
    findings: [{
      id: 'finding_bad',
      category: 'unknown',
      severity: 'medium',
      evidence: ['evt_1'],
      diagnosis: 'Bad category.',
      recommendation: 'Drop this.',
      action: { type: 'no_action' }
    }]
  });

  assert.deepEqual(result.retrospective.findings, []);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
npm test -- test/session-paths.test.js test/retrospective-schema.test.js
```

Expected: fail because `retrospectivePath`, `retrospectiveMarkdownPath`, and `src/core/retrospective-schema.js` do not exist.

- [ ] **Step 4: Add retrospective paths**

Update `src/core/session-paths.js` return object:

```js
    retrospectivePath: path.join(sessionDir, 'retrospective.json'),
    retrospectiveMarkdownPath: path.join(sessionDir, 'retrospective.md'),
    suggestionsPath: path.join(sessionDir, 'suggestions.json'),
```

- [ ] **Step 5: Implement retrospective schema normalizer**

Create `src/core/retrospective-schema.js`:

```js
import { randomUUID } from 'node:crypto';

const OUTCOMES = new Set(['completed', 'partial', 'failed', 'unknown']);
const QUALITIES = new Set(['smooth', 'minor_issues', 'significant_issues']);
const CATEGORIES = new Set(['knowledge', 'skill', 'code', 'agent_usage', 'environment']);
const SEVERITIES = new Set(['low', 'medium', 'high']);
const ACTION_TYPES = new Set(['update_knowledge', 'create_skill', 'improve_code', 'adjust_agent_usage', 'fix_environment', 'no_action']);
const CONFIDENCES = new Set(['low', 'medium', 'high']);

export function normalizeRetrospectiveResult(input) {
  const sessionId = requiredString(input.sessionId || input.session_id, 'sessionId');
  const findings = Array.isArray(input.findings)
    ? input.findings.map(normalizeFinding).filter(Boolean)
    : Array.isArray(input.retrospective?.findings)
      ? input.retrospective.findings.map(normalizeFinding).filter(Boolean)
      : [];
  const outcome = OUTCOMES.has(input.outcome || input.retrospective?.outcome)
    ? (input.outcome || input.retrospective.outcome)
    : inferOutcome(findings);
  const quality = QUALITIES.has(input.quality || input.retrospective?.quality)
    ? (input.quality || input.retrospective.quality)
    : inferQuality(findings);
  const summary = typeof input.summary === 'string' && input.summary.trim()
    ? input.summary.trim()
    : defaultSummary({ findings });

  return {
    session_id: sessionId,
    summary,
    retrospective: {
      outcome,
      quality,
      findings
    }
  };
}

export function extractKnowledgeActions(result) {
  return (result?.retrospective?.findings || [])
    .filter((finding) => finding.action?.type === 'update_knowledge');
}

function normalizeFinding(finding) {
  if (!finding || typeof finding !== 'object') {
    return undefined;
  }
  if (!CATEGORIES.has(finding.category) || !SEVERITIES.has(finding.severity)) {
    return undefined;
  }
  const action = normalizeAction(finding.action);
  if (!action) {
    return undefined;
  }
  const normalized = {
    id: typeof finding.id === 'string' && finding.id.trim() ? finding.id.trim() : `finding_${randomUUID()}`,
    category: finding.category,
    severity: finding.severity,
    evidence: arrayOfStrings(finding.evidence),
    diagnosis: stringField(finding.diagnosis),
    recommendation: stringField(finding.recommendation),
    action
  };
  if (normalized.evidence.length === 0 || !normalized.diagnosis || !normalized.recommendation) {
    return undefined;
  }
  return normalized;
}

function normalizeAction(action) {
  if (!action || typeof action !== 'object' || !ACTION_TYPES.has(action.type)) {
    return undefined;
  }
  const normalized = {
    type: action.type,
    confidence: CONFIDENCES.has(action.confidence) ? action.confidence : 'low'
  };
  for (const field of ['target', 'target_reason', 'proposed_text', 'rationale']) {
    if (typeof action[field] === 'string' && action[field].trim()) {
      normalized[field] = action[field].trim();
    }
  }
  if (normalized.type === 'update_knowledge' && (!normalized.target || !normalized.proposed_text)) {
    return undefined;
  }
  return normalized;
}

function inferOutcome(findings) {
  return findings.some((finding) => finding.severity === 'high') ? 'partial' : 'completed';
}

function inferQuality(findings) {
  if (findings.some((finding) => finding.severity === 'high')) {
    return 'significant_issues';
  }
  if (findings.length > 0) {
    return 'minor_issues';
  }
  return 'smooth';
}

function defaultSummary({ findings }) {
  return findings.length === 0
    ? 'No retrospective actions were suggested for this session.'
    : `Found ${findings.length} retrospective action(s).`;
}

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()) : [];
}

function stringField(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}
```

- [ ] **Step 6: Run task tests**

Run:

```bash
npm test -- test/session-paths.test.js test/retrospective-schema.test.js
```

Expected: pass.

- [ ] **Step 7: Commit**

Run:

```bash
git add src/core/session-paths.js src/core/retrospective-schema.js test/session-paths.test.js test/retrospective-schema.test.js
git commit -m "feat: add retrospective schema"
```

---

### Task 2: Make Rules Reviewer Produce Retrospectives

**Files:**
- Modify: `src/review-session.js`
- Modify: `test/review-session.test.js`

- [ ] **Step 1: Write failing tests for always-written retrospectives**

Update the existing "no suggestions" test in `test/review-session.test.js` to expect retrospective artifacts:

```js
test('reviewSession writes a smooth retrospective without durable signals', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const bypassDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-home-'));
  await collectEvent({ root, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess_empty', prompt: 'hello' } });

  const result = await reviewSession({ root, sessionId: 'sess_empty', bypassDir });
  const paths = resolveSessionPaths({ root, sessionId: 'sess_empty' });

  assert.equal(result.session_id, 'sess_empty');
  assert.equal(result.retrospective.quality, 'smooth');
  assert.deepEqual(result.retrospective.findings, []);
  assert.equal(result.retrospective_report_path, path.join(bypassDir, 'retrospective', 'sess_empty.md'));
  assert.match(await fs.readFile(paths.retrospectivePath, 'utf8'), /"quality": "smooth"/);
  assert.match(await fs.readFile(paths.retrospectiveMarkdownPath, 'utf8'), /No significant failures/);
});
```

- [ ] **Step 2: Write failing test for convention evidence as knowledge finding**

Add this test to `test/review-session.test.js`:

```js
test('reviewSession converts convention evidence into update_knowledge finding', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const bypassDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-home-'));
  await collectEvent({ root, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess_retro_knowledge', prompt: 'Use Node only' } });
  await collectEvent({
    root,
    payload: {
      hook_event_name: 'PostToolUse',
      session_id: 'sess_retro_knowledge',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { exit_code: 0, output: 'Project convention: use node:test and avoid runtime dependencies.' }
    }
  });

  const result = await reviewSession({ root, sessionId: 'sess_retro_knowledge', bypassDir });
  const finding = result.retrospective.findings[0];

  assert.equal(finding.category, 'knowledge');
  assert.equal(finding.action.type, 'update_knowledge');
  assert.equal(finding.action.target, path.join(root, 'AGENTS.md'));
  assert.match(finding.action.proposed_text, /use node:test/);
});
```

- [ ] **Step 3: Write failing test for test failure as non-knowledge finding**

Add:

```js
test('reviewSession converts test failure into code retrospective finding', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const bypassDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-home-'));
  await collectEvent({ root, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess_retro_test_failure', prompt: 'fix tests' } });
  await collectEvent({
    root,
    payload: {
      hook_event_name: 'PostToolUse',
      session_id: 'sess_retro_test_failure',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { exit_code: 1, output: 'not ok 1 test failed' }
    }
  });

  const result = await reviewSession({ root, sessionId: 'sess_retro_test_failure', bypassDir });
  const finding = result.retrospective.findings[0];

  assert.equal(finding.category, 'code');
  assert.equal(finding.action.type, 'improve_code');
  assert.match(finding.diagnosis, /test failure/i);
});
```

- [ ] **Step 4: Run tests to verify failure**

Run:

```bash
npm test -- test/review-session.test.js
```

Expected: fail because `reviewSession` still writes `suggestions.json` and lacks `retrospective`.

- [ ] **Step 5: Update `reviewSession()` result writing**

In `src/review-session.js`, import the new helpers:

```js
import { normalizeRetrospectiveResult, extractKnowledgeActions } from './core/retrospective-schema.js';
```

Change the main body after candidate building to:

```js
  const reviewed = await reviewRetrospective({ root: paths.root, sessionId, events, candidates, reviewer: config.reviewer });
  const result = normalizeRetrospectiveResult(reviewed);
  result.retrospective_report_path = await writeRetrospectiveReport({ bypassDir, result });

  await fs.mkdir(paths.sessionDir, { recursive: true });
  await fs.writeFile(paths.retrospectivePath, `${JSON.stringify(result, null, 2)}\n`);
  await fs.writeFile(paths.retrospectiveMarkdownPath, formatRetrospectiveMarkdown(result));
  await fs.writeFile(paths.reviewerLogPath, reviewerLog({ result, malformedCount }));
  return result;
```

- [ ] **Step 6: Replace rules suggestion functions with retrospective functions**

Rename `reviewSuggestions()` to `reviewRetrospective()` and make the rules path return:

```js
function reviewWithRules({ sessionId, events, candidates }) {
  const routeByEventId = new Map(candidates.map((candidate) => [candidate.event_id, candidate]));
  const findings = [];
  for (const event of events) {
    findings.push(...findingsForEvent(event, routeByEventId.get(event.id)));
  }
  return {
    sessionId,
    findings: dedupeFindings(findings).slice(0, 10)
  };
}
```

Use this `findingsForEvent()`:

```js
function findingsForEvent(event, route) {
  const evidence = Array.isArray(event.evidence) ? event.evidence : [];
  const signals = Array.isArray(event.signals) ? event.signals : [];
  const text = `${event.summary}\n${evidence.join('\n')}`;
  const knowledgeText = extractKnowledgeText(text);
  if ((signals.includes('project_convention') || /project convention/i.test(text)) && knowledgeText) {
    return [{
      id: `finding_${event.id.replace(/^evt_/, '')}`,
      category: 'knowledge',
      severity: 'medium',
      evidence: [event.id],
      diagnosis: 'The session included explicit convention evidence that may affect future work in this repository.',
      recommendation: 'Ask the user whether to save this convention for future tasks.',
      action: {
        type: 'update_knowledge',
        confidence: 'medium',
        target: route.target,
        target_reason: route.target_reason,
        proposed_text: knowledgeText,
        rationale: 'The convention is durable enough to consider saving, but still needs user confirmation.'
      }
    }];
  }
  if (signals.includes('test_failure')) {
    return [{
      id: `finding_${event.id.replace(/^evt_/, '')}`,
      category: 'code',
      severity: 'low',
      evidence: [event.id],
      diagnosis: `Observed test failure during this task: ${event.summary}`,
      recommendation: 'Use this as a code or test-design follow-up only if the same failure remains unresolved.',
      action: {
        type: 'improve_code',
        confidence: 'low',
        rationale: 'A failed test is useful task evidence, but not necessarily durable knowledge.'
      }
    }];
  }
  return [];
}
```

- [ ] **Step 7: Add Markdown report writer**

Replace `writeSuggestionReport()` with:

```js
async function writeRetrospectiveReport({ bypassDir, result }) {
  const reportDir = path.join(bypassDir, 'retrospective');
  const reportPath = path.join(reportDir, `${result.session_id}.md`);
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(reportPath, formatRetrospectiveMarkdown(result));
  return reportPath;
}
```

Add:

```js
function formatRetrospectiveMarkdown(result) {
  const lines = [
    '# Task Retrospective',
    '',
    `Session: ${result.session_id}`,
    '',
    '## Task Status',
    `Outcome: ${result.retrospective.outcome}`,
    `Quality: ${result.retrospective.quality}`,
    '',
    '## Findings'
  ];
  if (result.retrospective.findings.length === 0) {
    lines.push('No significant failures or reusable improvements were detected.');
  } else {
    for (const finding of result.retrospective.findings) {
      lines.push('');
      lines.push(`### ${finding.id}`);
      lines.push(`- Category: ${finding.category}`);
      lines.push(`- Severity: ${finding.severity}`);
      lines.push(`- Evidence: ${finding.evidence.join(', ')}`);
      lines.push(`- Diagnosis: ${finding.diagnosis}`);
      lines.push(`- Recommendation: ${finding.recommendation}`);
      lines.push(`- Action: ${finding.action.type}`);
      if (finding.action.target) {
        lines.push(`- Target: ${finding.action.target}`);
      }
      if (finding.action.proposed_text) {
        lines.push('');
        lines.push('Proposed knowledge:');
        lines.push('');
        lines.push(finding.action.proposed_text);
      }
    }
  }
  lines.push('');
  lines.push('## Recommended Actions');
  const actions = result.retrospective.findings.map((finding) => finding.action.type);
  lines.push(actions.length === 0 ? 'No action needed.' : actions.join(', '));
  return `${lines.join('\n')}\n`;
}
```

- [ ] **Step 8: Update reviewer log**

Change `reviewerLog()` to:

```js
function reviewerLog({ result, malformedCount }) {
  const lines = [result.summary];
  lines.push(`Findings: ${result.retrospective.findings.length}`);
  lines.push(`Knowledge actions: ${extractKnowledgeActions(result).length}`);
  if (malformedCount > 0) {
    lines.push(`Skipped ${malformedCount} malformed event line(s).`);
  }
  return `${lines.join('\n')}\n`;
}
```

- [ ] **Step 9: Run task tests**

Run:

```bash
npm test -- test/review-session.test.js test/retrospective-schema.test.js
```

Expected: pass after updating old assertions that reference `suggestions`.

- [ ] **Step 10: Commit**

Run:

```bash
git add src/review-session.js test/review-session.test.js
git commit -m "feat: write session retrospectives"
```

---

### Task 3: Update AI Reviewer For Retrospective Output

**Files:**
- Modify: `src/ai-reviewer.js`
- Modify: `prompts/reviewer.md`
- Modify: `test/review-session.test.js`

- [ ] **Step 1: Write AI validation tests**

Add tests near the existing AI reviewer tests or create a focused section in `test/review-session.test.js` using the existing mocked HTTP server pattern if present:

```js
test('AI reviewer accepts valid retrospective findings', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const bypassDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-home-'));
  const server = await jsonReviewerServer({
    retrospective: {
      outcome: 'completed',
      quality: 'minor_issues',
      findings: [{
        id: 'finding_ai_knowledge',
        category: 'knowledge',
        severity: 'medium',
        evidence: ['evt_ai'],
        diagnosis: 'AI found a reusable convention.',
        recommendation: 'Ask whether to save it.',
        action: {
          type: 'update_knowledge',
          confidence: 'high',
          target: 'AGENTS.md',
          proposed_text: 'Project convention: keep AI review JSON strict.',
          rationale: 'Future reviewer changes need strict schemas.'
        }
      }]
    }
  });
  try {
    await fs.mkdir(path.join(root, '.bypass'), { recursive: true });
    await fs.writeFile(path.join(root, '.bypass', 'config.json'), JSON.stringify({
      reviewer: {
        mode: 'ai',
        fallback: 'none',
        provider: {
          type: 'openai-compatible',
          baseUrl: server.url,
          apiKey: 'test-key',
          model: 'test-model'
        }
      }
    }));
    await collectEvent({ root, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess_ai_retro', prompt: 'hello' } });
    await collectEvent({
      root,
      payload: {
        hook_event_name: 'PostToolUse',
        session_id: 'sess_ai_retro',
        tool_name: 'Bash',
        tool_response: { exit_code: 0, output: 'Project convention: keep AI review JSON strict.' }
      }
    });

    const result = await reviewSession({ root, sessionId: 'sess_ai_retro', bypassDir });

    assert.equal(result.retrospective.findings[0].action.type, 'update_knowledge');
    assert.equal(result.retrospective.findings[0].action.target, path.join(root, 'AGENTS.md'));
  } finally {
    await server.close();
  }
});
```

Use an existing test HTTP helper if one already exists in the file. If not, define `jsonReviewerServer()` in the test file:

```js
function jsonReviewerServer(payload) {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(payload) } }]
      }));
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}
```

- [ ] **Step 2: Write rejection test for invalid evidence**

Add:

```js
test('AI reviewer drops findings with unknown evidence ids', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const bypassDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-home-'));
  const server = await jsonReviewerServer({
    retrospective: {
      findings: [{
        id: 'finding_unknown_evidence',
        category: 'knowledge',
        severity: 'medium',
        evidence: ['evt_missing'],
        diagnosis: 'Bad evidence.',
        recommendation: 'Drop this.',
        action: {
          type: 'update_knowledge',
          target: 'AGENTS.md',
          proposed_text: 'Project convention: never write unsupported findings.'
        }
      }]
    }
  });
  try {
    await fs.mkdir(path.join(root, '.bypass'), { recursive: true });
    await fs.writeFile(path.join(root, '.bypass', 'config.json'), JSON.stringify({
      reviewer: {
        mode: 'ai',
        fallback: 'none',
        provider: {
          type: 'openai-compatible',
          baseUrl: server.url,
          apiKey: 'test-key',
          model: 'test-model'
        }
      }
    }));
    await collectEvent({ root, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess_ai_drop', prompt: 'hello' } });

    const result = await reviewSession({ root, sessionId: 'sess_ai_drop', bypassDir });

    assert.deepEqual(result.retrospective.findings, []);
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
npm test -- test/review-session.test.js
```

Expected: fail because AI validation still expects `suggestions`.

- [ ] **Step 4: Update prompt**

Replace `prompts/reviewer.md` with retrospective instructions matching the spec. The required JSON shape:

````md
# Evo Bypass Retrospective Reviewer

You review one completed agent session and produce a task retrospective.

Return JSON only, with this shape:

```json
{
  "retrospective": {
    "outcome": "completed",
    "quality": "minor_issues",
    "findings": [
      {
        "id": "finding_short_stable_id",
        "category": "knowledge",
        "severity": "medium",
        "evidence": ["evt_id"],
        "diagnosis": "What failed, improved, or should be remembered.",
        "recommendation": "What the main agent or user should do next.",
        "action": {
          "type": "update_knowledge",
          "confidence": "high",
          "target": "/absolute/path/from/candidates/AGENTS.md",
          "target_reason": "Why this candidate target is the right place.",
          "proposed_text": "Exact text to add or update.",
          "rationale": "Why this action is useful."
        }
      }
    ]
  }
}
```

Use only evidence ids present in events. For `update_knowledge`, use only target values from candidates. Return an empty findings array for smooth sessions.

Allowed categories: `knowledge`, `skill`, `code`, `agent_usage`, `environment`.
Allowed action types: `update_knowledge`, `create_skill`, `improve_code`, `adjust_agent_usage`, `fix_environment`, `no_action`.
Allowed severities and confidences: `low`, `medium`, `high`.

Use `update_knowledge` only for durable reusable knowledge. Use `create_skill` only for repeatable workflows worth packaging. Use `improve_code` only when project code or tests need change. Use `adjust_agent_usage` for workflow issues such as missing clarification or weak verification. Avoid secrets, credentials, private personal data, raw output dumps, and one-off details.
````

- [ ] **Step 5: Update AI payload validation**

In `src/ai-reviewer.js`, import:

```js
import { normalizeRetrospectiveResult } from './core/retrospective-schema.js';
```

Replace `validateAiSuggestions()` with:

```js
function validateAiRetrospective({ root, sessionId, events, candidates, parsed }) {
  const eventIds = new Set(events.map((event) => event.id));
  const targetByCandidate = new Map(candidates.map((candidate) => [path.resolve(candidate.target), candidate.target]));
  const findings = Array.isArray(parsed?.retrospective?.findings)
    ? parsed.retrospective.findings.map((finding) => normalizeAiFinding({ root, eventIds, targetByCandidate, finding })).filter(Boolean)
    : [];
  return normalizeRetrospectiveResult({
    sessionId,
    summary: parsed.summary,
    outcome: parsed?.retrospective?.outcome,
    quality: parsed?.retrospective?.quality,
    findings
  });
}
```

Add:

```js
function normalizeAiFinding({ root, eventIds, targetByCandidate, finding }) {
  if (!finding || typeof finding !== 'object') {
    return undefined;
  }
  const evidence = Array.isArray(finding.evidence)
    ? finding.evidence.filter((id) => eventIds.has(id))
    : [];
  if (evidence.length === 0) {
    return undefined;
  }
  const action = { ...(finding.action || {}) };
  if (action.type === 'update_knowledge') {
    const target = safeCandidateTarget({ root, target: action.target, targetByCandidate });
    if (!target) {
      return undefined;
    }
    action.target = target;
  }
  return {
    ...finding,
    evidence,
    action
  };
}
```

Replace `safeTarget()` with:

```js
function safeCandidateTarget({ root, target, targetByCandidate }) {
  if (typeof target !== 'string' || target.trim() === '') {
    return '';
  }
  const rootPath = path.resolve(root);
  const targetPath = path.resolve(rootPath, target);
  const relative = path.relative(rootPath, targetPath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return '';
  }
  return targetByCandidate.get(targetPath) || '';
}
```

Make `reviewWithAiProvider()` return `validateAiRetrospective({ root, sessionId, events, candidates, parsed })`.

- [ ] **Step 6: Update `review-session.js` AI branch**

Make `reviewRetrospective()` return the AI retrospective result directly:

```js
async function reviewRetrospective({ root, sessionId, events, candidates, reviewer }) {
  if (shouldUseAiReviewer(reviewer)) {
    try {
      return await reviewWithAiProvider({ root, sessionId, events, candidates, reviewer });
    } catch (error) {
      if (reviewer.fallback !== 'rules') {
        return { sessionId, findings: [] };
      }
    }
  }
  if (reviewer.mode === 'ai' && reviewer.fallback !== 'rules') {
    return { sessionId, findings: [] };
  }
  return reviewWithRules({ sessionId, events, candidates });
}
```

- [ ] **Step 7: Run task tests**

Run:

```bash
npm test -- test/review-session.test.js
```

Expected: pass.

- [ ] **Step 8: Commit**

Run:

```bash
git add src/ai-reviewer.js src/review-session.js prompts/reviewer.md test/review-session.test.js
git commit -m "feat: support AI retrospective review"
```

---

### Task 4: Update Stop CLI Output And Viewer Trigger

**Files:**
- Modify: `scripts/review-session.js`
- Modify: `src/core/config.js`
- Modify: `test/review-session.test.js`
- Modify: `test/config.test.js`

- [ ] **Step 1: Write failing Stop CLI tests**

Update the Codex clean-session test in `test/review-session.test.js`:

```js
test('review-session CLI prints valid Codex JSON for clean retrospective', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const bypassDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-home-'));
  await collectEvent({ root, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess_codex_empty', prompt: 'hello' } });

  const result = spawnSync(process.execPath, [reviewCliPath, '--runtime', 'codex'], {
    cwd: root,
    input: JSON.stringify({ session_id: 'sess_codex_empty', cwd: root }),
    env: { ...process.env, EVO_BYPASS_DIR: bypassDir },
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.continue, true);
  assert.match(output.systemMessage, /本次任务复盘无待处理动作/);
  assert.match(await fs.readFile(path.join(bypassDir, 'retrospective', 'sess_codex_empty.md'), 'utf8'), /Task Retrospective/);
});
```

Add a non-knowledge finding CLI test:

```js
test('review-session CLI links retrospective without forcing confirmation for non-knowledge findings', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const bypassDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-home-'));
  await collectEvent({ root, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess_codex_failure', prompt: 'fix tests' } });
  await collectEvent({
    root,
    payload: {
      hook_event_name: 'PostToolUse',
      session_id: 'sess_codex_failure',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { exit_code: 1, output: 'not ok 1 test failed' }
    }
  });

  const result = spawnSync(process.execPath, [reviewCliPath, '--runtime', 'codex'], {
    cwd: root,
    input: JSON.stringify({ session_id: 'sess_codex_failure', cwd: root }),
    env: { ...process.env, EVO_BYPASS_DIR: bypassDir },
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.continue, true);
  assert.match(output.systemMessage, /任务复盘报告/);
  assert.doesNotMatch(output.systemMessage, /是否应用/);
});
```

- [ ] **Step 2: Write failing viewer config test**

In `test/config.test.js`, add:

```js
test('shouldExposeViewer supports action count while preserving suggestion count compatibility', () => {
  assert.equal(shouldExposeViewer({
    viewer: { enabled: true, openMode: 'url', openOnlyWhenSuggestions: true },
    suggestionCount: 0,
    actionCount: 1
  }), true);
});
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
npm test -- test/review-session.test.js test/config.test.js
```

Expected: fail because CLI still reads `result.suggestions.length` and viewer uses only `suggestionCount`.

- [ ] **Step 4: Update Stop CLI summary logic**

In `scripts/review-session.js`, import or locally define:

```js
function knowledgeActionCount(result) {
  return (result.retrospective?.findings || [])
    .filter((finding) => finding.action?.type === 'update_knowledge')
    .length;
}

function findingCount(result) {
  return result.retrospective?.findings?.length || 0;
}
```

Change the success branch:

```js
  const knowledgeUpdates = knowledgeActionCount(result);
  const findings = findingCount(result);
  const viewerResult = await maybeStartViewer({ root, sessionId, actionCount: findings, suggestionCount: knowledgeUpdates });
```

Change Codex output:

```js
      continue: knowledgeUpdates === 0,
```

Change `formatReport()`:

```js
function formatReport(result, viewerResult) {
  const reportPath = result.retrospective_report_path || '';
  const knowledgeUpdates = knowledgeActionCount(result);
  const findings = findingCount(result);
  if (findings === 0) {
    return withViewerReport('本次任务复盘无待处理动作。', viewerResult);
  }
  if (knowledgeUpdates > 0) {
    return withViewerReport(
      `请告知用户：本次任务复盘总结了需要确认的知识更新。请阅读 ${reportPath} 文件，并询问用户是否应用其中的知识更新建议。`,
      viewerResult
    );
  }
  return withViewerReport(
    `请告知用户：本次任务生成了任务复盘报告，可阅读 ${reportPath} 了解失败、问题和后续改进建议。`,
    viewerResult
  );
}
```

- [ ] **Step 5: Update viewer exposure helper**

Change `src/core/config.js`:

```js
export function shouldExposeViewer({ viewer, suggestionCount, actionCount }) {
  if (!viewer?.enabled || viewer.openMode === 'off') {
    return false;
  }
  const visibleCount = Number.isInteger(actionCount) ? actionCount : suggestionCount;
  if (viewer.openOnlyWhenSuggestions && visibleCount === 0) {
    return false;
  }
  return true;
}
```

Change `maybeStartViewer()` to pass `actionCount`.

- [ ] **Step 6: Run task tests**

Run:

```bash
npm test -- test/review-session.test.js test/config.test.js
```

Expected: pass.

- [ ] **Step 7: Commit**

Run:

```bash
git add scripts/review-session.js src/core/config.js test/review-session.test.js test/config.test.js
git commit -m "feat: report retrospective stop output"
```

---

### Task 5: Apply Approved Knowledge Actions From Retrospective

**Files:**
- Modify: `src/apply-approved-update.js`
- Modify: `test/apply-approved-update.test.js`

- [ ] **Step 1: Write failing retrospective apply test**

Add to `test/apply-approved-update.test.js`:

```js
test('applyApprovedUpdate writes approved update_knowledge findings from retrospective', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-'));
  const paths = resolveSessionPaths({ root, sessionId: 'sess_apply_retro' });
  await fs.mkdir(paths.sessionDir, { recursive: true });
  await fs.writeFile(paths.retrospectivePath, JSON.stringify({
    session_id: 'sess_apply_retro',
    summary: 'Found one action.',
    retrospective: {
      outcome: 'completed',
      quality: 'minor_issues',
      findings: [{
        id: 'finding_knowledge',
        category: 'knowledge',
        severity: 'medium',
        evidence: ['evt_1'],
        diagnosis: 'Reusable convention.',
        recommendation: 'Save it.',
        action: {
          type: 'update_knowledge',
          confidence: 'high',
          target: paths.defaultKnowledgePath,
          proposed_text: 'Project convention: apply retrospective actions.',
          rationale: 'Future applies should use retrospective actions.'
        }
      }, {
        id: 'finding_code',
        category: 'code',
        severity: 'low',
        evidence: ['evt_2'],
        diagnosis: 'A test failed.',
        recommendation: 'Fix later.',
        action: { type: 'improve_code', confidence: 'low' }
      }]
    }
  }));
  await fs.writeFile(paths.approvalPath, JSON.stringify({
    approved_at: new Date().toISOString(),
    approved_suggestion_ids: ['finding_knowledge'],
    approval_text: 'yes, apply finding_knowledge'
  }));

  const result = await applyApprovedUpdate({ root, sessionId: 'sess_apply_retro' });
  const knowledge = await fs.readFile(paths.defaultKnowledgePath, 'utf8');

  assert.equal(result.applied.length, 1);
  assert.match(knowledge, /apply retrospective actions/);
});
```

- [ ] **Step 2: Write legacy fallback test**

Keep the existing `suggestions.json` fixture tests and rename the main happy-path test to:

```js
test('applyApprovedUpdate falls back to legacy suggestions.json when retrospective is absent', async () => {
  // keep existing suggestions fixture body
});
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
npm test -- test/apply-approved-update.test.js
```

Expected: retrospective apply test fails because apply still requires `suggestions.json`.

- [ ] **Step 4: Add update-action reader**

In `src/apply-approved-update.js`, import:

```js
import { extractKnowledgeActions } from './core/retrospective-schema.js';
```

Replace the direct `suggestions` read with:

```js
  const updateActions = await readApprovedActionCandidates(paths);
```

Add:

```js
async function readApprovedActionCandidates(paths) {
  try {
    const retrospective = await readJson(paths.retrospectivePath, 'retrospective.json is required');
    const actions = extractKnowledgeActions(retrospective).map(findingToSuggestion);
    if (!Array.isArray(actions)) {
      throw new Error('retrospective.json must include retrospective findings');
    }
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

function findingToSuggestion(finding) {
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
```

Update the unknown-id checks to use `updateActions`:

```js
  const suggestionIds = new Set(updateActions.map((suggestion) => suggestion.id));
```

Update `toApply`:

```js
  const toApply = updateActions
    .filter((suggestion) => approvedIds.has(suggestion.id))
    .map((suggestion) => validateApprovedSuggestion({ root: rootPath, suggestion }));
```

- [ ] **Step 5: Run task tests**

Run:

```bash
npm test -- test/apply-approved-update.test.js
```

Expected: pass.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/apply-approved-update.js test/apply-approved-update.test.js
git commit -m "feat: apply retrospective knowledge actions"
```

---

### Task 6: Add Retrospective JSON Schema And Documentation

**Files:**
- Create: `schemas/retrospective.schema.json`
- Modify: `schemas/suggestion.schema.json`
- Modify: `README.md`
- Modify: `test/plugin-files.test.js`

- [ ] **Step 1: Write failing plugin-file test**

In `test/plugin-files.test.js`, add:

```js
test('retrospective schema is shipped with package files', async () => {
  const schema = JSON.parse(await fs.readFile(path.join(repoRoot, 'schemas', 'retrospective.schema.json'), 'utf8'));

  assert.equal(schema.title, 'Evo Bypass Task Retrospective');
  assert.equal(schema.properties.retrospective.properties.findings.items.properties.action.properties.type.enum.includes('update_knowledge'), true);
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npm test -- test/plugin-files.test.js
```

Expected: fail because `schemas/retrospective.schema.json` does not exist.

- [ ] **Step 3: Create retrospective schema**

Create `schemas/retrospective.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Evo Bypass Task Retrospective",
  "type": "object",
  "required": ["session_id", "summary", "retrospective"],
  "properties": {
    "session_id": { "type": "string" },
    "summary": { "type": "string" },
    "retrospective": {
      "type": "object",
      "required": ["outcome", "quality", "findings"],
      "properties": {
        "outcome": { "enum": ["completed", "partial", "failed", "unknown"] },
        "quality": { "enum": ["smooth", "minor_issues", "significant_issues"] },
        "findings": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["id", "category", "severity", "evidence", "diagnosis", "recommendation", "action"],
            "properties": {
              "id": { "type": "string" },
              "category": { "enum": ["knowledge", "skill", "code", "agent_usage", "environment"] },
              "severity": { "enum": ["low", "medium", "high"] },
              "evidence": { "type": "array", "items": { "type": "string" } },
              "diagnosis": { "type": "string" },
              "recommendation": { "type": "string" },
              "action": {
                "type": "object",
                "required": ["type", "confidence"],
                "properties": {
                  "type": { "enum": ["update_knowledge", "create_skill", "improve_code", "adjust_agent_usage", "fix_environment", "no_action"] },
                  "confidence": { "enum": ["low", "medium", "high"] },
                  "target": { "type": "string" },
                  "target_reason": { "type": "string" },
                  "proposed_text": { "type": "string" },
                  "rationale": { "type": "string" }
                }
              }
            }
          }
        }
      }
    },
    "retrospective_report_path": { "type": "string" }
  }
}
```

- [ ] **Step 4: Mark suggestion schema as legacy**

Update the title in `schemas/suggestion.schema.json`:

```json
  "title": "Evo Bypass Legacy Knowledge Suggestion",
  "description": "Legacy schema for pre-retrospective sessions. New sessions use retrospective.schema.json.",
```

- [ ] **Step 5: Update README artifact and behavior sections**

Change the storage listing in `README.md`:

```text
.bypass/sessions/<session-id>/
  metadata.json          – session start time, workspace root, agent type
  events.jsonl           – redacted tool-use events collected during the task
  retrospective.json     – reviewer output: task status, findings, and actions
  retrospective.md       – readable task retrospective report
  approval.json          – user-approved update_knowledge action ids and approval message
  applied.patch          – diff of changes written by the updater
  reviewer.log           – full reviewer run log for debugging
```

Add a "Task Retrospectives" paragraph:

```md
## Task Retrospectives

Every Stop hook writes a task retrospective. The retrospective explains whether the task completed smoothly, which concrete failures or workflow issues appeared, and what action is recommended. Knowledge updates are represented as `update_knowledge` actions inside retrospective findings. Other actions, such as `create_skill`, `improve_code`, or `adjust_agent_usage`, are advisory and are not applied automatically.
```

Update old `suggestions.json` references to `retrospective.json` except where explicitly describing legacy fallback.

- [ ] **Step 6: Run task tests**

Run:

```bash
npm test -- test/plugin-files.test.js
```

Expected: pass.

- [ ] **Step 7: Commit**

Run:

```bash
git add schemas/retrospective.schema.json schemas/suggestion.schema.json README.md test/plugin-files.test.js
git commit -m "docs: document task retrospectives"
```

---

### Task 7: Full Regression And Cleanup

**Files:**
- Inspect: all modified files

- [ ] **Step 1: Run full test suite**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 2: Search for stale primary suggestion language**

Run:

```bash
rg -n "suggestions\\.json|suggestion_report_path|suggestions\\.length|Knowledge Update Suggestions|本次任务无待更新知识" src scripts test README.md prompts schemas
```

Expected: matches remain only for legacy fallback, old schema, or explicitly updated compatibility tests.

- [ ] **Step 3: Fix stale references if search reveals primary-model wording**

If the search finds new-code paths still treating `suggestions.json` as primary, replace them with retrospective terms. The acceptable remaining wording should look like:

```js
// Legacy fallback for sessions created before retrospective.json existed.
```

or README text that explicitly says legacy sessions may still have `suggestions.json`.

- [ ] **Step 4: Run full tests again**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Inspect final diff**

Run:

```bash
git status --short
git diff --stat
```

Expected: only intentional files are modified.

- [ ] **Step 6: Commit cleanup if needed**

If Step 3 changed files, run:

```bash
git add src scripts test README.md prompts schemas
git commit -m "chore: align retrospective terminology"
```

If Step 3 made no changes, do not create an empty commit.

---

## Implementation Notes

- Keep the legacy `approved_suggestion_ids` approval field for v1 to avoid changing the CLI/user confirmation shape in the same migration. The ids can refer to retrospective finding ids.
- Keep old `suggestions.json` readable in `apply-approved-update.js`, but do not write new primary `suggestions.json` files from `reviewSession()`.
- If existing viewer tests assume `suggestionCount`, update them only enough to pass `actionCount` while preserving backward compatibility.
- Prefer conservative rules findings. A quiet but reliable retrospective is better than a noisy report that users learn to ignore.
